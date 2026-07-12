/*
 * QuantumCoin SDK bridge (Mini §1.4, §7).
 *
 * All ABI parsing/validation, calldata encoding, and 32-byte address checks go
 * through `quantumcoin` (ethers v6-compatible). `Initialize(Config)` runs once at
 * bootstrap to load the bundled WASM runtime — INIT ONLY; Mini never opens a
 * provider or performs live RPC calls.
 *
 * The SDK is loaded via dynamic import so the app shell + editor remain usable
 * (with the ABI panel disabled) if the runtime fails to initialize (§7.5).
 */

// The SDK has no shipped types we depend on; treat as structural `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyModule = any;

const DEFAULT_CHAIN_ID = 123123;
const DEFAULT_RPC = "https://public.rpc.quantumcoinapi.com"; // used by Initialize only

let qc: AnyModule | null = null;
let ready = false;
let lastError: string | null = null;
let settled = false;
const settledListeners = new Set<() => void>();

function notifySettled(): void {
  settled = true;
  for (const cb of settledListeners) {
    try {
      cb();
    } catch {
      /* a listener error must not break others */
    }
  }
  settledListeners.clear();
}

/**
 * Run `cb` once `initSdk` has finished (success OR failure). Fires immediately
 * if the SDK has already settled. Lets UI built before bootstrap completes
 * (e.g. the Deploy/Execute panel) re-render against the final SDK state.
 */
export function onSdkSettled(cb: () => void): void {
  if (settled) {
    queueMicrotask(cb);
    return;
  }
  settledListeners.add(cb);
}

export function isSdkReady(): boolean {
  return ready;
}

export function sdkError(): string | null {
  return lastError;
}

/**
 * Load `quantumcoin` for ABI parsing/selectors/encoding. The `Interface` (ethers
 * v6-compatible, pure-JS keccak) needs no WASM, so ABI features become available
 * as soon as the module loads. `Initialize(Config)` (WASM runtime, used only for
 * provider bootstrap which Mini never exercises) is attempted best-effort and is
 * NOT required — its failure does not disable the ABI panel (§7.4/§7.5).
 */
let runtimeReady = false;

/** True once the WASM runtime is up (enables full calldata encoding via the SDK). */
export function isSdkRuntimeReady(): boolean {
  return runtimeReady;
}

export async function initSdk(): Promise<void> {
  // The bundled Go WASM runtime (`wasm_exec.js`) calls `new global.Go()`.
  (globalThis as any).global ??= globalThis;
  // `seed-words@1.0.x` (a transitive dep used by the SDK's Initialize()) relies on
  // sloppy-mode implicit globals — `for (i in ...)` / `i = 0` / `j = 0` with no
  // declaration — which throw `ReferenceError` under ESM strict mode. Pre-declaring
  // the bindings lets those assignments resolve so the SDK's WASM runtime can finish
  // initializing (enabling SDK calldata encoding). We only add bindings that don't
  // already exist and remove exactly those we added once init settles, keeping the
  // global-namespace pollution window as small as possible (QCB-002). This is a
  // scoped workaround for an upstream dependency bug; remove when `seed-words` ships
  // a strict-mode-clean release.
  const addedGlobals: string[] = [];
  for (const key of ["i", "j"]) {
    if (!(key in globalThis)) {
      (globalThis as any)[key] = 0;
      addedGlobals.push(key);
    }
  }
  const cleanupGlobals = (): void => {
    for (const key of addedGlobals) {
      try {
        delete (globalThis as any)[key];
      } catch {
        /* non-configurable binding: best-effort cleanup only */
      }
    }
  };

  try {
    const modNs: AnyModule = await import("quantumcoin");
    // `quantumcoin` is CommonJS (`export = {...}`); unwrap the interop default.
    const mod: AnyModule = modNs?.default ?? modNs;
    if (typeof mod?.Interface !== "function") {
      throw new Error("quantumcoin loaded but does not export `Interface`");
    }
    qc = mod;
    ready = true;
    lastError = null;
  } catch (err) {
    ready = false;
    lastError = err instanceof Error ? err.message : String(err);
    cleanupGlobals();
    notifySettled();
    throw err;
  }

  // Best-effort WASM runtime init. ABI parsing/selectors work without it; success
  // additionally enables SDK calldata encoding. No network I/O (embedded WASM).
  try {
    const cfgNs: AnyModule = await import("quantumcoin/config");
    const config: AnyModule = cfgNs?.default ?? cfgNs;
    if (typeof config?.Initialize === "function") {
      const Cfg = config.Config;
      const cfg = typeof Cfg === "function" ? new Cfg(DEFAULT_CHAIN_ID, DEFAULT_RPC) : null;
      const ok = await config.Initialize(cfg);
      runtimeReady = ok !== false;
    }
  } catch {
    runtimeReady = false;
  } finally {
    cleanupGlobals();
    notifySettled();
  }
}

/** Build an SDK `Interface` from a compiled ABI (Mini §7.1). */
export function createInterface(abi: unknown[]): AnyModule {
  if (!qc || !ready) throw new Error("QuantumCoin SDK not initialized");
  if (typeof qc.Interface !== "function") {
    throw new Error("quantumcoin does not export `Interface`");
  }
  return new qc.Interface(abi);
}

/**
 * 32-byte QuantumCoin address validation (Mini §7.1). QuantumCoin addresses are
 * 32 bytes (66 hex chars incl. 0x), unlike 20-byte EVM addresses — so the format
 * itself is the gate. (`quantumcoin.isAddress` is ethers-derived/20-byte and is
 * intentionally not used here.)
 */
export function isAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(addr);
}

export function getAddress(addr: string): string {
  if (!isAddress(addr)) throw new Error("Invalid 32-byte QuantumCoin address");
  return addr;
}

/** Decimal coin string -> integer wei string, via the SDK (ethers v6 parseUnits). */
export function parseUnits(value: string, decimals = 18): string {
  if (!qc || !ready) throw new Error("QuantumCoin SDK not initialized");
  return qc.parseUnits(value, decimals).toString();
}

/** Integer wei string -> decimal coin string, via the SDK (ethers v6 formatUnits). */
export function formatUnits(value: string, decimals = 18): string {
  if (!qc || !ready) throw new Error("QuantumCoin SDK not initialized");
  return qc.formatUnits(value, decimals);
}

/** keccak256(utf8(text)) via the SDK (pure-JS; no WASM) — used for selectors/topics. */
export function hashId(text: string): string {
  if (qc && typeof qc.id === "function") return qc.id(text);
  if (qc && typeof qc.keccak256 === "function") {
    return qc.keccak256(new TextEncoder().encode(text));
  }
  throw new Error("quantumcoin keccak256/id unavailable");
}

/** Encode write-function calldata for local preview (Mini §7.1) — no broadcast. */
export function encodeFunctionData(
  iface: AnyModule,
  name: string,
  args: unknown[],
): string {
  return iface.encodeFunctionData(name, args);
}

/** Encode constructor arguments for a deploy (ethers v6 `encodeDeploy`). */
export function encodeDeploy(iface: AnyModule, args: unknown[]): string {
  if (typeof iface?.encodeDeploy !== "function") {
    throw new Error("SDK Interface does not support encodeDeploy");
  }
  return iface.encodeDeploy(args);
}

/** Decode the return data of an `eth_call` for a read function. */
export function decodeFunctionResult(
  iface: AnyModule,
  name: string,
  data: string,
): unknown {
  return iface.decodeFunctionResult(name, data);
}
