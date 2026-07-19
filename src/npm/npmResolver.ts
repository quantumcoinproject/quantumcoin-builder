import type { Workspace } from "../files/workspace";
import {
  MAX_NPM_METADATA_BYTES,
  MAX_NPM_TARBALL_BYTES,
} from "../app/limits";
import {
  extractNpmImports,
  parseNpmSpecifier,
  satisfiesVersion,
  selectVersion,
  type NpmPackageSpec,
} from "./packageSpec";
import { extractNpmTar, gunzipLimited } from "./tar";

const REGISTRY = "https://registry.npmjs.org";
const OSV_QUERY = "https://api.osv.dev/v1/querybatch";

interface RegistryMetadata {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, RegistryVersion>;
}

interface RegistryVersion {
  name?: string;
  version?: string;
  dist?: {
    tarball?: string;
    integrity?: string;
    unpackedSize?: number;
  };
}

export interface DependencyAdvisory {
  id: string;
  summary: string;
  severity: string;
  url?: string;
}

export interface DependencyAudit {
  packageName: string;
  version: string;
  advisories: DependencyAdvisory[];
  unavailable?: string;
}

export interface DependencyProgress {
  packageName: string;
  version: string;
  phase: string;
  received?: number;
  total?: number;
}

export interface NpmResolverHooks {
  confirmRisk: (audit: DependencyAudit) => Promise<boolean>;
  progress: (status: DependencyProgress | null) => void;
  log?: (message: string, kind?: "info" | "success" | "warning" | "error") => void;
}

export class NpmInstallCancelled extends Error {
  constructor(message = "NPM dependency installation cancelled.") {
    super(message);
    this.name = "NpmInstallCancelled";
  }
}

/**
 * Remix-style npm import resolver. Metadata/audit are checked first; package
 * bytes are downloaded only after the audit gate has allowed the exact version.
 */
export class NpmResolver {
  private workspace: Workspace;
  private hooks: NpmResolverHooks;
  private active = new Map<string, Promise<void>>();

  constructor(workspace: Workspace, hooks: NpmResolverHooks) {
    this.workspace = workspace;
    this.hooks = hooks;
  }

  /** Resolve every bare npm import in the current workspace, including imports discovered in dependencies. */
  async ensureImports(sources: Record<string, string>): Promise<number> {
    const queue = collectSpecs(sources);
    let installed = 0;
    const seen = new Set<string>();
    while (queue.length) {
      const spec = queue.shift()!;
      const key = `${spec.name}@${spec.requested ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.isInstalled(spec)) continue;
      await this.installParsed(spec);
      installed++;
      for (const dependency of collectSpecs(this.workspace.allSources())) {
        if (!seen.has(`${dependency.name}@${dependency.requested ?? ""}`)) queue.push(dependency);
      }
    }
    return installed;
  }

  async install(specifier: string): Promise<void> {
    const spec = parseNpmSpecifier(specifier);
    if (!spec) throw new Error("Expected an npm package such as @openzeppelin/contracts@4.9.6.");
    await this.installParsed(spec);
    await this.ensureImports(this.workspace.allSources());
  }

  private isInstalled(spec: NpmPackageSpec): boolean {
    const installed = this.workspace.dependencyVersion(spec.name);
    if (!installed) return false;
    if (!spec.requested || spec.requested === "latest") return true;
    return installed === spec.requested || satisfiesVersion(installed, spec.requested);
  }

  private installParsed(spec: NpmPackageSpec): Promise<void> {
    const key = `${spec.name}@${spec.requested ?? "latest"}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    const task = this.performInstall(spec).finally(() => this.active.delete(key));
    this.active.set(key, task);
    return task;
  }

  private async performInstall(spec: NpmPackageSpec): Promise<void> {
    this.hooks.progress({
      packageName: spec.name,
      version: spec.requested ?? "latest",
      phase: "Resolving package metadata…",
    });
    try {
      const metadata = await fetchJson<RegistryMetadata>(
        `${REGISTRY}/${encodeURIComponent(spec.name)}`,
        { headers: { Accept: "application/vnd.npm.install-v1+json" } },
        MAX_NPM_METADATA_BYTES,
      );
      const versions = metadata.versions ?? {};
      const version = selectVersion(Object.keys(versions), spec.requested, metadata["dist-tags"]);
      if (!version || !versions[version]) {
        throw new Error(`No published version of ${spec.name} matches ${spec.requested ?? "latest"}.`);
      }
      if (this.workspace.dependencyVersion(spec.name) === version) return;
      const manifest = versions[version]!;

      this.hooks.progress({ packageName: spec.name, version, phase: "Checking vulnerabilities…" });
      const audit = await auditPackage(spec.name, version);
      if (audit.unavailable || audit.advisories.length) {
        this.hooks.progress(null);
        const allowed = await this.hooks.confirmRisk(audit);
        if (!allowed) throw new NpmInstallCancelled(`Installation of ${spec.name}@${version} was declined.`);
      }

      const tarball = manifest.dist?.tarball;
      if (!tarball) throw new Error(`Registry metadata for ${spec.name}@${version} has no tarball.`);
      assertRegistryTarball(tarball);
      this.hooks.progress({ packageName: spec.name, version, phase: "Downloading package…", received: 0 });
      const compressed = await downloadBytes(tarball, MAX_NPM_TARBALL_BYTES, (received, total) => {
        this.hooks.progress({ packageName: spec.name, version, phase: "Downloading package…", received, total });
      });
      await verifyIntegrity(compressed, manifest.dist?.integrity);

      this.hooks.progress({ packageName: spec.name, version, phase: "Extracting Solidity sources…" });
      const unpacked = await gunzipLimited(compressed);
      const files = extractNpmTar(unpacked);
      if (!files.some((f) => f.path.toLowerCase().endsWith(".sol"))) {
        throw new Error(`${spec.name}@${version} contains no Solidity source files.`);
      }
      this.workspace.installDependency(spec.name, version, files);
      this.hooks.log?.(`Installed ${spec.name}@${version} (${files.length} cached file(s))`, "success");
    } finally {
      this.hooks.progress(null);
    }
  }
}

function collectSpecs(sources: Record<string, string>): NpmPackageSpec[] {
  const result = new Map<string, NpmPackageSpec>();
  for (const source of Object.values(sources)) {
    for (const spec of extractNpmImports(source)) {
      result.set(`${spec.name}@${spec.requested ?? ""}`, spec);
    }
  }
  return [...result.values()];
}

async function auditPackage(packageName: string, version: string): Promise<DependencyAudit> {
  try {
    const response = await fetchJson<{
      results?: { vulns?: Array<Record<string, unknown>> }[];
    }>(
      OSV_QUERY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: [{ package: { ecosystem: "npm", name: packageName }, version }],
        }),
      },
      MAX_NPM_METADATA_BYTES,
    );
    const vulns = response.results?.[0]?.vulns ?? [];
    return {
      packageName,
      version,
      advisories: vulns.map((v) => ({
        id: text(v.id) || "unknown",
        summary: text(v.summary) || text(v.details) || "Known vulnerability",
        severity: osvSeverity(v),
        url: advisoryUrl(v),
      })),
    };
  } catch (err) {
    return {
      packageName,
      version,
      advisories: [],
      unavailable: err instanceof Error ? err.message : String(err),
    };
  }
}

