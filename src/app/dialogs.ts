// Small promise-based modal dialogs (reuse the .modal styles in app.css).

import type { WorkspaceTemplate } from "../files/workspace";
import type { DependencyAudit, DependencyProgress } from "../npm/npmResolver";

/** Prompt for a single line of text. Resolves null on cancel/backdrop/Escape. */
export function promptText(
  title: string,
  label: string,
  initial = "",
  okLabel = "OK",
): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "modal-root";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h3");
    h.textContent = title;

    const field = document.createElement("div");
    field.className = "field";
    const lab = document.createElement("label");
    lab.textContent = label;
    lab.style.minWidth = "80px";
    lab.style.color = "var(--text-muted)";
    const input = document.createElement("input");
    input.type = "text";
    input.value = initial;
    field.append(lab, input);

    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.className = "btn ghost";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn";
    ok.textContent = okLabel;
    actions.append(cancel, ok);

    modal.append(h, field, actions);
    root.append(backdrop, modal);
    document.body.appendChild(root);
    input.focus();
    input.select();

    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      root.remove();
      resolve(value);
    };
    const submit = (): void => {
      const v = input.value.trim();
      done(v ? v : null);
    };
    backdrop.addEventListener("click", () => done(null));
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      else if (e.key === "Escape") done(null);
    });
  });
}

export interface NewWorkspaceResult {
  name: string;
  template: WorkspaceTemplate;
}

/** New-workspace dialog: a name plus a Blank/Samples template choice. */
export function newWorkspaceDialog(): Promise<NewWorkspaceResult | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "modal-root";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h3");
    h.textContent = "New Workspace";

    const field = document.createElement("div");
    field.className = "field";
    const lab = document.createElement("label");
    lab.textContent = "Name";
    lab.style.minWidth = "80px";
    lab.style.color = "var(--text-muted)";
    const input = document.createElement("input");
    input.type = "text";
    input.value = "workspace";
    field.append(lab, input);

    const makeRadio = (value: WorkspaceTemplate, text: string, checked: boolean): HTMLLabelElement => {
      const wrap = document.createElement("label");
      wrap.className = "check";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "ws-template";
      radio.value = value;
      radio.checked = checked;
      wrap.append(radio, document.createTextNode(text));
      return wrap;
    };
    const blank = makeRadio("blank", "Blank (one empty file)", true);
    const samples = makeRadio("samples", "Samples (Storage, ExampleToken, ExampleDetailed)", false);
    const templateRow = document.createElement("div");
    templateRow.style.display = "flex";
    templateRow.style.flexDirection = "column";
    templateRow.style.gap = "6px";
    templateRow.style.margin = "4px 0 10px";
    templateRow.append(blank, samples);

    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.className = "btn ghost";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn";
    ok.textContent = "Create";
    actions.append(cancel, ok);

    modal.append(h, field, templateRow, actions);
    root.append(backdrop, modal);
    document.body.appendChild(root);
    input.focus();
    input.select();

    let settled = false;
    const done = (value: NewWorkspaceResult | null): void => {
      if (settled) return;
      settled = true;
      root.remove();
      resolve(value);
    };
    const submit = (): void => {
      const name = input.value.trim();
      if (!name) {
        done(null);
        return;
      }
      const checked = modal.querySelector<HTMLInputElement>('input[name="ws-template"]:checked');
      const template = (checked?.value as WorkspaceTemplate) ?? "blank";
      done({ name, template });
    };
    backdrop.addEventListener("click", () => done(null));
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      else if (e.key === "Escape") done(null);
    });
  });
}

/** Informational dialog with a single OK button. Body may be text or a node. */
export function alertDialog(title: string, body: string | Node, okLabel = "OK"): Promise<void> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "modal-root";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h3");
    h.textContent = title;
    const p = document.createElement("div");
    p.style.margin = "0 0 12px";
    p.style.fontSize = "12.5px";
    p.style.lineHeight = "1.5";
    p.style.color = "var(--text-muted)";
    if (typeof body === "string") p.textContent = body;
    else p.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "actions";
    const ok = document.createElement("button");
    ok.className = "btn";
    ok.textContent = okLabel;
    actions.append(ok);

    modal.append(h, p, actions);
    root.append(backdrop, modal);
    document.body.appendChild(root);
    ok.focus();

    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      root.remove();
      resolve();
    };
    backdrop.addEventListener("click", done);
    ok.addEventListener("click", done);
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" || e.key === "Enter") done();
      },
      { once: true },
    );
  });
}

export interface ChoiceOption {
  id: string;
  label: string;
  /** Render as the emphasized (non-ghost) button and receive initial focus. */
  primary?: boolean;
}

/**
 * Present a message with several choice buttons (plus Cancel). Resolves the
 * chosen option id, or null on Cancel / backdrop / Escape.
 */
