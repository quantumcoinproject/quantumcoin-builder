/*
 * Typed ABI argument controls (Deploy/Execute + ABI tabs).
 *
 * Two render modes behind one API:
 * - "simple"   — Remix-like: a single plain text field per parameter; arrays
 *                and tuples are typed as bracketed JSON (e.g. `[1,2,[[3,"x"]]]`).
 * - "detailed" — type-aware widgets: digit-filtered numeric inputs (with an
 *                ETH<->wei converter on uint256), a true/false select for
 *                bools, monospace hex fields with type badges for
 *                address/bytes, dynamic add/remove rows for arrays, and
 *                nested sub-forms for tuples/structs.
 *
 * Both modes validate with `validateAbiValue` and produce the same structured
 * JS values consumed by the value-based encoders in abi.ts.
 */

import { validateAbiValue, parseAbiValue, type AbiParam } from "./abi";
import { parseUnits, formatUnits } from "./units";

export type ArgMode = "simple" | "detailed";

const LS_MODE_KEY = "qcpbm.argMode";

export function getArgMode(): ArgMode {
  try {
    return localStorage.getItem(LS_MODE_KEY) === "detailed" ? "detailed" : "simple";
  } catch {
    return "simple";
  }
}

export function setArgMode(mode: ArgMode): void {
  try {
    localStorage.setItem(LS_MODE_KEY, mode);
  } catch {
    /* ignore quota/availability errors */
  }
}

/** Segmented `Simple | Detailed` toggle; reflects and updates the shared mode. */
export function createModeToggle(onChange: (mode: ArgMode) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mode-toggle";
  (["simple", "detailed"] as ArgMode[]).forEach((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mode-opt" + (getArgMode() === m ? " active" : "");
    b.textContent = m === "simple" ? "Simple" : "Detailed";
    b.title = m === "simple"
      ? "One text field per parameter (arrays/tuples as [1, 2, ...])"
      : "Type-specific inputs with add/remove rows for arrays";
    b.addEventListener("click", () => {
      if (getArgMode() === m) return;
      setArgMode(m);
      wrap.querySelectorAll(".mode-opt").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      onChange(m);
    });
    wrap.appendChild(b);
  });
  return wrap;
}

export interface ArgReadResult {
  ok: boolean;
  value?: unknown;
  /** First offending field's validation message (prefixed with the arg name). */
  error?: string;
}

export interface ArgControl {
  el: HTMLElement;
  /** Validate + collect the value. `mark=false` skips error UI (live previews). */
  read(mark?: boolean): ArgReadResult;
}

export interface ArgControlOptions {
  mode?: ArgMode;
  onChange?: () => void;
}

export function createArgControl(param: AbiParam, opts: ArgControlOptions = {}): ArgControl {
  const mode = opts.mode ?? getArgMode();
  return build(param, mode, opts.onChange, param.name);
}

// ---- Internals ----

function build(
  param: AbiParam,
  mode: ArgMode,
  onChange: (() => void) | undefined,
  displayName: string | null,
): ArgControl {
  if (mode === "simple") return textControl(param, mode, onChange, displayName, /* parse */ true);

  const arrayMatch = param.type.match(/^(.*)\[(\d*)\]$/);
  if (arrayMatch) {
    const base: AbiParam = { name: param.name, type: arrayMatch[1]!, components: param.components };
    const fixedLen = arrayMatch[2] ? Number(arrayMatch[2]) : null;
    return arrayControl(base, param, fixedLen, onChange, displayName);
  }
  if (param.type.startsWith("tuple")) return tupleControl(param, onChange, displayName);
  if (param.type === "bool") return boolControl(param, onChange, displayName);
  return textControl(param, mode, onChange, displayName, /* parse */ false);
}

/**
 * Single text field. With `parse=true` (Simple mode) the value is parsed via
 * `parseAbiValue` (so arrays/tuples become real arrays); otherwise (Detailed
 * scalar leaf) the string is returned as-is for the SDK encoder.
 */
