import {
  MAX_NPM_FILES,
  MAX_NPM_UNPACKED_BYTES,
  MAX_SOURCE_CHARS,
} from "../app/limits";

export interface NpmTarFile {
  path: string;
  content: string;
}

/** Decompress a gzip byte stream while enforcing an expanded-size cap. */
export async function gunzipLimited(
  compressed: Uint8Array,
  maxBytes = MAX_NPM_UNPACKED_BYTES,
): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser does not support gzip decompression (DecompressionStream).");
  }
  const stream = new Blob([compressed as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Package expands beyond the ${formatBytes(maxBytes)} safety limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Extract Solidity sources and package.json from an npm tar archive. npm
 * tarballs use a top-level `package/` directory; traversal and special entries
 * are rejected/ignored before any path reaches workspace storage.
 */
export function extractNpmTar(
  tar: Uint8Array,
  maxFiles = MAX_NPM_FILES,
): NpmTarFile[] {
  const files: NpmTarFile[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;

  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const type = String.fromCharCode(header[156] || 48);
    const sizeText = readString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Malformed npm tar entry size.");
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.byteLength) throw new Error("Truncated npm tar archive.");

    const full = (prefix ? `${prefix}/${name}` : name).replace(/\\/g, "/");
    const relative = full.startsWith("package/") ? full.slice("package/".length) : full;
    if (type === "0" || type === "\0") {
      const safe = safeRelativePath(relative);
      if (safe && (safe.toLowerCase().endsWith(".sol") || safe === "package.json")) {
        if (files.length >= maxFiles) throw new Error(`Package contains more than ${maxFiles} importable files.`);
        if (size > MAX_SOURCE_CHARS) throw new Error(`${safe} exceeds the per-file source limit.`);
        files.push({ path: safe, content: decoder.decode(tar.subarray(bodyStart, bodyEnd)) });
      }
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readString(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const zero = slice.indexOf(0);
  return new TextDecoder().decode(zero >= 0 ? slice.subarray(0, zero) : slice);
}

function safeRelativePath(raw: string): string | null {
  const value = raw.replace(/^\.\/+/, "").replace(/\/+/g, "/");
  if (!value || value.startsWith("/") || value.includes("\0")) return null;
  const parts = value.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  return value;
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.round(n / 1024)} KB`;
}
