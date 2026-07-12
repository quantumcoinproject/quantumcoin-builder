/*
 * Deploy/Execute panel (Remix-style "Deploy & Run").
 *
 * Connects to the QuantumSwap wallet (via WalletProvider), deploys compiled
 * contracts, and calls their read/write methods with typed parameter inputs.
 * Execution status is driven live by the provider's `transactionResult` event.
 *
 * The panel owns a persistent root element and its own state so that deployed
 * instances and in-progress inputs survive side-panel tab switches / re-renders.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CompileResult, CompiledContract } from "../compiler/types";
import {
  buildCatalog,
  encodeCallValues,
  encodeDeployDataValues,
  formatResult,
  type AbiCatalog,
  type AbiFunctionInfo,
  type AbiParam,
} from "../abi/abi";
import { createArgControl, createModeToggle, getArgMode } from "../abi/argControl";
import { isSdkReady, isAddress, decodeFunctionResult, onSdkSettled } from "../abi/sdk";
import { copyToClipboard } from "../export/download";
import {
  MAX_OUTPUT_CHARS,
  escapeAttr,
  isTxHashLike,
  truncateWithNotice,
} from "../app/limits";
import {
  WalletProvider,
  type TransactionResult,
} from "./provider";

export interface RunPanelHooks {
  log: (msg: string, kind?: "info" | "success" | "warning" | "error") => void;
}

interface Instance {
  name: string;
  address: string;
  abi: unknown[];
  catalog: AbiCatalog;
}

/** Result of collecting a parameter form: structured values or a specific error. */
type ArgValues = { values: unknown[]; error?: never } | { error: string; values?: never };

type ChipKind = "pending" | "ok" | "warnc" | "errc" | "muted";

interface Chip {
  el: HTMLElement;
  set: (html: string, kind: ChipKind) => void;
}

export class RunPanel {
  readonly el: HTMLElement;
  private hooks: RunPanelHooks;
  private provider = new WalletProvider();

  private result: CompileResult | null = null;
  private selected: string | null = null;
  private instances: Instance[] = [];

  // txHash -> callback fired when the wallet reports the final result.
  private pending = new Map<string, (r: TransactionResult) => void>();

  private walletBar!: HTMLDivElement;
  private deploySection!: HTMLDivElement;
  private instancesEl!: HTMLDivElement;
  // The "Load" (deployed address) input in the current deploy section, so a
  // successful deploy can populate it and trigger the same load flow.
  private atInput: HTMLInputElement | null = null;

  constructor(hooks: RunPanelHooks) {
    this.hooks = hooks;
    this.el = document.createElement("div");
    this.el.className = "run-pane";

    this.walletBar = div("wallet-bar");

    // Simple/Detailed argument-input mode (shared with the ABI tab).
    const modeBar = div("mode-bar");
    const modeLabel = document.createElement("span");
    modeLabel.className = "field-label";
    modeLabel.textContent = "Inputs";
    modeBar.append(modeLabel, createModeToggle(() => {
      this.renderDeploySection();
      this.renderInstances();
    }));

    this.deploySection = div("deploy-section");
    const instLabel = document.createElement("div");
    instLabel.className = "field-label";
    instLabel.textContent = "Deployed contracts";
    this.instancesEl = div("instances");
    this.el.append(this.walletBar, modeBar, this.deploySection, instLabel, this.instancesEl);

    this.provider.on("statusChanged", () => {
      this.renderWalletBar();
      this.renderDeploySection();
      this.updateConnState();
    });
    this.provider.on("transactionResult", (r: TransactionResult) => this.onTxResult(r));

    // Pick up an already-connected session (no popup) once the provider exists.
    this.provider.whenReady(() => {
      this.renderWalletBar();
      void this.provider.refreshAccount();
    });

    this.renderWalletBar();
    this.renderDeploySection();

    // The panel is built during shell bootstrap, before `initSdk()` resolves, so
    // the first deploy-section render sees `isSdkReady() === false`. Re-render
    // once the SDK settles to clear the stale "SDK not initialized" warning.
    onSdkSettled(() => this.renderDeploySection());
  }