export function choiceDialog(
  title: string,
  message: string,
  options: ChoiceOption[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "modal-root";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h3");
    h.textContent = title;
    const p = document.createElement("div");
    p.style.margin = "0 0 12px";
    p.style.fontSize = "12px";
    p.style.color = "var(--text-muted)";
    p.textContent = message;

    const actions = document.createElement("div");
    actions.className = "actions";

    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      root.remove();
      resolve(value);
    };

    const cancel = document.createElement("button");
    cancel.className = "btn ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => done(null));
    actions.appendChild(cancel);

    let primaryBtn: HTMLButtonElement | null = null;
    for (const opt of options) {
      const b = document.createElement("button");
      b.className = "btn" + (opt.primary ? "" : " ghost");
      b.textContent = opt.label;
      b.addEventListener("click", () => done(opt.id));
      actions.appendChild(b);
      if (opt.primary && !primaryBtn) primaryBtn = b;
    }

    modal.append(h, p, actions);
    root.append(backdrop, modal);
    document.body.appendChild(root);
    (primaryBtn ?? cancel).focus();

    backdrop.addEventListener("click", () => done(null));
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") done(null);
      },
      { once: true },
    );
  });
}

/** Simple confirm dialog. Resolves true on confirm. */
export function confirmDialog(title: string, message: string, okLabel = "OK"): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "modal-root";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h3");
    h.textContent = title;
    const p = document.createElement("div");
    p.style.margin = "0 0 12px";
    p.style.fontSize = "12px";
    p.style.color = "var(--text-muted)";
    p.textContent = message;

    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.className = "btn ghost";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn";
    ok.textContent = okLabel;
    actions.append(cancel, ok);

    modal.append(h, p, actions);
    root.append(backdrop, modal);
    document.body.appendChild(root);
    ok.focus();

    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      root.remove();
      resolve(value);
    };
    backdrop.addEventListener("click", () => done(false));
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") done(false);
      },
      { once: true },
    );
  });
}

export interface ProgressDialogHandle {
  update(status: DependencyProgress): void;
  close(): void;
}

/** Non-dismissible package download progress dialog. */
export function npmProgressDialog(initial: DependencyProgress): ProgressDialogHandle {
  const root = document.createElement("div");
  root.className = "modal-root";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal npm-progress-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const h = document.createElement("h3");
  h.textContent = "NPM Dependency";
  const pkg = document.createElement("div");
  pkg.className = "npm-package-name";
  const phase = document.createElement("div");
  phase.className = "npm-progress-phase";
  const progress = document.createElement("progress");
  progress.max = 100;
  const detail = document.createElement("div");
  detail.className = "npm-progress-detail";
  modal.append(h, pkg, phase, progress, detail);
  root.append(backdrop, modal);
  document.body.appendChild(root);

  const update = (status: DependencyProgress): void => {
    pkg.textContent = `${status.packageName}@${status.version}`;
    phase.textContent = status.phase;
    if (status.total && status.total > 0) {
      progress.value = Math.min(100, (status.received ?? 0) / status.total * 100);
      detail.textContent = `${formatDialogBytes(status.received ?? 0)} / ${formatDialogBytes(status.total)}`;
    } else {
      progress.removeAttribute("value");
      detail.textContent = status.received ? `${formatDialogBytes(status.received)} received` : "";
    }
  };
  update(initial);
  return { update, close: () => root.remove() };
}

/**
 * Explicit dependency-risk consent. "No" is intentionally highlighted and
 * focused so Enter, Escape, or backdrop dismissal all choose the safe default.
 */
export function confirmNpmRisk(audit: DependencyAudit): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "modal-root";
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal npm-risk-modal";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");

    const h = document.createElement("h3");
    h.textContent = "Dependency security warning";
    const intro = document.createElement("p");
    intro.textContent = audit.unavailable
      ? `The vulnerability audit for ${audit.packageName}@${audit.version} could not be completed.`
      : `${audit.packageName}@${audit.version} has ${audit.advisories.length} known vulnerability advisory/advisories.`;
    const explanation = document.createElement("p");
    explanation.textContent =
      "The package has not been downloaded. Continue only if you understand and accept this risk.";
    modal.append(h, intro);

    if (audit.unavailable) {
      const reason = document.createElement("div");
      reason.className = "npm-risk-detail";
      reason.textContent = audit.unavailable;
      modal.appendChild(reason);
    } else {
      const list = document.createElement("ul");
      list.className = "npm-advisories";
      for (const advisory of audit.advisories.slice(0, 20)) {
        const item = document.createElement("li");
        item.textContent = `[${advisory.severity}] ${advisory.id}: ${advisory.summary}`;
        list.appendChild(item);
      }
      if (audit.advisories.length > 20) {
        const item = document.createElement("li");
        item.textContent = `…and ${audit.advisories.length - 20} more`;
        list.appendChild(item);
      }
      modal.appendChild(list);
    }
    modal.appendChild(explanation);

    const actions = document.createElement("div");
    actions.className = "actions";
    const yes = document.createElement("button");
    yes.className = "btn ghost";
    yes.textContent = "Yes, continue";
    const no = document.createElement("button");
    no.className = "btn";
    no.textContent = "No";
    actions.append(yes, no);
    modal.appendChild(actions);
    root.append(backdrop, modal);
    document.body.appendChild(root);
    no.focus();

    let settled = false;
    const done = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      root.remove();
      resolve(answer);
    };
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    backdrop.addEventListener("click", () => done(false));
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") done(false);
      },
      { once: true },
    );
  });
}

function formatDialogBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
