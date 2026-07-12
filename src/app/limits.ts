// Centralized input/output limits and sanitization helpers (defense in depth).
//
// Everything that crosses a trust boundary — imported files, zip archives,
// folder/file names, on-chain return data, wallet/network-supplied strings, and
// pasted text — is treated as hostile. These caps and helpers are the single
// place to tune that policy.

// ---- Size / count caps ----
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // single imported .sol file
export const MAX_SOURCE_CHARS = 1 * 1024 * 1024; // decoded source length per file
export const MAX_ZIP_ENTRIES = 500; // archive entry count
export const MAX_ZIP_ENTRY_BYTES = 5 * 1024 * 1024; // per-entry uncompressed cap
export const MAX_ZIP_TOTAL_BYTES = 25 * 1024 * 1024; // archive + total-uncompressed cap
export const MAX_PATH_LEN = 200; // normalized path length
export const MAX_PATH_DEPTH = 12; // folder nesting depth

// ---- Paste warning thresholds ----
export const PASTE_WARN_CHARS = 5000;
export const PASTE_WARN_LINES = 200;

// ---- Display caps ----
export const MAX_OUTPUT_CHARS = 20000; // truncate rendered read results

// ---- Sanitization / validation helpers ----

/** Escape for safe interpolation into an HTML attribute (quotes included). */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape for safe interpolation into HTML element text content. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strict 0x-prefixed hex string (any length, even nibble count). */
export function isHexData(s: string): boolean {
  return /^0x([0-9a-fA-F]{2})*$/.test(s);
}

/** Transaction-hash / address-like token: 0x followed only by hex digits. */
export function isTxHashLike(s: string): boolean {
  return /^0x[0-9a-fA-F]{1,80}$/.test(s);
}

/** Truncate a string to `max` chars, appending a visible notice when clipped. */
export function truncateWithNotice(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  const omitted = s.length - max;
  return `${s.slice(0, max)}\n\u2026 [truncated ${omitted.toLocaleString()} more character(s)]`;
}

/** Count 20-byte address literals in arbitrary text (for paste warnings). */
export function countAddresses(text: string): number {
  const m = text.match(/0x[0-9a-fA-F]{40}\b/g);
  return m ? m.length : 0;
}