  setResult(result: CompileResult, activePath?: string): void {
    this.result = result;
    const deployable = result.contracts.filter((c) => c.bytecode);
    const names = deployable.map((c) => c.contractName);
    if (!this.selected || !names.includes(this.selected)) {
      // Prefer a deployable contract from the active file (fall back to first).
      const fromActive = activePath
        ? deployable.find((c) => c.sourcePath === activePath)?.contractName
        : undefined;
      this.selected = fromActive ?? names[0] ?? null;
    }
    this.renderDeploySection();
  }

  /** Clear deployed instances and compiled result (e.g. on workspace switch). */
  reset(): void {
    this.instances = [];
    this.pending.clear();
    this.result = null;
    this.selected = null;
    this.renderInstances();
    this.renderDeploySection();
  }

  private deployableContracts(): CompiledContract[] {
    return this.result?.contracts.filter((c) => c.bytecode) ?? [];
  }

  private currentContract(): CompiledContract | null {
    return this.deployableContracts().find((c) => c.contractName === this.selected) ?? null;
  }

  // ---- Wallet bar ----
  private renderWalletBar(): void {
    const bar = this.walletBar;
    bar.innerHTML = "";

    if (!this.provider.isAvailable()) {
      const hint = document.createElement("div");
      hint.className = "empty";
      hint.append("QuantumSwap extension not detected. Install the ");
      const link = document.createElement("a");
      link.className = "explorer-link";
      link.href = "https://quantumswap.com/extension.html";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "QuantumSwap extension";
      hint.append(link);
      hint.append(", then reload to deploy and execute contracts.");
      bar.appendChild(hint);
      return;
    }

    if (!this.provider.isConnected()) {
      const btn = document.createElement("button");
      btn.className = "btn block";
      btn.textContent = "Connect Wallet";
      btn.addEventListener("click", () => void this.connect());
      bar.appendChild(btn);
      return;
    }

    const account = this.provider.getAccount()!;
    const net = this.provider.getNetwork();

    const row = div("wallet-row");
    const acc = document.createElement("span");
    acc.className = "wallet-acc mono";
    acc.textContent = shortAddr(account);
    acc.title = account;

    const netPill = document.createElement("span");
    netPill.className = "pill";
    netPill.textContent = net ? `${net.name} \u00b7 ${net.chainId}` : "connected";

    const disc = document.createElement("button");
    disc.className = "btn ghost";
    disc.textContent = "Disconnect";
    disc.addEventListener("click", () => void this.provider.disconnect());

    row.append(acc, netPill, disc);
    bar.appendChild(row);
  }

  private async connect(): Promise<void> {
    try {
      const account = await this.provider.connect();
      this.hooks.log(`Wallet connected: ${shortAddr(account)}`, "success");
    } catch (err) {
      this.hooks.log("Connect failed: " + msg(err), "error");
    }
  }

  // ---- Deploy section ----
  private renderDeploySection(): void {
    const s = this.deploySection;
    s.innerHTML = "";

    if (!isSdkReady()) {
      const warn = document.createElement("div");
      warn.className = "empty";
      warn.innerHTML =
        "QuantumCoin SDK not initialized \u2014 constructor/argument encoding is unavailable.";
      s.appendChild(warn);
      return;
    }

    const label = document.createElement("div");
    label.className = "field-label";
    label.textContent = "Deploy";
    s.appendChild(label);

    const contracts = this.deployableContracts();
    if (contracts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Compile a contract to deploy it.";
      s.appendChild(empty);
      return;
    }

    // Contract picker
    const select = document.createElement("select");
    select.className = "select";
    for (const c of contracts) {
      const opt = document.createElement("option");
      opt.value = c.contractName;
      opt.textContent = c.contractName;
      if (c.contractName === this.selected) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this.selected = select.value;
      this.renderDeploySection();
    });
    s.appendChild(select);

    const c = this.currentContract();
    if (!c) return;

    let catalog: AbiCatalog;
    try {
      catalog = buildCatalog(c.abi);
    } catch (err) {
      const e = document.createElement("div");
      e.className = "empty errc";
      e.textContent = "Invalid ABI: " + msg(err);
      s.appendChild(e);
      return;
    }

