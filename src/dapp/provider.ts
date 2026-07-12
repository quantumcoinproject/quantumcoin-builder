/*
 * QuantumSwap wallet bridge (dApp integration).
 *
 * Thin typed wrapper over the EIP-1193-style provider the QuantumSwap browser
 * extension injects at `window.quantumcoin` (see the extension's README-DAPP).
 * The builder talks to it with `request({ method, params })` and subscribes to
 * wallet-side events. No keys ever reach this code; signing happens in the
 * extension's approval popup.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface QcNetwork {
  name: string;
  chainId: number;
  scanApiDomain: string;
  blockExplorerDomain: string;
  rpcEndpoint: string;
  index: number;
}

export interface SendTxParams {
  to?: string;
  data?: string;
  value?: string;
  abi?: unknown[];
  bytecode?: string;
}

export interface TxReceipt {
  transactionHash: string;
  contractAddress?: string | null;
  status?: string; // "0x1" success / "0x0" failure on most nodes
  [k: string]: unknown;
}

export type TxResultStatus = "succeeded" | "failed" | "timeout";

export interface TransactionResult {
  txHash: string;
  status: TxResultStatus;
}

interface RawProvider {
  isQuantumCoin?: boolean;
  request(args: { method: string; params?: any }): Promise<any>;
  on(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

function raw(): RawProvider | null {
  const p = (globalThis as any).quantumcoin as RawProvider | undefined;
  return p && typeof p.request === "function" ? p : null;
}

export type ProviderEvent =
  | "accountsChanged"
  | "chainChanged"
  | "disconnect"
  | "transactionResult"
  | "statusChanged";

/**
 * Connection state + event fan-out around `window.quantumcoin`. A single
 * instance is shared by the Deploy/Execute panel; it re-emits the raw provider
 * events (plus a synthetic `statusChanged`) so the UI can re-render.
 */
export class WalletProvider {
  private account: string | null = null;
  private network: QcNetwork | null = null;
  private bound = false;
  private listeners = new Map<ProviderEvent, Set<(payload: any) => void>>();

  /** True when the extension provider is present on the page. */
  isAvailable(): boolean {
    return raw() != null;
  }

  isConnected(): boolean {
    return this.account != null;
  }

  getAccount(): string | null {
    return this.account;
  }

  getNetwork(): QcNetwork | null {
    return this.network;
  }

  /** Resolve once the provider is injected (or immediately if already present). */
  whenReady(cb: () => void): void {
    if (this.isAvailable()) {
      cb();
      return;
    }
    const handler = (): void => {
      if (this.isAvailable()) cb();
    };
    window.addEventListener("quantumcoin#initialized", handler, { once: true });
  }

  on(event: ProviderEvent, handler: (payload: any) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  private emit(event: ProviderEvent, payload?: any): void {
    this.listeners.get(event)?.forEach((h) => h(payload));
  }

  /** Wire raw provider events into our fan-out exactly once. */
  private bindRawEvents(p: RawProvider): void {
    if (this.bound) return;
    this.bound = true;
    p.on("accountsChanged", (accounts: string[]) => {
      this.account = accounts && accounts.length ? accounts[0]! : null;
      if (!this.account) this.network = null;
      this.emit("accountsChanged", accounts);
      this.emit("statusChanged");
    });
    p.on("chainChanged", (chainIdHex: string) => {
      this.emit("chainChanged", chainIdHex);
      // Refresh the network descriptor, then signal a redraw so the wallet bar's
      // network pill reflects the new chain (statusChanged drives the UI).
      void this.refreshNetwork().then(() => this.emit("statusChanged"));
    });
    p.on("disconnect", () => {
      this.account = null;
      this.network = null;
      this.emit("disconnect");
      this.emit("statusChanged");
    });
    p.on("transactionResult", (r: TransactionResult) => {
      this.emit("transactionResult", r);
    });
  }

  private require(): RawProvider {
    const p = raw();
    if (!p) throw new Error("QuantumSwap provider not found. Install/enable the extension and reload.");
    this.bindRawEvents(p);
    return p;
  }

  async connect(): Promise<string> {
    const p = this.require();
    const accounts: string[] = await p.request({ method: "qc_requestAccounts" });
    this.account = accounts && accounts.length ? accounts[0]! : null;
    if (!this.account) throw new Error("No account returned by the wallet.");
    await this.refreshNetwork();
    this.emit("statusChanged");
    return this.account;
  }

  /** Read the connected account without prompting; syncs local state. */
  async refreshAccount(): Promise<string | null> {
    const p = raw();
    if (!p) return null;
    this.bindRawEvents(p);
    try {
      const accounts: string[] = await p.request({ method: "qc_accounts" });
      this.account = accounts && accounts.length ? accounts[0]! : null;
      if (this.account) await this.refreshNetwork();
    } catch {
      this.account = null;
    }
    this.emit("statusChanged");
    return this.account;
  }

  async refreshNetwork(): Promise<QcNetwork | null> {
    const p = raw();
    if (!p) return null;
    try {
      this.network = (await p.request({ method: "qc_getNetwork" })) as QcNetwork | null;
    } catch {
      this.network = null;
    }
    return this.network;
  }

  async sendTransaction(params: SendTxParams): Promise<string> {
    const p = this.require();
    const res = await p.request({ method: "qc_sendTransaction", params });
    const txHash = res?.txHash;
    if (typeof txHash !== "string") throw new Error("Wallet did not return a transaction hash.");
    return txHash;
  }

  /** Read-only `eth_call` passthrough (no popup); requires a connected site. */
  async ethCall(to: string, data: string): Promise<string> {
    const p = this.require();
    return (await p.request({ method: "eth_call", params: [{ to, data }, "latest"] })) as string;
  }

  /** Read the deployed bytecode at an address ("0x" when none). Requires connection. */
  async getCode(address: string): Promise<string> {
    const p = this.require();
    return (await p.request({ method: "eth_getCode", params: [address, "latest"] })) as string;
  }

  async getReceipt(txHash: string): Promise<TxReceipt | null> {
    const p = this.require();
    return (await p.request({ method: "eth_getTransactionReceipt", params: [txHash] })) as TxReceipt | null;
  }

  /** Poll the receipt until mined or timed out (README pattern). */
  async waitForReceipt(txHash: string, tries = 40, intervalMs = 3000): Promise<TxReceipt | null> {
    for (let i = 0; i < tries; i++) {
      const r = await this.getReceipt(txHash);
      if (r) return r;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
    return null;
  }

  async disconnect(): Promise<void> {
    const p = raw();
    if (!p) return;
    try {
      await p.request({ method: "qc_disconnect" });
    } catch {
      /* ignore */
    }
    this.account = null;
    this.network = null;
    this.emit("statusChanged");
  }
}
