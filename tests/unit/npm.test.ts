import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractNpmImports,
  parseNpmSpecifier,
  satisfiesVersion,
  selectVersion,
} from "../../src/npm/packageSpec";
import { extractNpmTar } from "../../src/npm/tar";
import { NpmInstallCancelled, NpmResolver } from "../../src/npm/npmResolver";
import { Workspace } from "../../src/files/workspace";

class MemoryStorage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
}

describe("npm package specifier parsing", () => {
  it("parses scoped package imports with versions and subpaths", () => {
    expect(parseNpmSpecifier("@openzeppelin/contracts@4.9.6/token/ERC20/ERC20.sol")).toEqual({
      name: "@openzeppelin/contracts",
      requested: "4.9.6",
      subpath: "token/ERC20/ERC20.sol",
    });
  });

  it("extracts Solidity import forms and ignores relative imports", () => {
    const source = `
      import "@scope/pkg/contracts/A.sol";
      import { B } from "plain-pkg/src/B.sol";
      import "./Local.sol";
    `;
    expect(extractNpmImports(source).map((x) => x.name)).toEqual(["@scope/pkg", "plain-pkg"]);
  });

  it("selects compatible semver ranges", () => {
    const versions = ["3.4.0", "4.8.3", "4.9.6", "5.0.0"];
    expect(selectVersion(versions, "^4.8.0")).toBe("4.9.6");
    expect(selectVersion(versions, "~4.8.0")).toBe("4.8.3");
    expect(satisfiesVersion("4.9.6", ">=4.8.0 <5.0.0")).toBe(true);
  });
});

describe("npm tar hardening", () => {
  it("extracts only safe Solidity/package metadata files", () => {
    const tar = makeTar([
      ["package/contracts/A.sol", "contract A {}"],
      ["package/package.json", '{"name":"pkg"}'],
      ["package/README.md", "ignored"],
      ["package/../escape.sol", "ignored"],
    ]);
    expect(extractNpmTar(tar)).toEqual([
      { path: "contracts/A.sol", content: "contract A {}" },
      { path: "package.json", content: '{"name":"pkg"}' },
    ]);
  });
});

describe("npm dependency resolver", () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
  });

  it("audits before download, verifies and caches package sources with remappings", async () => {
    const compressed = await gzip(makeTar([
      ["package/contracts/Dep.sol", "pragma solidity 0.7.6; library Dep {}"],
      ["package/package.json", '{"name":"@test/dep","version":"1.2.3"}'],
    ]));
    const integrity = `sha512-${await sha512Base64(compressed)}`;
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.osv.dev")) return jsonResponse({ results: [{}] });
      if (url.endsWith(".tgz")) {
        return new Response(compressed as BodyInit, {
          status: 200,
          headers: { "content-length": String(compressed.byteLength) },
        });
      }
      return jsonResponse({
        "dist-tags": { latest: "1.2.3" },
        versions: {
          "1.2.3": {
            version: "1.2.3",
            dist: {
              tarball: "https://registry.npmjs.org/@test/dep/-/dep-1.2.3.tgz",
              integrity,
            },
          },
        },
      });
    }) as typeof fetch;

    try {
      const workspace = new Workspace();
      const path = workspace.create("UseDep.sol");
      workspace.write(path, 'pragma solidity 0.7.6; import "@test/dep/contracts/Dep.sol";');
      const resolver = new NpmResolver(workspace, {
        confirmRisk: async () => false,
        progress: () => undefined,
      });
      expect(await resolver.ensureImports(workspace.allSources())).toBe(1);
      expect(calls.findIndex((u) => u.includes("api.osv.dev"))).toBeLessThan(
        calls.findIndex((u) => u.endsWith(".tgz")),
      );
      expect(workspace.dependencyVersion("@test/dep")).toBe("1.2.3");
      expect(workspace.allSources()[".deps/npm/@test/dep@1.2.3/contracts/Dep.sol"]).toContain("library Dep");
      expect(workspace.dependencyRemappings()).toContain(
        "@test/dep/=.deps/npm/@test/dep@1.2.3/",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("defaults to No and never downloads when an advisory is declined", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("api.osv.dev")) {
        return jsonResponse({ results: [{ vulns: [{ id: "GHSA-test", summary: "test issue" }] }] });
      }
      return jsonResponse({
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            dist: {
              tarball: "https://registry.npmjs.org/risky/-/risky-1.0.0.tgz",
              integrity: "sha512-unused",
            },
          },
        },
      });
    }) as typeof fetch;
    try {
      const workspace = new Workspace();
      const resolver = new NpmResolver(workspace, {
        confirmRisk: async () => false,
        progress: () => undefined,
      });
      await expect(resolver.install("risky")).rejects.toBeInstanceOf(NpmInstallCancelled);
      expect(urls.some((u) => u.endsWith(".tgz"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeTar(entries: Array<[string, string]>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, content] of entries) {
    const body = encoder.encode(content);
    const header = new Uint8Array(512);
    header.set(encoder.encode(name).subarray(0, 100), 0);
    header.set(encoder.encode(body.length.toString(8).padStart(11, "0") + "\0"), 124);
    header[156] = "0".charCodeAt(0);
    chunks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const length = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha512Base64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", bytes.buffer as ArrayBuffer);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
