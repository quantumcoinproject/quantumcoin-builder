/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CompileResult, CompiledContract } from "../compiler/types";
import { buildCatalog, encodeCallValues, type AbiCatalog } from "../abi/abi";
import { createArgControl, createModeToggle, getArgMode, type ArgControl } from "../abi/argControl";
import { isSdkReady } from "../abi/sdk";
import {
  copyToClipboard,
  downloadAbiJson,
  downloadArtifactsZip,
  downloadHex,
} from "../export/download";
import { RunPanel } from "../dapp/runPanel";

export interface SidePanelHooks {
  onCompile: () => void;
  log: (msg: string, kind?: "info" | "success" | "warning" | "error") => void;
}

type Tab = "compiler" | "abi" | "run";

export class SidePanel {
  readonly el: HTMLElement;
  private hooks: SidePanelHooks;
  private tab: Tab = "compiler";
  private result: CompileResult | null = null;
  private selected: string | null = null;
  private pragmaOk = true;
  private body!: HTMLDivElement;
  private tabsEl!: HTMLDivElement;
  private runPanel: RunPanel;

  constructor(hooks: SidePanelHooks) {
    this.hooks = hooks;
    this.el = document.createElement("aside");
    this.el.className = "side";
    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "ptabs";
    this.body = document.createElement("div");
    this.body.className = "pbody";
    this.el.append(this.tabsEl, this.body);
    this.runPanel = new RunPanel({ log: hooks.log });
    this.renderTabs();
    this.render();
  }

  setResult(result: CompileResult): void {
    this.result = result;
    const names = result.contracts.map((c) => c.contractName);
    if (!this.selected || !names.includes(this.selected)) {
      this.selected = names[0] ?? null;
    }
    this.runPanel.setResult(result);
    this.render();
  }

  /** Reset deploy/execute session state (deployed instances, compiled result). */
  resetRun(): void {
    this.result = null;
    this.selected = null;
    this.runPanel.reset();
    if (this.tab !== "run") this.render();
  }

  setPragmaOk(ok: boolean): void {
    this.pragmaOk = ok;
    if (this.tab === "compiler") this.render();
  }

  showTab(tab: Tab): void {
    this.tab = tab;
    this.renderTabs();
    this.render();
  }

  private currentContract(): CompiledContract | null {
    if (!this.result) return null;
    return this.result.contracts.find((c) => c.contractName === this.selected) ?? null;
  }

  private renderTabs(): void {
    this.tabsEl.innerHTML = "";
    const labels: Record<Tab, string> = { compiler: "Compiler", abi: "ABI", run: "Deploy/Execute" };
    (["compiler", "abi", "run"] as Tab[]).forEach((t) => {
      const b = document.createElement("button");
      b.className = "ptab" + (this.tab === t ? " active" : "");
      b.textContent = labels[t];
      b.addEventListener("click", () => this.showTab(t));
      this.tabsEl.appendChild(b);
    });
  }

  private render(): void {
    this.body.innerHTML = "";
    if (this.tab === "compiler") this.renderCompiler();
    else if (this.tab === "abi") this.renderAbi();
    else this.body.appendChild(this.runPanel.el);
  }

