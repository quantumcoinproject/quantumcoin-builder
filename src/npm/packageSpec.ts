export interface NpmPackageSpec {
  name: string;
  requested?: string;
  subpath?: string;
}

const NAME_PART = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Parse npm package names and Solidity npm import paths, including scoped names:
 *   @openzeppelin/contracts
 *   @openzeppelin/contracts@4.9.6/token/ERC20/ERC20.sol
 *   solidity-linked-list/contracts/StructuredLinkedList.sol
 */
export function parseNpmSpecifier(raw: string): NpmPackageSpec | null {
  const value = raw.trim().replace(/\\/g, "/");
  if (!value || value.startsWith(".") || value.startsWith("/") || /^[a-z]+:/i.test(value)) {
    return null;
  }

  if (value.startsWith("@")) {
    const parts = value.split("/");
    if (parts.length < 2 || !/^@[a-z0-9][a-z0-9._-]*$/i.test(parts[0]!)) return null;
    const second = splitNameVersion(parts[1]!);
    if (!second || !NAME_PART.test(second.name)) return null;
    return {
      name: `${parts[0]}/${second.name}`,
      requested: second.version,
      subpath: parts.slice(2).join("/") || undefined,
    };
  }

  const parts = value.split("/");
  const first = splitNameVersion(parts[0]!);
  if (!first || !NAME_PART.test(first.name)) return null;
  return {
    name: first.name,
    requested: first.version,
    subpath: parts.slice(1).join("/") || undefined,
  };
}

function splitNameVersion(segment: string): { name: string; version?: string } | null {
  const at = segment.lastIndexOf("@");
  if (at <= 0) return segment ? { name: segment } : null;
  const name = segment.slice(0, at);
  const version = segment.slice(at + 1);
  return name && version ? { name, version } : null;
}

/** Extract bare npm imports from Solidity source text. */
export function extractNpmImports(source: string): NpmPackageSpec[] {
  const found = new Map<string, NpmPackageSpec>();
  const re = /\bimport\s+(?:(?:[^"']*?)\s+from\s+)?["']([^"']+)["']\s*;/g;
  for (const match of source.matchAll(re)) {
    const spec = parseNpmSpecifier(match[1]!);
    if (spec) found.set(`${spec.name}@${spec.requested ?? ""}`, spec);
  }
  return [...found.values()];
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

function parseVersion(raw: string): SemVer | null {
  const m = raw.trim().replace(/^v/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    prerelease: m[4] ?? "",
  };
}

function compare(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function satisfiesComparator(version: SemVer, token: string): boolean {
  const t = token.trim();
  if (!t || t === "*" || /^x$/i.test(t)) return true;

  const op = t.match(/^(<=|>=|<|>|=|\^|~)?\s*(.*)$/);
  if (!op) return false;
  const kind = op[1] ?? "=";
  const raw = op[2]!;
  const wildcard = raw.match(/^(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  if (wildcard && [wildcard[1], wildcard[2], wildcard[3]].some((x) => x == null || /^(x|\*)$/i.test(x))) {
    if (!/^(x|\*)$/i.test(wildcard[1]!) && version.major !== Number(wildcard[1])) return false;
    if (wildcard[2] && !/^(x|\*)$/i.test(wildcard[2]) && version.minor !== Number(wildcard[2])) return false;
    if (wildcard[3] && !/^(x|\*)$/i.test(wildcard[3]) && version.patch !== Number(wildcard[3])) return false;
    return true;
  }

  const target = parseVersion(raw);
  if (!target) return false;
  const c = compare(version, target);
  if (kind === ">") return c > 0;
  if (kind === ">=") return c >= 0;
  if (kind === "<") return c < 0;
  if (kind === "<=") return c <= 0;
  if (kind === "^") {
    const upper =
      target.major > 0
        ? { ...target, major: target.major + 1, minor: 0, patch: 0, prerelease: "" }
        : target.minor > 0
          ? { ...target, minor: target.minor + 1, patch: 0, prerelease: "" }
          : { ...target, patch: target.patch + 1, prerelease: "" };
    return c >= 0 && compare(version, upper) < 0;
  }
  if (kind === "~") {
    const upper = { ...target, minor: target.minor + 1, patch: 0, prerelease: "" };
    return c >= 0 && compare(version, upper) < 0;
  }
  return c === 0;
}

export function satisfiesVersion(versionRaw: string, rangeRaw: string): boolean {
  const version = parseVersion(versionRaw);
  if (!version) return false;
  const range = rangeRaw.trim();
  if (!range || range === "*" || range.toLowerCase() === "latest") return !version.prerelease;
  return range.split("||").some((branch) => {
    const hyphen = branch.trim().match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) {
      return satisfiesComparator(version, `>=${hyphen[1]}`) && satisfiesComparator(version, `<=${hyphen[2]}`);
    }
    return branch.trim().split(/\s+/).every((token) => satisfiesComparator(version, token));
  });
}

/** Select the newest published version matching an npm range or dist-tag. */
export function selectVersion(
  versions: string[],
  requested: string | undefined,
  distTags: Record<string, string> = {},
): string | null {
  const req = requested?.trim() || "latest";
  if (distTags[req] && versions.includes(distTags[req]!)) return distTags[req]!;
  if (versions.includes(req)) return req;
  const matches = versions.filter((v) => satisfiesVersion(v, req));
  matches.sort((a, b) => compare(parseVersion(b)!, parseVersion(a)!));
  return matches[0] ?? null;
}
