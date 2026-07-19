// Windows-style menu bar (Mini §4.2). Emits action ids; main wires behavior.
// Supports nested submenus (item.children) and dynamic rebuilding via a provider
// so lists like "Open Workspace" and "Recent" stay current.

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  separatorAfter?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
}
export interface MenuDef {
  label: string;
  items: MenuItem[];
}

export const MENUS: MenuDef[] = [
  {
    label: "File",
    items: [
      { id: "file.new", label: "New File", shortcut: "Ctrl+N" },
      { id: "file.newFolder", label: "New Folder\u2026" },
      { id: "file.open", label: "Open File\u2026", shortcut: "Ctrl+O" },
      { id: "file.importZip", label: "Import from Zip\u2026" },
      { id: "file.addNpmDependency", label: "Add NPM Dependency\u2026" },
      { id: "file.download", label: "Download Project (.zip)", separatorAfter: true },
      { id: "file.newWorkspace", label: "New Workspace\u2026" },
      { id: "file.openWorkspace", label: "Open Workspace", children: [] },
      { id: "file.recent", label: "Recent", children: [], separatorAfter: true },
      { id: "file.save", label: "Save", shortcut: "Ctrl+S" },
      { id: "file.rename", label: "Rename\u2026" },
      { id: "file.close", label: "Close File" },
    ],
  },
  {
    label: "Edit",
    items: [
      { id: "edit.undo", label: "Undo", shortcut: "Ctrl+Z" },
      { id: "edit.redo", label: "Redo", shortcut: "Ctrl+Y", separatorAfter: true },
      { id: "edit.find", label: "Find\u2026", shortcut: "Ctrl+F" },
      { id: "edit.replace", label: "Replace\u2026", shortcut: "Ctrl+H" },
      { id: "edit.gotoLine", label: "Go to Line\u2026", shortcut: "Ctrl+G" },
    ],
  },
  {
    label: "View",
    items: [
      { id: "view.explorer", label: "File Explorer" },
      { id: "view.compiler", label: "Compiler Panel" },
      { id: "view.abi", label: "ABI Panel" },
      { id: "view.run", label: "Deploy/Execute Panel" },
      { id: "view.terminal", label: "Terminal" },
    ],
  },
  {
    label: "Build",
    items: [
      { id: "build.compile", label: "Compile Current File", shortcut: "Ctrl+Shift+B" },
      { id: "build.compileAll", label: "Compile All" },
    ],
  },
  {
    label: "Tools",
    items: [{ id: "tools.compilerSettings", label: "Compiler Settings\u2026" }],
  },
  {
    label: "Help",
    items: [
      { id: "help.docs", label: "Documentation" },
      { id: "help.explorer", label: "QuantumScan Block Explorer" },
      { id: "help.shortcuts", label: "Keyboard Shortcuts", separatorAfter: true },
      { id: "help.about", label: "About Platform Builder" },
    ],
  },
];

export class MenuBar {
  readonly el: HTMLElement;
  private onAction: (id: string) => void;
  private provider: () => MenuDef[];

  constructor(onAction: (id: string) => void, provider?: () => MenuDef[]) {
    this.onAction = onAction;
    this.provider = provider ?? (() => MENUS);
    this.el = document.createElement("div");
    this.el.className = "menubar";
    this.build();
    document.addEventListener("click", () => this.closeAll());
  }

  /** Rebuild from the current provider (dynamic lists refresh here). */
  refresh(): void {
    this.build();
  }

  /** Replace the menu definitions with a static list. */
  setMenus(defs: MenuDef[]): void {
    this.provider = () => defs;
    this.build();
  }

  private build(): void {
    this.el.innerHTML = "";
    for (const menu of this.provider()) {
      const wrap = document.createElement("div");
      wrap.className = "menu";
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = menu.label;
      label.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = wrap.classList.contains("open");
        this.closeAll();
        if (!open) wrap.classList.add("open");
      });
      label.addEventListener("mouseenter", () => {
        if (wrap.classList.contains("open")) return;
        if (!this.el.querySelector(".menu.open")) return;
        this.closeAll();
        wrap.classList.add("open");
      });
      const dropdown = document.createElement("div");
      dropdown.className = "dropdown";
      this.renderItems(dropdown, menu.items);
      wrap.append(label, dropdown);
      this.el.appendChild(wrap);
    }
  }

  private renderItems(container: HTMLElement, items: MenuItem[]): void {
    for (const item of items) {
      const hasChildren = Array.isArray(item.children);
      const mi = document.createElement("div");
      mi.className = "mi" + (item.disabled ? " disabled" : "") + (hasChildren ? " has-sub" : "");
      const name = document.createElement("span");
      name.textContent = item.label;
      mi.appendChild(name);

      if (hasChildren) {
        const arrow = document.createElement("span");
        arrow.className = "sc submenu-arrow";
        arrow.textContent = "\u25B8";
        mi.appendChild(arrow);
        const sub = document.createElement("div");
        sub.className = "dropdown sub";
        const kids = item.children!;
        if (kids.length === 0) {
          const empty = document.createElement("div");
          empty.className = "mi disabled";
          empty.textContent = "(none)";
          sub.appendChild(empty);
        } else {
          this.renderItems(sub, kids);
        }
        mi.appendChild(sub);
      } else {
        if (item.shortcut) {
          const sc = document.createElement("span");
          sc.className = "sc";
          sc.textContent = item.shortcut;
          mi.appendChild(sc);
        }
        if (!item.disabled) {
          mi.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeAll();
            this.onAction(item.id);
          });
        }
      }

      container.appendChild(mi);
      if (item.separatorAfter) {
        const sep = document.createElement("div");
        sep.className = "sep";
        container.appendChild(sep);
      }
    }
  }

  private closeAll(): void {
    this.el.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
  }
}
