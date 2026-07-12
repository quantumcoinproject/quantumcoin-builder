// Small promise-based modal dialogs (reuse the .modal styles in app.css).

import type { WorkspaceTemplate } from "../files/workspace";

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