function osvSeverity(v: Record<string, unknown>): string {
  const db = v.database_specific;
  if (db && typeof db === "object") {
    const severity = (db as Record<string, unknown>).severity;
    if (typeof severity === "string" && severity) return severity.toLowerCase();
  }
  return "unknown";
}

function advisoryUrl(v: Record<string, unknown>): string | undefined {
  const refs = Array.isArray(v.references) ? v.references : [];
  for (const ref of refs) {
    if (ref && typeof ref === "object" && typeof (ref as Record<string, unknown>).url === "string") {
      return (ref as Record<string, unknown>).url as string;
    }
  }
  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function fetchJson<T>(url: string, init: RequestInit, maxBytes: number): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Request failed (${response.status} ${response.statusText}).`);
  const bytes = await readResponseLimited(response, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error("Service returned malformed JSON.");
  }
}

async function downloadBytes(
  url: string,
  maxBytes: number,
  onProgress: (received: number, total?: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Package download failed (${response.status} ${response.statusText}).`);
  const totalHeader = Number(response.headers.get("content-length"));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
  if (total && total > maxBytes) throw new Error("Package tarball exceeds the download safety limit.");
  return readResponseLimited(response, maxBytes, (received) => onProgress(received, total));
}

async function readResponseLimited(
  response: Response,
  maxBytes: number,
  onProgress?: (received: number) => void,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Response exceeds the safety limit.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Response exceeds the safety limit.");
    }
    chunks.push(value);
    onProgress?.(total);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function assertRegistryTarball(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Registry returned an invalid package URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    throw new Error("Registry returned a package URL outside registry.npmjs.org.");
  }
}

async function verifyIntegrity(bytes: Uint8Array, integrity?: string): Promise<void> {
  if (!integrity) throw new Error("Registry metadata did not provide package integrity.");
  const sha512 = integrity.split(/\s+/).find((part) => part.startsWith("sha512-"));
  if (!sha512) throw new Error("Registry metadata did not provide SHA-512 integrity.");
  const expected = sha512.slice("sha512-".length);
  const digest = await crypto.subtle.digest("SHA-512", bytes.buffer as ArrayBuffer);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  if (btoa(binary) !== expected) throw new Error("Package integrity verification failed.");
}
