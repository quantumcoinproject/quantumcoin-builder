/*
 * First-party ZIP builder (Mini §8.2) — STORE method (no compression), which
 * produces a valid, universally-readable archive with zero npm dependencies
 * (no jszip / file-saver). Sufficient for small text artifacts.
 */

import { MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES } from "../app/limits";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

export function textEntry(name: string, content: string): ZipEntry {
  return { name, data: enc.encode(content) };
}

/** Build a STORE-method ZIP archive as a Blob. */
export function createZip(entries: ZipEntry[]): Blob {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  // DOS time/date — fixed (1980-01-01); deterministic output.
  const dosTime = 0;
  const dosDate = 0x21; // 1980-01-01

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central dir signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length

  const parts = [...chunks, ...central, eocd] as unknown as BlobPart[];
  return new Blob(parts, { type: "application/zip" });
}

export interface ReadEntry {
  name: string;
  text: string;
}

const dec = new TextDecoder();

/**
 * Raw DEFLATE decompression with a hard output cap. Reads the stream chunk by
 * chunk and aborts as soon as the decompressed size would exceed `maxBytes`, so
 * a high-ratio "zip bomb" never fully materializes in memory.
 */
async function inflateRawCapped(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("ZIP entry too large when decompressed");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Read a ZIP archive (STORE + DEFLATE) — used for "Import from Zip" (Mini §4.1).
 *
 * Hardened against malformed archives and decompression bombs: all offsets are
 * bounds-checked against the buffer, the entry count is clamped, and per-entry
 * and total uncompressed sizes are capped. */
export async function readZip(blob: Blob): Promise<ReadEntry[]> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = buf.length;

  // Bounds-safe little-endian readers.
  const u16 = (o: number): number => {
    if (o < 0 || o + 2 > len) throw new Error("Corrupt ZIP: read past end of file");
    return dv.getUint16(o, true);
  };
  const u32 = (o: number): number => {
    if (o < 0 || o + 4 > len) throw new Error("Corrupt ZIP: read past end of file");
    return dv.getUint32(o, true);
  };

  // Locate End Of Central Directory record.
  let eocd = -1;
  for (let i = len - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid ZIP file");

  const rawCount = u16(eocd + 10);
  const count = Math.min(rawCount, MAX_ZIP_ENTRIES);
  let ptr = u32(eocd + 16);
  const entries: ReadEntry[] = [];
  let totalBytes = 0;

  for (let n = 0; n < count; n++) {
    if (ptr < 0 || ptr + 46 > len) break;
    if (u32(ptr) !== 0x02014b50) break;
    const method = u16(ptr + 10);
    const compSize = u32(ptr + 20);
    const nameLen = u16(ptr + 28);
    const extraLen = u16(ptr + 30);
    const commentLen = u16(ptr + 32);
    const localOffset = u32(ptr + 42);
    if (ptr + 46 + nameLen > len) break;
    const name = dec.decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));

    // Reject implausibly large compressed regions before touching the data.
    if (compSize > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(`ZIP entry "${name}" exceeds the ${MAX_ZIP_ENTRY_BYTES}-byte limit`);
    }

    // Local header to find the actual data start.
    const lNameLen = u16(localOffset + 26);
    const lExtraLen = u16(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart < 0 || dataStart + compSize > len) throw new Error("Corrupt ZIP: entry data out of range");
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (!name.endsWith("/")) {
      let bytes: Uint8Array;
      if (method === 0) {
        if (raw.length > MAX_ZIP_ENTRY_BYTES) throw new Error(`ZIP entry "${name}" too large`);
        bytes = raw;
      } else if (method === 8) {
        bytes = await inflateRawCapped(raw, MAX_ZIP_ENTRY_BYTES);
      } else {
        throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
        throw new Error(`ZIP total uncompressed size exceeds the ${MAX_ZIP_TOTAL_BYTES}-byte limit`);
      }
      entries.push({ name, text: dec.decode(bytes) });
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
