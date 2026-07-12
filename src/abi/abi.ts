/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createInterface,
  encodeFunctionData,
  encodeDeploy,
  hashId,
  isAddress,
} from "./sdk";

export interface AbiParam {
  name: string;
  type: string;
  /** Tuple/struct component params (present for tuple, tuple[], tuple[k]). */
  components?: AbiParam[];
}

export interface AbiFunctionInfo {
  name: string;
  inputs: AbiParam[];
  outputs: AbiParam[];
  selector: string;
  stateMutability: string;
  kind: "read" | "write";
}

export interface AbiEventInfo {
  name: string;
  signature: string;
  topic0: string;
}

export interface AbiCatalog {
  read: AbiFunctionInfo[];
  write: AbiFunctionInfo[];
  events: AbiEventInfo[];
  constructorInputs: AbiParam[];
  constructorPayable: boolean;
  iface: any;
}

function params(list: any[] | undefined): AbiParam[] {
  if (!list) return [];
  return list.map((p: any, i: number) => {
    const param: AbiParam = {
      name: p?.name || `arg${i}`,
      type: typeof p?.type === "string" ? p.type : String(p?.type ?? "?"),
    };
    if (Array.isArray(p?.components)) param.components = params(p.components);
    return param;
  });
}

/** Canonical type for signatures: expands tuples to `(t1,t2)` and keeps array suffixes. */
function canonicalType(p: any): string {
  const type: string = p?.type ?? "";
  if (type.startsWith("tuple")) {
    const inner = (p.components ?? []).map(canonicalType).join(",");
    const suffix = type.slice("tuple".length); // e.g. "", "[]", "[2]"
    return `(${inner})${suffix}`;
  }
  return type;
}

function signatureOf(name: string, inputs: any[]): string {
  return `${name}(${(inputs ?? []).map(canonicalType).join(",")})`;
}

function selectorOf(name: string, inputs: any[]): string {
  try {
    return hashId(signatureOf(name, inputs)).slice(0, 10); // 0x + 4 bytes
  } catch {
    return "";
  }
}

function topic0Of(name: string, inputs: any[]): string {
  try {
    return hashId(signatureOf(name, inputs)); // full 32-byte topic
  } catch {
    return "";
  }
}

/**
 * Build a normalized read/write/event catalog from a compiled ABI using the
 * SDK `Interface` (Mini §7.1). Works with the ethers v6-compatible surface.
 */
export function buildCatalog(abi: unknown[]): AbiCatalog {
  // `createInterface` validates the ABI through the SDK and provides the encoder.
  const iface = createInterface(abi);
  const read: AbiFunctionInfo[] = [];
  const write: AbiFunctionInfo[] = [];
  const events: AbiEventInfo[] = [];
  let constructorInputs: AbiParam[] = [];
  let constructorPayable = false;

  const fragments = (Array.isArray(abi) ? abi : []) as any[];
  for (const f of fragments) {
    if (!f || typeof f !== "object") continue;

    if (f.type === "constructor") {
      constructorInputs = params(f.inputs);
      constructorPayable = f.stateMutability === "payable";
    } else if (f.type === "function") {
      const mutability: string = f.stateMutability || "nonpayable";
      const kind: "read" | "write" =
        mutability === "view" || mutability === "pure" ? "read" : "write";
      const info: AbiFunctionInfo = {
        name: f.name,
        inputs: params(f.inputs),
        outputs: params(f.outputs),
        selector: selectorOf(f.name, f.inputs),
        stateMutability: mutability,
        kind,
      };
      (kind === "read" ? read : write).push(info);
    } else if (f.type === "event") {
      events.push({
        name: f.name,
        signature: signatureOf(f.name, f.inputs),
        topic0: topic0Of(f.name, f.inputs),
      });
    }
  }

  return { read, write, events, constructorInputs, constructorPayable, iface };
}

/**
 * Parse a Simple-mode text value into the JS value the SDK encoder expects:
 * `uint/int` stay decimal strings (full 256-bit precision), `bool` becomes a
 * boolean, arrays/tuples are bracketed JSON (Remix convention). Throws with a
 * user-facing message when the text cannot be parsed.
 */
export function parseAbiValue(type: string, raw: string): unknown {
  const text = raw.trim();
  if (type.endsWith("]")) {
    const parsed = parseArrayValue(text);
    if (!Array.isArray(parsed)) throw new Error("expected an array like [1, 2]");
    return parsed;
  }
  if (type.startsWith("tuple")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('expected a JSON array of components, e.g. [1, "a"]');
    }
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array of components");
    return parsed;
  }
  if (type === "bool") return text === "true";
  if (/^u?int/.test(type)) return text;
  if (type === "string") return raw;
  return text;
}

function parseArrayValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  // Fallback: comma-separated scalar list.
  return trimmed.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Validate a user-entered value against its Solidity ABI type. Returns an error
 * message string when invalid, or `null` when the value is acceptable. Used to
 * gate deploy/execute inputs before encoding (Deploy/Execute tab, §7.1).
 */
export function validateAbiValue(type: string, raw: string): string | null {
  const value = raw.trim();

  // Arrays: validate each element against the base type.
  const arrayMatch = type.match(/^(.*)\[(\d*)\]$/);
  if (arrayMatch) {
    const baseType = arrayMatch[1]!;
    const fixedLen = arrayMatch[2] ? Number(arrayMatch[2]) : null;
    if (value === "") return "required";
    let items: unknown[];
    const parsed = parseArrayValue(value);
    items = Array.isArray(parsed) ? parsed : [];
    if (fixedLen != null && items.length !== fixedLen) {
      return `expected ${fixedLen} item(s), got ${items.length}`;
    }
    for (const it of items) {
      const err = validateAbiValue(baseType, String(it));
      if (err) return `array element: ${err}`;
    }
    return null;
  }

  // Tuples: encoded/decoded by the SDK; accept non-empty JSON-ish input.
  if (type.startsWith("tuple")) {
    return value === "" ? "required" : null;
  }

  if (type === "address") {
    return isAddress(value) ? null : "expected a 32-byte (0x + 64 hex) address";
  }

  if (type === "bool") {
    return value === "true" || value === "false" ? null : 'expected "true" or "false"';
  }

  if (type === "string") {
    return null; // any string (including empty) is valid
  }

  // Fixed-size bytesN
  const bytesN = type.match(/^bytes(\d+)$/);
  if (bytesN) {
    const n = Number(bytesN[1]);
    const hex = /^0x[0-9a-fA-F]*$/.test(value) ? value.slice(2) : null;
    if (hex == null) return "expected 0x-prefixed hex";
    if (hex.length !== n * 2) return `expected ${n} byte(s) (${n * 2} hex chars)`;
    return null;
  }

  // Dynamic bytes
  if (type === "bytes") {
    if (!/^0x[0-9a-fA-F]*$/.test(value)) return "expected 0x-prefixed hex";
    if (value.length % 2 !== 0) return "expected an even number of hex digits";
    return null;
  }

  // Integers: uint / int with optional bit width.
  const intMatch = type.match(/^(u?)int(\d*)$/);
  if (intMatch) {
    const unsigned = intMatch[1] === "u";
    const bits = intMatch[2] ? Number(intMatch[2]) : 256;
    if (value === "") return "required";
    if (!/^-?\d+$/.test(value)) return "expected an integer";
    let v: bigint;
    try {
      v = BigInt(value);
    } catch {
      return "expected an integer";
    }
    if (unsigned) {
      if (v < 0n) return "must be non-negative";
      if (v > (1n << BigInt(bits)) - 1n) return `exceeds uint${bits} max`;
    } else {
      const min = -(1n << BigInt(bits - 1));
      const max = (1n << BigInt(bits - 1)) - 1n;
      if (v < min || v > max) return `out of int${bits} range`;
    }
    return null;
  }

  // Unknown type: don't block the user.
  return null;
}

/** Encode calldata for a function from already-structured JS values. */
export function encodeCallValues(
  catalog: AbiCatalog,
  name: string,
  values: unknown[],
): string {
  return encodeFunctionData(catalog.iface, name, values);
}

/**
 * Build contract-creation `data` for a deploy: creation bytecode followed by
 * the ABI-encoded constructor arguments (structured JS values). `bytecode` is
 * 0x-prefixed (evm.bytecode).
 */
export function encodeDeployDataValues(
  catalog: AbiCatalog,
  bytecode: string,
  values: unknown[],
): string {
  const encoded = encodeDeploy(catalog.iface, values); // "0x" when no args
  const code = bytecode.startsWith("0x") ? bytecode : "0x" + bytecode;
  return code + encoded.slice(2);
}

/** Human-readable rendering of a decoded read result (handles BigInt/arrays/tuples). */
export function formatResult(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(formatResult).join(", ") + "]";
  }
  // ethers Result objects are array-like; fall back to JSON with BigInt support.
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}
