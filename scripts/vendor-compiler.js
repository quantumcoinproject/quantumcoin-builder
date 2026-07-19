#!/usr/bin/env node
/**
 * vendor:compiler (Mini §6.1.1)
 *
 * Copies the pinned QuantumCoin Solidity 7.6 compiler (soljson.js) from the
 * `@quantumcoin/solc` npm package (a build-time devDependency) into
 * public/assets/compilers/soljson-v32b.8.12.js so it is served same-origin and
 * loaded by the compiler Web Worker via importScripts. The compiler ships inside
 * the package, so there is NO network access at build time and it is NEVER
 * fetched at runtime.
 *
 * If scripts/compiler-sha256.txt contains a real hash (not the placeholder), the
 * copied file is verified against it and the build fails on mismatch.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "public", "assets", "compilers");
const OUT_FILE = join(OUT_DIR, "soljson-v32b.8.12.js");
const SHA_FILE = join(root, "scripts", "compiler-sha256.txt");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function readPinnedHash() {
  if (!existsSync(SHA_FILE)) return null;
  const lines = readFileSync(SHA_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const hash = t.split(/\s+/)[0];
    if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

/** Resolve the compiler shipped inside the @quantumcoin/solc package. */
function resolveSource() {
  try {
    return createRequire(import.meta.url).resolve("@quantumcoin/solc/soljson.js");
  } catch {
    const fallback = join(root, "node_modules", "@quantumcoin", "solc", "soljson.js");
    return existsSync(fallback) ? fallback : null;
  }
}

function main() {
  const pinned = readPinnedHash();

  const src = resolveSource();
  if (!src || !existsSync(src)) {
    console.error("vendor:compiler FAILED — @quantumcoin/solc is not installed.");
    console.error("  Run `npm install` first; the Solidity compiler ships inside that package.");
    process.exit(1);
  }

  const buf = readFileSync(src);
  const h = sha256(buf);
  if (pinned) {
    if (h !== pinned) {
      console.error(
        `vendor:compiler FAILED — checksum mismatch\n  expected ${pinned}\n  got      ${h}\n  source   ${src}`,
      );
      process.exit(1);
    }
  } else {
    console.warn(`vendor:compiler: no pinned checksum found. Computed SHA-256:\n  ${h}`);
    console.warn(`  Add this to scripts/compiler-sha256.txt to enable the integrity gate.`);
  }

  // Skip the copy when the served asset already matches the package byte-for-byte.
  if (existsSync(OUT_FILE) && sha256(readFileSync(OUT_FILE)) === h) {
    console.log(
      `vendor:compiler: already present and up to date (${(buf.length / 1e6).toFixed(1)} MB) — skipping copy`,
    );
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, buf);
  console.log(`vendor:compiler: copied @quantumcoin/solc/soljson.js -> ${OUT_FILE} (${(buf.length / 1e6).toFixed(1)} MB)`);
  if (pinned) console.log(`vendor:compiler: checksum verified (${h})`);
}

main();
