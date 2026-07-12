/*
 * Minimal browser shim for Node's `crypto`, scoped to what `quantumcoin` and
 * `quantum-coin-js-sdk` touch in the browser (Mini self-containment policy — no
 * third-party dependency):
 *
 *  - getHashes(): []      -> routes the SDK's keccak256 through its bundled pure-JS
 *                            Keccak (used for ABI function selectors / event topics).
 *  - createHash('sha256') -> platform Web Crypto SubtleCrypto digest (async).
 *  - randomBytes()        -> Web Crypto CSPRNG.
 *
 * There is NO hand-rolled cryptography in this build: hashing is delegated to the
 * browser's audited `crypto.subtle` implementation and randomness to
 * `crypto.getRandomValues` (QCB-006/QCB-007).
 *
 * Other Node-crypto APIs (HMAC, pbkdf2, scrypt) are wallet/key paths Mini never
 * exercises and throw a clear error if called.
 */

export function getHashes(): string[] {
  return [];
}

// Per the Web Crypto spec, getRandomValues throws QuotaExceededError for
// byteLength > 65536, so fill in <=65536-byte chunks to support larger requests
// (QCB-007).
const MAX_RANDOM_CHUNK = 65536;

export function randomBytes(size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 0) {
    throw new Error("randomBytes: size must be a non-negative integer");
  }
  const out = new Uint8Array(size);
  for (let off = 0; off < size; off += MAX_RANDOM_CHUNK) {
    const chunk = out.subarray(off, Math.min(off + MAX_RANDOM_CHUNK, size));
    globalThis.crypto.getRandomValues(chunk);
  }
  return out;
}

// ---- SHA-2 via Web Crypto (SubtleCrypto) ----

// Map Node-style algorithm names to Web Crypto identifiers. Only the SHA-2
// family SubtleCrypto supports is exposed; anything else is rejected explicitly.
const SUBTLE_ALGO: Record<string, string> = {
  sha1: "SHA-1",
  "sha-1": "SHA-1",
  sha256: "SHA-256",
  "sha-256": "SHA-256",
  sha384: "SHA-384",
  "sha-384": "SHA-384",
  sha512: "SHA-512",
  "sha-512": "SHA-512",
};

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new globalThis.TextEncoder().encode(data);
  if (data && typeof (data as ArrayBufferView).byteLength === "number") {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  throw new Error("Unsupported data for hashing");
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

/**
 * Node-`crypto`-shaped incremental hash backed by the browser's SubtleCrypto.
 *
 * NOTE: `crypto.subtle.digest` is asynchronous, so `digest()` returns a Promise
 * (unlike Node's synchronous `Hash.digest`). Nothing in the app or the SDK calls
 * this synchronously — the SDK's own hashing goes through `quantum-coin-js-sdk`
 * and `wasm_exec.js` only uses `crypto.getRandomValues` — so the async surface is
 * the deliberate, correct trade-off for removing hand-rolled crypto.
 */
class Hash {
  private algo: string;
  private chunks: Uint8Array[] = [];
  constructor(algo: string) {
    this.algo = algo.toLowerCase();
  }
  update(data: unknown): this {
    this.chunks.push(toBytes(data));
    return this;
  }
  private merged(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      merged.set(c, o);
      o += c.length;
    }
    return merged;
  }
  async digest(encoding?: string): Promise<Uint8Array | string> {
    const name = SUBTLE_ALGO[this.algo];
    if (!name) {
      throw new Error(`crypto digest '${this.algo}' is not available in the browser build`);
    }
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error("Web Crypto SubtleCrypto is not available in this environment");
    }
    // `merged()` returns a fresh, full-length view, so its backing buffer is
    // exactly the bytes to hash. Cast narrows ArrayBufferLike -> ArrayBuffer for
    // SubtleCrypto's BufferSource (it is never a SharedArrayBuffer here).
    const input = this.merged().buffer as ArrayBuffer;
    const buf = await subtle.digest(name, input);
    const bytes = new Uint8Array(buf);
    return encoding === "hex" ? toHex(bytes) : bytes;
  }
}

export function createHash(algo: string): Hash {
  return new Hash(algo);
}

function unsupported(name: string): never {
  throw new Error(
    `crypto.${name} is not available in the browser build (wallet/key paths Mini does not exercise)`,
  );
}
export function createHmac(): never {
  return unsupported("createHmac");
}
export function pbkdf2Sync(): never {
  return unsupported("pbkdf2Sync");
}
export function scrypt(): never {
  return unsupported("scrypt");
}
export function scryptSync(): never {
  return unsupported("scryptSync");
}

export default { getHashes, randomBytes, createHash, createHmac, pbkdf2Sync, scrypt, scryptSync };
