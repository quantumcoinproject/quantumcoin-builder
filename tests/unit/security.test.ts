import { describe, it, expect, beforeEach } from "vitest";
import {
  escapeAttr,
  isTxHashLike,
  isHexData,
  truncateWithNotice,
  countAddresses,
  MAX_ZIP_ENTRY_BYTES,
} from "../../src/app/limits";
import { createZip, readZip } from "../../src/export/zip";
import { Workspace } from "../../src/files/workspace";

// ---- Sanitization / validation helpers ----

describe("limits helpers", () => {
  it("escapeAttr neutralizes attribute-breaking characters", () => {
    const out = escapeAttr(`" onerror='x' <b>&`);
    expect(out).not.toContain('"');
    expect(out).not.toContain("'");
    expect(out).not.toContain("<");
    expect(out).toContain("&quot;");
    expect(out).toContain("&#39;");
    expect(out).toContain("&amp;");
  });

  it("isTxHashLike accepts only 0x hex tokens", () => {
    expect(isTxHashLike("0x" + "a".repeat(64))).toBe(true);
    expect(isTxHashLike("0xABCDEF")).toBe(true);
    expect(isTxHashLike("0x")).toBe(false);
    expect(isTxHashLike("0xZZ")).toBe(false);
    expect(isTxHashLike("javascript:alert(1)")).toBe(false);
    expect(isTxHashLike('0xab" onmouseover="evil')).toBe(false);
  });

  it("isHexData requires an even nibble count", () => {
    expect(isHexData("0xdeadbeef")).toBe(true);
    expect(isHexData("0x")).toBe(true);
    expect(isHexData("0xabc")).toBe(false);
    expect(isHexData("deadbeef")).toBe(false);
  });

  it("truncateWithNotice clips oversized output with a notice", () => {
    const long = "a".repeat(100);
    const out = truncateWithNotice(long, 10);
    expect(out.startsWith("a".repeat(10))).toBe(true);
    expect(out).toContain("truncated");
    const short = "hello";
    expect(truncateWithNotice(short, 10)).toBe("hello");
  });

  it("countAddresses finds 20-byte address literals", () => {
    const a = "0x" + "1".repeat(40);
    const b = "0x" + "2".repeat(40);
    expect(countAddresses(`send to ${a} and ${b}`)).toBe(2);
    expect(countAddresses("no addresses here")).toBe(0);
  });
});

// ---- Zip hardening ----

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Build a single-entry DEFLATE zip by hand (createZip only emits STORE).
async function makeDeflateZip(name: string, original: Uint8Array): Promise<Blob> {
  const comp = await deflateRaw(original);
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);

  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 8, true); // method: deflate
  lv.setUint16(12, 0x21, true);
  lv.setUint32(18, comp.length, true);
  lv.setUint32(22, original.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);

  const cd = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(10, 8, true); // method: deflate
  cv.setUint16(14, 0x21, true);
  cv.setUint32(20, comp.length, true);
  cv.setUint32(24, original.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true); // local header offset
  cd.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, local.length + comp.length, true);

  return new Blob([local, comp, cd, eocd] as unknown as BlobPart[], { type: "application/zip" });
}

describe("zip hardening (defense in depth)", () => {
  it("round-trips a small DEFLATE entry", async () => {
    const text = "contract A { }\n".repeat(50);
    const zip = await makeDeflateZip("A.sol", new TextEncoder().encode(text));
    const entries = await readZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("A.sol");
    expect(entries[0]!.text).toBe(text);
  });

  it("rejects a malformed archive (no EOCD)", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4]) as unknown as BlobPart]);
    await expect(readZip(blob)).rejects.toThrow(/valid ZIP/i);
  });

  it("rejects an oversized STORE entry before reading it", async () => {
    const big = new Uint8Array(MAX_ZIP_ENTRY_BYTES + 1024);
    const blob = createZip([{ name: "big.sol", data: big }]);
    await expect(readZip(blob)).rejects.toThrow(/exceeds|too large/i);
  });

  it("aborts a decompression bomb that exceeds the per-entry cap", async () => {
    // Highly compressible payload larger than the cap: tiny compressed, huge inflated.
    const bomb = new Uint8Array(MAX_ZIP_ENTRY_BYTES + 1024 * 1024); // zeros
    const zip = await makeDeflateZip("bomb.sol", bomb);
    await expect(readZip(zip)).rejects.toThrow(/too large/i);
  });
});

