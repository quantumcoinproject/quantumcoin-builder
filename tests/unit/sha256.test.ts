import { describe, it, expect } from "vitest";
import { createHash } from "../../src/shims/crypto";

// digest() is async (Web Crypto SubtleCrypto); there is no hand-rolled crypto.
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("crypto shim SHA-256 (Web Crypto)", () => {
  it("matches known vectors", async () => {
    expect(await hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hex("The quick brown fox jumps over the lazy dog")).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });

  it("handles block-boundary and multi-block input", async () => {
    // 55/56/64-byte boundaries around SHA-256's 512-bit block + length padding.
    expect(await hex("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    );
    expect(await hex("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
    expect(await hex("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
    expect(await hex("a".repeat(1000))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
  });

  it("returns raw bytes when no encoding is given", async () => {
    const bytes = (await createHash("sha256").update("abc").digest()) as Uint8Array;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it("rejects unsupported algorithms", async () => {
    await expect(createHash("md5").update("x").digest("hex")).rejects.toThrow(/not available/i);
  });
});