function textControl(
  param: AbiParam,
  mode: ArgMode,
  onChange: (() => void) | undefined,
  displayName: string | null,
  parse: boolean,
): ArgControl {
  const el = container();
  const label = displayName != null ? makeLabel(displayName, param.type, mode) : null;
  if (label) el.appendChild(label);

  const isInt = /^u?int\d*$/.test(param.type);
  const signed = /^int\d*$/.test(param.type);
  const isHex = /^bytes(\d+)?$/.test(param.type) || param.type === "address";

  const input = document.createElement("input");
  input.className =
    "arg-input " + (mode === "simple" ? "arg-simple" : "arg-detailed" + (isHex ? " arg-hex" : ""));
  input.placeholder = placeholderFor(param.type);
  if (isInt) input.setAttribute("inputmode", "numeric");

  // Detailed uint256 fields get an ETH<->wei converter in the label row.
  if (label && mode === "detailed" && (param.type === "uint256" || param.type === "uint")) {
    label.appendChild(converterButton(input));
  }

  const err = errLine();
  el.append(input, err);

  const showError = (message: string | null): void => {
    input.classList.toggle("invalid", message != null);
    err.textContent = message ?? "";
    err.style.display = message ? "" : "none";
  };

  input.addEventListener("input", () => {
    // Detailed integers are digit-filtered as the user types.
    if (mode === "detailed" && isInt) {
      const cleaned = signed
        ? input.value.replace(/[^0-9-]/g, "").replace(/(?!^)-/g, "")
        : input.value.replace(/[^0-9]/g, "");
      if (cleaned !== input.value) input.value = cleaned;
    }
    // Only surface an error once the user has typed something.
    showError(input.value === "" ? null : validateAbiValue(param.type, input.value));
    onChange?.();
  });

  const fail = (message: string, mark: boolean): ArgReadResult => {
    if (mark) showError(message);
    return { ok: false, error: `${param.name}: ${message}` };
  };

  const read = (mark = true): ArgReadResult => {
    const message = validateAbiValue(param.type, input.value);
    if (message != null) return fail(message, mark);
    if (parse) {
      try {
        const value = parseAbiValue(param.type, input.value);
        if (mark) showError(null);
        return { ok: true, value };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), mark);
      }
    }
    if (mark) showError(null);
    // Scalar leaf: strings keep raw text, everything else is trimmed.
    return { ok: true, value: param.type === "string" ? input.value : input.value.trim() };
  };

  return { el, read };
}

function boolControl(
  param: AbiParam,
  onChange: (() => void) | undefined,
  displayName: string | null,
): ArgControl {
  const el = container();
  if (displayName != null) el.appendChild(makeLabel(displayName, param.type, "detailed"));
  const select = document.createElement("select");
  select.className = "select arg-bool";
  for (const v of ["false", "true"]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onChange?.());
  el.appendChild(select);
  return { el, read: () => ({ ok: true, value: select.value === "true" }) };
}

function tupleControl(
  param: AbiParam,
  onChange: (() => void) | undefined,
  displayName: string | null,
): ArgControl {
  const el = container();
  if (displayName != null) el.appendChild(makeLabel(displayName, param.type, "detailed"));
  const box = document.createElement("div");
  box.className = "tuple-control";
  const children = (param.components ?? []).map((c) => build(c, "detailed", onChange, c.name));
  for (const c of children) box.appendChild(c.el);
  el.appendChild(box);

  const read = (mark = true): ArgReadResult => {
    const values: unknown[] = [];
    let error: string | undefined;
    for (const c of children) {
      const r = c.read(mark);
      if (!r.ok) error ??= r.error;
      else values.push(r.value);
    }
    return error != null ? { ok: false, error } : { ok: true, value: values };
  };
  return { el, read };
}

function arrayControl(
  base: AbiParam,
  arrayParam: AbiParam,
  fixedLen: number | null,
  onChange: (() => void) | undefined,
  displayName: string | null,
): ArgControl {
  const el = container();
  if (displayName != null) el.appendChild(makeLabel(displayName, arrayParam.type, "detailed"));
  const box = document.createElement("div");
  box.className = "array-control";
  const rowsEl = document.createElement("div");
  rowsEl.className = "array-rows";
  box.appendChild(rowsEl);

  const rows: { el: HTMLElement; control: ArgControl }[] = [];

  const addRow = (): void => {
    const row = document.createElement("div");
    row.className = "array-row";
    const control = build(
      { ...base, name: `${base.name}[${rows.length}]` },
      "detailed",
      onChange,
      `[${rows.length}]`,
    );
    row.appendChild(control.el);
    const entry = { el: row, control };
    if (fixedLen == null) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "array-remove";
      rm.textContent = "\u2715";
      rm.title = "Remove item";
      rm.addEventListener("click", () => {
        rows.splice(rows.indexOf(entry), 1);
        row.remove();
        onChange?.();
      });
      row.appendChild(rm);
    }
    rows.push(entry);
    rowsEl.appendChild(row);
  };

  const initial = fixedLen ?? 0;
  for (let i = 0; i < initial; i++) addRow();

  if (fixedLen == null) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn ghost array-add";
    add.textContent = "+ Add item";
    add.addEventListener("click", () => {
      addRow();
      onChange?.();
    });
    box.appendChild(add);
  }

  el.appendChild(box);

  const read = (mark = true): ArgReadResult => {
    const values: unknown[] = [];
    let error: string | undefined;
    for (const r of rows) {
      const res = r.control.read(mark);
      if (!res.ok) error ??= res.error;
      else values.push(res.value);
    }
    return error != null ? { ok: false, error } : { ok: true, value: values };
  };
  return { el, read };
}