    const ctorInputs = this.argInputs(catalog.constructorInputs);
    for (const el of ctorInputs.rows) s.appendChild(el);

    let valueInput: HTMLInputElement | null = null;
    if (catalog.constructorPayable) {
      valueInput = this.valueField(s);
    }

    const deployBtn = document.createElement("button");
    deployBtn.className = "btn block needs-conn";
    deployBtn.textContent = "\u2191 Deploy";
    deployBtn.disabled = !this.provider.isConnected();
    const chip = this.makeChip();
    deployBtn.addEventListener("click", () =>
      void this.deploy(c, catalog, ctorInputs.read(), valueInput?.value ?? "", chip),
    );
    s.append(deployBtn, chip.el);

    // At Address (attach existing deployment)
    const atLabel = document.createElement("div");
    atLabel.className = "field-label";
    atLabel.textContent = "Or use a deployed address";
    const atRow = div("at-row");
    const atInput = document.createElement("input");
    atInput.className = "arg-input";
    atInput.placeholder = "0x<64-hex contract address>";
    this.atInput = atInput;
    const atBtn = document.createElement("button");
    atBtn.className = "btn ghost";
    atBtn.textContent = "Load";
    atBtn.addEventListener("click", () => this.loadFromInput(c, catalog));
    atRow.append(atInput, atBtn);
    s.append(atLabel, atRow);
  }

  /** Load the contract at the address currently in the "Load" input. */
  private loadFromInput(c: CompiledContract, catalog: AbiCatalog): void {
    const input = this.atInput;
    const addr = input?.value.trim() ?? "";
    if (!isAddress(addr)) {
      input?.classList.add("invalid");
      this.hooks.log("Load: expected a 32-byte (64-hex) QuantumCoin address.", "error");
      return;
    }
    input?.classList.remove("invalid");
    this.loadContract(c.contractName, addr, c.abi, catalog);
  }

  /** Attach an instance (methods shown regardless) and run the on-chain check. */
  private loadContract(name: string, addr: string, abi: unknown[], catalog: AbiCatalog): void {
    this.addInstance(name, addr, abi, catalog);
    this.hooks.log(`Loaded ${name} at ${shortAddr(addr)}`, "success");
    void this.checkContractCode(name, addr);
  }

  /**
   * Best-effort check that contract code exists at `addr` (via `eth_getCode`).
   * This only confirms bytecode is present, NOT that it conforms to `name`'s
   * interface; the instance is attached regardless so methods can be tried.
   */
  private async checkContractCode(name: string, addr: string): Promise<void> {
    if (!this.provider.isConnected()) {
      this.hooks.log(
        `Skipped on-chain check for ${shortAddr(addr)}: connect a wallet to verify contract code exists.`,
        "warning",
      );
      return;
    }
    try {
      const code = await this.provider.getCode(addr);
      if (!code || code === "0x" || code === "0x0") {
        this.hooks.log(
          `No contract code at ${shortAddr(addr)} - it may be a wallet address or an undeployed/incorrect address. Methods are still shown so you can try calls.`,
          "error",
        );
      } else {
        this.hooks.log(
          `Contract code found at ${shortAddr(addr)}. Note: this only confirms code exists, not that it conforms to the ${name} interface.`,
          "success",
        );
      }
    } catch (err) {
      this.hooks.log(`Could not check code at ${shortAddr(addr)}: ${msg(err)}`, "warning");
    }
  }

  private valueField(parent: HTMLElement): HTMLInputElement {
    const lab = document.createElement("div");
    lab.className = "meta";
    lab.textContent = "value (wei)";
    const input = document.createElement("input");
    input.className = "arg-input";
    input.placeholder = "0";
    parent.append(lab, input);
    return input;
  }

  private async deploy(
    c: CompiledContract,
    catalog: AbiCatalog,
    args: ArgValues,
    value: string,
    chip: Chip,
  ): Promise<void> {
    const invalid = args.error ?? weiError(value);
    if (invalid != null) {
      chip.set(escapeHtml(invalid), "errc");
      this.hooks.log(`Deploy ${c.contractName}: ${invalid}`, "error");
      return;
    }
    try {
      chip.set("Encoding\u2026", "pending");
      const data = encodeDeployDataValues(catalog, c.bytecode, args.values!);
      chip.set("Awaiting approval\u2026", "pending");
      const txHash = await this.provider.sendTransaction({
        data,
        value: toWeiHex(value),
        abi: c.abi,
        bytecode: c.bytecode,
      });
      this.hooks.log(`Deploy ${c.contractName} submitted, transaction id is: ${txHash}`, "info");
      chip.set(`Pending ${this.txLink(txHash)}`, "pending");

      // Resolve the deployed address independently of the status event.
      void this.provider.waitForReceipt(txHash).then((receipt) => {
        const addr = receipt?.contractAddress;
        // Validate the wallet-supplied address shape before it flows into logs,
        // the "Load" input, and downstream getCode/eth_call requests (QCB-004).
        if (typeof addr === "string" && isAddress(addr)) {
          this.hooks.log(`${c.contractName} deployed at ${addr}`, "success");
          // Populate the "Load" input with the new address and run the load flow.
          if (this.atInput) this.atInput.value = addr;
          this.loadContract(c.contractName, addr, c.abi, catalog);
        } else if (addr != null) {
          this.hooks.log(
            `Ignored malformed contract address in deploy receipt for ${c.contractName}`,
            "warning",
          );
        }
      });

      this.watchTx(txHash, chip, `${c.contractName} deploy`);
    } catch (err) {
      chip.set("Failed: " + msg(err), "errc");
      this.hooks.log(`Deploy ${c.contractName} failed: ` + msg(err), "error");
    }
  }

  // ---- Deployed instances ----
  private addInstance(name: string, address: string, abi: unknown[], catalog: AbiCatalog): void {
    if (this.instances.some((i) => i.address === address)) return;
    const inst: Instance = { name, address, abi, catalog };
    this.instances.push(inst);
    this.instancesEl.appendChild(this.instanceCard(inst));
    this.updateConnState();
  }

  /** Rebuild all instance cards (used when the input mode changes). */
  private renderInstances(): void {
    this.instancesEl.innerHTML = "";
    for (const inst of this.instances) this.instancesEl.appendChild(this.instanceCard(inst));
    this.updateConnState();
  }

  private instanceCard(inst: Instance): HTMLElement {
    const card = div("instance");

    const head = div("instance-head");
    const title = document.createElement("span");
    title.className = "instance-name";
    title.textContent = inst.name;
    const addr = document.createElement("span");
    addr.className = "instance-addr mono";
    addr.textContent = shortAddr(inst.address);
    addr.title = inst.address;

    const copy = document.createElement("button");
    copy.className = "btn ghost";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void copyToClipboard(inst.address);
      this.hooks.log(`Copied address ${shortAddr(inst.address)}`);
    });

    head.append(title, addr, copy);

    const explorer = this.explorerLink("address", inst.address);
    if (explorer) head.appendChild(explorer);
    card.appendChild(head);

    if (inst.catalog.read.length === 0 && inst.catalog.write.length === 0) {
      card.appendChild(emptyLine("(no callable functions)"));
    }
    for (const fn of inst.catalog.read) card.appendChild(this.fnRow(inst, fn, "read"));
    for (const fn of inst.catalog.write) card.appendChild(this.fnRow(inst, fn, "write"));

    return card;
  }

  private fnRow(inst: Instance, fn: AbiFunctionInfo, kind: "read" | "write"): HTMLElement {
    const row = div("fn");
    const sig = document.createElement("div");
    sig.className = "sig";
    const ret = fn.outputs.length ? " \u2192 " + fn.outputs.map((o) => o.type).join(", ") : "";
    sig.textContent = `${fn.name}(${fn.inputs.map((i) => `${i.type} ${i.name}`).join(", ")})${ret}`;
    row.appendChild(sig);

    const args = this.argInputs(fn.inputs);
    for (const el of args.rows) row.appendChild(el);

    let valueInput: HTMLInputElement | null = null;
    if (kind === "write" && fn.stateMutability === "payable") {
      valueInput = this.valueField(row);
    }

    const out = div("fn-out mono");
    out.style.display = "none";

    const actions = div("fn-actions");
    const btn = document.createElement("button");
    btn.className = "btn needs-conn " + (kind === "read" ? "read-btn" : "write-btn");
    btn.textContent = kind === "read" ? "call" : "transact";
    btn.disabled = !this.provider.isConnected();
    const chip = this.makeChip();
    btn.addEventListener("click", () => {
      if (kind === "read") void this.callRead(inst, fn, args.read(), chip, out);
      else void this.callWrite(inst, fn, args.read(), valueInput?.value ?? "", chip);
    });
    actions.append(btn, chip.el);
    row.append(actions, out);

    return row;
  }

  private async callRead(
    inst: Instance,
    fn: AbiFunctionInfo,
    args: ArgValues,
    chip: Chip,
    out: HTMLElement,
  ): Promise<void> {
    if (args.error != null) {
      chip.set(escapeHtml(args.error), "errc");
      this.hooks.log(`${inst.name}.${fn.name}: ${args.error}`, "error");
      return;
    }
    try {
      chip.set("Calling\u2026", "pending");
      out.style.display = "none";
      const data = encodeCallValues(inst.catalog, fn.name, args.values!);
      const ret = await this.provider.ethCall(inst.address, data);
      const decoded = decodeFunctionResult(inst.catalog.iface, fn.name, ret);
      // On-chain return data is untrusted: cap length before display/logging so
      // a hostile contract cannot bloat the DOM. Rendered via textContent (no HTML).
      const text = truncateWithNotice(formatResult(decoded), MAX_OUTPUT_CHARS);
      chip.set("\u2713", "ok");
      out.textContent = text;
      out.style.display = "";
      this.hooks.log(`${inst.name}.${fn.name} \u2192 ${text}`, "success");
    } catch (err) {
      chip.set("Failed: " + msg(err), "errc");
      this.hooks.log(`${inst.name}.${fn.name} failed: ` + msg(err), "error");
    }
  }

  private async callWrite(
    inst: Instance,
    fn: AbiFunctionInfo,
    args: ArgValues,
    value: string,
    chip: Chip,
  ): Promise<void> {
    const invalid = args.error ?? weiError(value);
    if (invalid != null) {
      chip.set(escapeHtml(invalid), "errc");
      this.hooks.log(`${inst.name}.${fn.name}: ${invalid}`, "error");
      return;
    }
    try {
      chip.set("Encoding\u2026", "pending");
      const data = encodeCallValues(inst.catalog, fn.name, args.values!);
      chip.set("Awaiting approval\u2026", "pending");
      const txHash = await this.provider.sendTransaction({
        to: inst.address,
        data,
        value: toWeiHex(value),
        abi: inst.abi,
      });
      this.hooks.log(`${inst.name}.${fn.name} submitted: ${txHash}`, "info");
      chip.set(`Pending ${this.txLink(txHash)}`, "pending");
      this.watchTx(txHash, chip, `${inst.name}.${fn.name}`);
    } catch (err) {
      chip.set("Failed: " + msg(err), "errc");
      this.hooks.log(`${inst.name}.${fn.name} failed: ` + msg(err), "error");
    }
  }

  // ---- Transaction result tracking ----
  private watchTx(txHash: string, chip: Chip, label: string): void {
    this.pending.set(txHash, (r) => {
      if (r.status === "succeeded") {
        chip.set(`Succeeded ${this.txLink(txHash)}`, "ok");
        this.hooks.log(`${label} succeeded: ${txHash}`, "success");
      } else if (r.status === "failed") {
        chip.set(`Failed ${this.txLink(txHash)}`, "errc");
        this.hooks.log(`${label} failed on-chain: ${txHash}`, "error");
      } else {
        chip.set(`Timed out ${this.txLink(txHash)}`, "warnc");
        this.hooks.log(`${label} timed out waiting for confirmation: ${txHash}`, "warning");
      }
    });
  }

  private onTxResult(r: TransactionResult): void {
    // Only act on well-formed hashes that correlate to a tx we actually
    // submitted; drop unsolicited/malformed extension events (QCB-004/QCB-017).
    if (!r || typeof r.txHash !== "string" || !isTxHashLike(r.txHash)) return;
    const cb = this.pending.get(r.txHash);
    if (cb) {
      cb(r);
      this.pending.delete(r.txHash);
    }
  }

  private updateConnState(): void {
    const connected = this.provider.isConnected();
    this.el.querySelectorAll<HTMLButtonElement>(".needs-conn").forEach((b) => {
      b.disabled = !connected;
    });
  }

  // ---- Shared helpers ----

  /**
   * Build typed argument controls (Simple or Detailed mode, §7.1). Returns the
   * control elements and a `read()` that collects structured JS values, or the
   * first offending field's validation message (marking all invalid inputs).
   */
  private argInputs(params: AbiParam[]): {
    rows: HTMLElement[];
    read: () => ArgValues;
  } {
    const controls = params.map((p) => createArgControl(p, { mode: getArgMode() }));
    return {
      rows: controls.map((c) => c.el),
      read: () => {
        const values: unknown[] = [];
        let error: string | undefined;
        for (const c of controls) {
          const r = c.read();
          if (!r.ok) error ??= r.error ?? "invalid argument";
          else values.push(r.value);
        }
        return error != null ? { error } : { values };
      },
    };
  }

  private makeChip(): Chip {
    const el = document.createElement("span");
    el.className = "status-chip";
    el.style.display = "none";
    const set = (html: string, kind: ChipKind): void => {
      el.style.display = "";
      el.className = "status-chip " + kind;
      const spinner = kind === "pending" ? '<span class="spin">\u25CC</span> ' : "";
      el.innerHTML = spinner + html;
    };
    return { el, set };
  }

  private explorerBase(): string | null {
    const net = this.provider.getNetwork();
    if (!net?.blockExplorerDomain) return null;
    const d = net.blockExplorerDomain.trim();
    // The domain comes from the wallet/network (semi-trusted): only accept a
    // clean http(s) origin and reject anything with quotes/spaces/control chars
    // that could break out of an href attribute.
    if (/["'\s<>\\]/.test(d)) return null;
    const withScheme = /^https?:\/\//.test(d) ? d : "https://" + d;
    try {
      const u = new URL(withScheme);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return withScheme.replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  private explorerLink(kind: "tx" | "address", id: string): HTMLAnchorElement | null {
    const base = this.explorerBase();
    if (!base || !isTxHashLike(id)) return null;
    const dest = `${base}/${kind}/${encodeURIComponent(id)}`;
    const a = document.createElement("a");
    a.className = "explorer-link";
    a.href = dest;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "\u2197";
    // Show the full destination so the user can see where the (wallet-supplied)
    // explorer host actually points before following the link (QCB-003).
    a.title = `Open ${dest}`;
    return a;
  }

  /** Inline txHash link (falls back to a short mono span when no explorer). */
  private txLink(txHash: string): string {
    const short = escapeHtml(shortAddr(txHash));
    const base = this.explorerBase();
    // Only build an anchor for a well-formed hash; otherwise render inert text.
    if (!base || !isTxHashLike(txHash)) return `<span class="mono">${short}</span>`;
    const dest = `${base}/tx/${encodeURIComponent(txHash)}`;
    const href = escapeAttr(dest);
    return `<a class="explorer-link" href="${href}" title="${escapeAttr("Open " + dest)}" target="_blank" rel="noopener noreferrer">${short} \u2197</a>`;
  }
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function emptyLine(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = text;
  return d;
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coerce a user-entered value string into a wei hex/decimal string for the wallet. */
function toWeiHex(value: string): string {
  const v = value.trim();
  if (v === "") return "0x0";
  return v; // wallet accepts hex ("0x…") or decimal-wei strings
}

/** Validate the `value (wei)` field: empty, decimal wei, or 0x hex. */
function weiError(value: string): string | null {
  const v = value.trim();
  if (v === "" || /^\d+$/.test(v) || /^0x[0-9a-fA-F]+$/.test(v)) return null;
  return "value (wei): expected a non-negative integer (decimal or 0x hex)";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