// ---- Path / name sanitization (via the Workspace public API) ----

class MemoryStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}

describe("workspace path sanitization", () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
  });

  it("strips traversal (..) segments from new files", () => {
    const ws = new Workspace();
    const p = ws.create("../../etc/passwd.sol");
    expect(p).not.toContain("..");
    expect(p).toBe("etc/passwd.sol");
  });

  it("removes control characters and reserved characters", () => {
    const ws = new Workspace();
    const p = ws.create("a\u0000b<c>:d.sol");
    expect(p).toBe("abcd.sol");
  });

  it("caps folder nesting depth", () => {
    const ws = new Workspace();
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join("/") + "/File.sol";
    const p = ws.create(deep);
    expect(p.split("/").length).toBeLessThanOrEqual(12);
    expect(p).not.toContain("..");
  });

  it("rejects a folder made only of traversal segments", () => {
    const ws = new Workspace();
    expect(ws.createFolder("../..")).toBe("");
  });

  it("defaults a .sol extension for extensionless names", () => {
    const ws = new Workspace();
    const p = ws.create("MyContract");
    expect(p).toBe("MyContract.sol");
  });

  it("rejects reserved segment names to avoid prototype pollution (QCB-005)", () => {
    const ws = new Workspace();
    const p = ws.create("__proto__/constructor/prototype/Evil.sol");
    expect(p).toBe("Evil.sol");
    // The prototype of the sources map must be untouched by a crafted name.
    ws.write(p, "contract Evil {}");
    const sources = ws.allSources();
    expect(Object.getPrototypeOf(sources)).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("zip import into workspace", () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
  });

  it("suffixes _1/_2 instead of overwriting existing files (import into current)", () => {
    const ws = new Workspace();
    ws.create("Token.sol");
    ws.write("Token.sol", "original");

    const p1 = ws.importFileUnique("Token.sol", "first");
    const p2 = ws.importFileUnique("Token.sol", "second");

    expect(p1).toBe("Token_1.sol");
    expect(p2).toBe("Token_2.sol");
    // The pre-existing file is never clobbered.
    expect(ws.read("Token.sol")).toBe("original");
    expect(ws.read("Token_1.sol")).toBe("first");
    expect(ws.read("Token_2.sol")).toBe("second");
  });

  it("preserves nested paths and folders when suffixing", () => {
    const ws = new Workspace();
    const first = ws.importFileUnique("contracts/A.sol", "a1");
    const second = ws.importFileUnique("contracts/A.sol", "a2");
    expect(first).toBe("contracts/A.sol");
    expect(second).toBe("contracts/A_1.sol");
    expect(ws.listFolders()).toContain("contracts");
  });

  it("creates a new workspace populated with the imported files", () => {
    const ws = new Workspace();
    const before = ws.activeWorkspaceId();
    const { meta, paths } = ws.createWorkspaceFromFiles("MyZip", [
      { name: "A.sol", content: "a" },
      { name: "sub/B.sol", content: "b" },
      { name: "A.sol", content: "dup" },
    ]);

    expect(meta.id).not.toBe(before);
    expect(ws.activeWorkspaceId()).toBe(meta.id);
    expect(paths).toEqual(["A.sol", "sub/B.sol", "A_1.sol"]);
    expect(ws.list().sort()).toEqual(["A.sol", "A_1.sol", "sub/B.sol"]);
    expect(ws.read("A.sol")).toBe("a");
    expect(ws.read("A_1.sol")).toBe("dup");
    expect(ws.getActive()).toBe("A.sol");
  });
});

// ---- CSPRNG randomBytes chunking (QCB-007) ----

describe("randomBytes chunking", () => {
  it("fills more than 65536 bytes without throwing", async () => {
    const { randomBytes } = await import("../../src/shims/crypto");
    const n = 65536 * 2 + 123;
    const out = randomBytes(n);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(n);
    // Sanity: output is not all-zero (fill actually ran across chunks).
    expect(out.some((b) => b !== 0)).toBe(true);
  });

  it("rejects invalid sizes", async () => {
    const { randomBytes } = await import("../../src/shims/crypto");
    expect(() => randomBytes(-1)).toThrow();
    expect(() => randomBytes(1.5)).toThrow();
  });
});