  private contractSelect(): HTMLElement {
    const wrap = document.createElement("div");
    const label = document.createElement("div");
    label.className = "field-label";
    label.textContent = "Contract";
    const select = document.createElement("select");
    select.className = "select";
    const names = this.result?.contracts.map((c) => c.contractName) ?? [];
    if (names.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "(compile to list contracts)";
      select.disabled = true;
      select.appendChild(opt);
    } else {
      for (const n of names) {
        const opt = document.createElement("option");
        opt.value = n;
        opt.textContent = n;
        if (n === this.selected) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        this.selected = select.value;
        this.render();
      });
    }
    wrap.append(label, select);
    return wrap;
  }

  // ---- Compiler pane (Mini §8.3) ----
  private renderCompiler(): void {
    const f = document.createDocumentFragment();

    const verLabel = document.createElement("div");
    verLabel.className = "field-label";
    verLabel.textContent = "Solidity version";
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = "0.7.6 (fixed)";
    f.append(verLabel, pill);

    f.appendChild(this.contractSelect());

    const status = document.createElement("div");
    status.className = "status-row";
    if (this.result) {
      const e = this.result.errorCount;
      const w = this.result.warningCount;
      status.innerHTML =
        `<span class="${e ? "errc" : "ok"}">${e ? "\u2715" : "\u2713"} ${e} error${e === 1 ? "" : "s"}</span>` +
        `<span class="${w ? "warnc" : "muted"}">\u26A0 ${w} warning${w === 1 ? "" : "s"}</span>`;
    } else {
      status.innerHTML = `<span class="muted">Not compiled yet</span>`;
    }
    f.appendChild(status);

    const compileBtn = document.createElement("button");
    compileBtn.className = "btn block";
    compileBtn.textContent = "\u25B6 Compile Current File";
    compileBtn.disabled = !this.pragmaOk;
    compileBtn.title = this.pragmaOk ? "" : "Fix the pragma (0.7.6) before compiling";
    compileBtn.addEventListener("click", () => this.hooks.onCompile());
    f.appendChild(compileBtn);

    const c = this.currentContract();
    const hasArtifacts = !!c && !!c.bytecode;

    const artLabel = document.createElement("div");
    artLabel.className = "field-label";
    artLabel.textContent = "Artifacts";
    f.appendChild(artLabel);

    if (!hasArtifacts) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Compile successfully to enable artifact export.";
      f.appendChild(empty);
    } else {
      f.appendChild(this.artifactRow("ABI", () => copyToClipboard(JSON.stringify(c!.abi)), () => {
        const fn = downloadAbiJson(c!.contractName, c!.abi);
        this.hooks.log(`Downloaded ${fn}`, "success");
      }, "Download .json"));

      f.appendChild(this.artifactRow("Creation bytecode", () => copyToClipboard(c!.bytecode), () => {
        const fn = downloadHex(c!.contractName, "creation", c!.bytecode);
        this.hooks.log(`Downloaded ${fn} (${hexBytes(c!.bytecode)} bytes)`, "success");
      }, "Download .hex"));
      f.appendChild(this.hexPreview(c!.bytecode));

      f.appendChild(this.artifactRow("Runtime bytecode", () => copyToClipboard(c!.deployedBytecode), () => {
        const fn = downloadHex(c!.contractName, "runtime", c!.deployedBytecode);
        this.hooks.log(`Downloaded ${fn} (${hexBytes(c!.deployedBytecode)} bytes)`, "success");
      }, "Download .hex"));
      f.appendChild(this.hexPreview(c!.deployedBytecode));

      const zipBtn = document.createElement("button");
      zipBtn.className = "btn block";
      zipBtn.style.marginTop = "14px";
      zipBtn.textContent = "\u2B07 Download All Artifacts (.zip)";
      zipBtn.addEventListener("click", () => {
        const fn = downloadArtifactsZip(c!);
        this.hooks.log(`Downloaded ${fn}`, "success");
      });
      f.appendChild(zipBtn);
    }

    this.body.appendChild(f);
  }

  private artifactRow(name: string, onCopy: () => void, onDownload: () => void, dlLabel: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "art-row";
    const n = document.createElement("span");
    n.className = "name";
    n.textContent = name;
    const actions = document.createElement("span");
    actions.className = "actions";
    const copy = document.createElement("button");
    copy.className = "btn ghost";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void onCopy();
      this.hooks.log(`Copied ${name} to clipboard`);
    });
    const dl = document.createElement("button");
    dl.className = "btn ghost";
    dl.textContent = dlLabel;
    dl.addEventListener("click", onDownload);
    actions.append(copy, dl);
    row.append(n, actions);
    return row;
  }

  private hexPreview(hex: string): HTMLElement {
    const pre = document.createElement("div");
    pre.className = "hex-preview";
    pre.textContent = hex.length > 140 ? hex.slice(0, 140) + "\u2026" : hex;
    return pre;
  }

  // ---- ABI pane (Mini §7.3) ----
  private renderAbi(): void {
    const f = document.createDocumentFragment();

    if (!isSdkReady()) {
      const warn = document.createElement("div");
      warn.className = "empty";
      warn.innerHTML =
        "QuantumCoin SDK not initialized. The ABI panel uses <span class='mono'>quantumcoin</span> for parsing, selectors, and calldata encoding (\u00a77).";
      f.appendChild(warn);
      this.body.appendChild(f);
      return;
    }

    f.appendChild(this.contractSelect());

    // Simple/Detailed argument-input mode (shared with the Deploy/Execute tab).
    const modeBar = document.createElement("div");
    modeBar.className = "mode-bar";
    const modeLabel = document.createElement("span");
    modeLabel.className = "field-label";
    modeLabel.textContent = "Inputs";
    modeBar.append(modeLabel, createModeToggle(() => this.render()));
    f.appendChild(modeBar);

    const c = this.currentContract();
    if (!c) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.style.marginTop = "12px";
      empty.textContent = "Compile a contract to inspect its ABI.";
      f.appendChild(empty);
      this.body.appendChild(f);
      return;
    }

    let catalog: AbiCatalog;
    try {
      catalog = buildCatalog(c.abi);
    } catch (err) {
      const e = document.createElement("div");
      e.className = "empty errc";
      e.textContent = "Invalid ABI: " + (err instanceof Error ? err.message : String(err));
      f.appendChild(e);
      this.body.appendChild(f);
      this.hooks.log("ABI parse failure: " + (err instanceof Error ? err.message : String(err)), "error");
      return;
    }

    f.appendChild(sectionLabel("Read functions"));
    if (catalog.read.length === 0) f.appendChild(emptyLine("(none)"));
    for (const fn of catalog.read) {
      const div = document.createElement("div");
      div.className = "fn";
      const ret = fn.outputs.length ? " \u2192 " + fn.outputs.map((o) => escape(o.type)).join(", ") : "";
      div.innerHTML = `<div class="sig">${escape(fn.name)}(${sigParams(fn.inputs)})${ret}</div>` +
        `<div class="meta">selector: ${escape(fn.selector || "n/a")}</div>`;
      f.appendChild(div);
    }

    f.appendChild(sectionLabel("Write functions"));
    if (catalog.write.length === 0) f.appendChild(emptyLine("(none)"));
    for (const fn of catalog.write) {
      f.appendChild(this.writeFn(catalog, fn));
    }

    f.appendChild(sectionLabel("Events"));
    if (catalog.events.length === 0) f.appendChild(emptyLine("(none)"));
    for (const ev of catalog.events) {
      const div = document.createElement("div");
      div.className = "fn";
      div.innerHTML = `<div class="sig">${escape(ev.signature)}</div><div class="meta">topic0: ${escape(ev.topic0 || "n/a")}</div>`;
      f.appendChild(div);
    }

    f.appendChild(sectionLabel("ABI JSON"));
    const abiRow = this.artifactRow("SDK-validated", () => copyToClipboard(JSON.stringify(c.abi)), () => {
      const name = downloadAbiJson(c.contractName, c.abi);
      this.hooks.log(`Downloaded ${name}`, "success");
    }, "Download .json");
    f.appendChild(abiRow);

    this.body.appendChild(f);
  }

  private writeFn(catalog: AbiCatalog, fn: AbiCatalog["write"][number]): HTMLElement {
    const div = document.createElement("div");
    div.className = "fn";
    div.innerHTML = `<div class="sig">${escape(fn.name)}(${sigParams(fn.inputs)})</div>`;

    const calldata = document.createElement("div");
    calldata.className = "meta";

    /** Collect values; `mark=false` keeps the live preview from flagging untouched fields. */
    const collect = (mark: boolean): { values?: unknown[]; error?: string } => {
      const values: unknown[] = [];
      let error: string | undefined;
      for (const c of controls) {
        const r = c.read(mark);
        if (!r.ok) error ??= r.error ?? "invalid argument";
        else values.push(r.value);
      }
      return error != null ? { error } : { values };
    };

    const recompute = (): void => {
      const r = collect(false);
      if (r.error != null) {
        calldata.classList.remove("errc");
        calldata.textContent = "calldata: (enter valid arguments)";
        return;
      }
      try {
        const data = encodeCallValues(catalog, fn.name, r.values!);
        calldata.classList.remove("errc");
        calldata.innerHTML = `calldata: ${escape(data)}`;
      } catch {
        calldata.classList.add("errc");
        calldata.textContent = "calldata: (cannot encode \u2014 check arguments)";
      }
    };

    const controls: ArgControl[] = fn.inputs.map((p) =>
      createArgControl(p, { mode: getArgMode(), onChange: recompute }),
    );
    for (const c of controls) div.appendChild(c.el);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `selector: ${fn.selector || "n/a"}`;
    div.append(meta, calldata);

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn ghost";
    copyBtn.style.marginTop = "6px";
    copyBtn.textContent = "Copy calldata";
    copyBtn.addEventListener("click", () => {
      const r = collect(true);
      if (r.error != null) {
        this.hooks.log(`Cannot encode ${fn.name}: ${r.error}`, "error");
        return;
      }
      try {
        const data = encodeCallValues(catalog, fn.name, r.values!);
        void copyToClipboard(data);
        this.hooks.log(`Copied calldata for ${fn.name}`);
      } catch {
        this.hooks.log(`Cannot encode ${fn.name}: check arguments`, "error");
      }
    });
    div.appendChild(copyBtn);

    recompute();
    return div;
  }
}

function sectionLabel(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "field-label";
  d.textContent = text;
  return d;
}
function emptyLine(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = text;
  return d;
}
function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function sigParams(inputs: { type: string; name: string }[]): string {
  return inputs.map((i) => `${escape(i.type)} ${escape(i.name)}`).join(", ");
}
function hexBytes(hex: string): number {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Math.floor(h.length / 2);
}