// ---- ETH <-> wei converter (Detailed uint256) ----

function converterButton(target: HTMLInputElement): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "convert-btn";
  btn.textContent = "\u21C4 wei";
  btn.title = "Convert coins (ETH unit) to wei";
  btn.addEventListener("click", () => openConverter(target));
  return btn;
}

function openConverter(target: HTMLInputElement): void {
  const root = document.createElement("div");
  root.className = "modal-root";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  const h = document.createElement("h3");
  h.textContent = "Convert to wei";

  const makeField = (labelText: string): HTMLInputElement => {
    const field = document.createElement("div");
    field.className = "field";
    const lab = document.createElement("label");
    lab.textContent = labelText;
    lab.style.minWidth = "110px";
    lab.style.color = "var(--text-muted)";
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("inputmode", "decimal");
    field.append(lab, input);
    modal.appendChild(field);
    return input;
  };

  modal.appendChild(h);
  const eth = makeField("coins (ETH unit)");
  const wei = makeField("wei");

  const hint = document.createElement("div");
  hint.className = "arg-err";
  hint.style.display = "none";
  modal.appendChild(hint);

  const actions = document.createElement("div");
  actions.className = "actions";
  const cancel = document.createElement("button");
  cancel.className = "btn ghost";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "btn";
  ok.textContent = "OK";
  actions.append(cancel, ok);
  modal.appendChild(actions);

  const setState = (error: string | null): void => {
    hint.textContent = error ?? "";
    hint.style.display = error ? "" : "none";
    ok.disabled = error != null || !/^\d+$/.test(wei.value.trim());
  };

  // Prefill from the target field when it already holds an integer wei value.
  if (/^\d+$/.test(target.value.trim())) {
    wei.value = target.value.trim();
    try {
      eth.value = formatUnits(wei.value);
    } catch {
      /* leave eth empty */
    }
  }
  setState(null);

  eth.addEventListener("input", () => {
    if (eth.value.trim() === "") {
      wei.value = "";
      setState(null);
      return;
    }
    try {
      wei.value = parseUnits(eth.value);
      setState(null);
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    }
  });

  wei.addEventListener("input", () => {
    if (wei.value.trim() === "") {
      eth.value = "";
      setState(null);
      return;
    }
    try {
      eth.value = formatUnits(wei.value);
      setState(null);
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    }
  });

  const close = (): void => root.remove();
  backdrop.addEventListener("click", close);
  cancel.addEventListener("click", close);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  ok.addEventListener("click", () => {
    const v = wei.value.trim();
    if (!/^\d+$/.test(v)) return;
    target.value = v;
    // Re-run the field's filtering/validation/live-preview pipeline.
    target.dispatchEvent(new Event("input", { bubbles: true }));
    close();
  });

  root.append(backdrop, modal);
  document.body.appendChild(root);
  eth.focus();
}

// ---- Shared DOM helpers ----

function container(): HTMLElement {
  const el = document.createElement("div");
  el.className = "arg-control";
  return el;
}

function errLine(): HTMLElement {
  const err = document.createElement("div");
  err.className = "arg-err";
  err.style.display = "none";
  return err;
}

/** Simple: muted `name: type` text. Detailed: name + a type badge pill. */
function makeLabel(name: string, type: string, mode: ArgMode): HTMLElement {
  const isBytes = /^bytes(\d+)?$/.test(type);
  if (mode === "simple") {
    const lab = document.createElement("div");
    lab.className = "meta";
    lab.textContent = `${name}: ${type}${isBytes ? " (hex)" : ""}`;
    return lab;
  }
  const row = document.createElement("div");
  row.className = "arg-label";
  const n = document.createElement("span");
  n.className = "arg-name";
  n.textContent = name;
  const badge = document.createElement("span");
  badge.className = "type-badge";
  badge.textContent = isBytes ? `${type} hex` : type;
  row.append(n, badge);
  return row;
}

function placeholderFor(type: string): string {
  const bytesN = type.match(/^bytes(\d+)$/);
  if (bytesN) return `hex: 0x + ${Number(bytesN[1]) * 2} hex chars`;
  if (type === "bytes") return "hex: 0x\u2026 (even number of hex digits)";
  if (type === "address") return "0x + 64 hex chars";
  if (type === "bool") return "true or false";
  if (type.endsWith("]")) return `${type} e.g. [1, 2]`;
  if (type.startsWith("tuple")) return `${type} e.g. [val1, val2]`;
  return type;
}
