import type { Workspace } from "./workspace";
import { showContextMenu } from "./contextMenu";

export interface ExplorerHooks {
  onOpen: (path: string) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onDuplicate: (path: string) => void;
  onRenameFolder: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  onSwitchWorkspace: (id: string) => void;
  onNewWorkspace: () => void;
  onRenameWorkspace: (id: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onCloneWorkspace: (id: string) => void;
}

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  files: string[];
}

/** Collapsible left drawer file explorer with nested folders and workspaces. */
export class Explorer {
  readonly el: HTMLElement;
  private ws: Workspace;
  private hooks: ExplorerHooks;
  private tree!: HTMLDivElement;
  private wsDropdownOpen = false;
  private expanded = new Set<string>();
  private seenFolder = new Set<string>();

  constructor(ws: Workspace, hooks: ExplorerHooks) {
    this.ws = ws;
    this.hooks = hooks;
    this.el = document.createElement("aside");
    this.el.className = "explorer";

    const head = document.createElement("div");
    head.className = "panel-head";
    const title = document.createElement("span");
    title.textContent = "Explorer";
    const newFile = document.createElement("button");
    newFile.className = "icon-btn";
    newFile.title = "New file";
    newFile.textContent = "+";
    newFile.addEventListener("click", () => this.hooks.onNewFile(""));
    const newFolder = document.createElement("button");
    newFolder.className = "icon-btn";
    newFolder.title = "New folder";
    newFolder.textContent = "\uD83D\uDCC1";
    newFolder.addEventListener("click", () => this.hooks.onNewFolder(""));
    const actions = document.createElement("div");
    actions.className = "explorer-actions";
    actions.append(newFolder, newFile);
    head.append(title, actions);

    this.tree = document.createElement("div");
    this.tree.className = "tree";
    this.tree.addEventListener("contextmenu", (e) => {
      // Right-click on empty area -> root actions.
      if (e.target === this.tree) {
        showContextMenu(e, [
          { label: "New File", onClick: () => this.hooks.onNewFile("") },
          { label: "New Folder", onClick: () => this.hooks.onNewFolder("") },
        ]);
      }
    });

    this.el.append(head, this.tree);
    this.render();
    ws.subscribe(() => this.render());

    // Close the workspace dropdown on any outside click.
    document.addEventListener("click", (e) => {
      if (!this.wsDropdownOpen) return;
      if (!(e.target instanceof Node) || !this.el.contains(e.target)) {
        this.wsDropdownOpen = false;
        this.render();
      }
    });
  }

  render(): void {
    this.tree.innerHTML = "";
    this.renderWorkspaceBar();

    const root = this.buildTree();
    // Auto-expand folders on first render so contents are visible.
    for (const f of this.ws.listFolders()) {
      if (!this.seenFolder.has(f)) {
        this.expanded.add(f);
        this.seenFolder.add(f);
      }
    }
    this.renderFolderChildren(root, 0);
  }

  // ---- Workspace switcher ----

  private renderWorkspaceBar(): void {
    const bar = document.createElement("div");
    bar.className = "ws-bar";

    const btn = document.createElement("button");
    btn.className = "ws-switch";
    const active = this.ws.activeWorkspace();
    btn.innerHTML = `<span class="ws-caret">\u25BE</span><span class="ws-name"></span>`;
    btn.querySelector<HTMLSpanElement>(".ws-name")!.textContent = active.name;
    btn.title = "Switch workspace";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.wsDropdownOpen = !this.wsDropdownOpen;
      this.render();
    });
    btn.addEventListener("contextmenu", (e) => {
      showContextMenu(e, [
        { label: "Rename Workspace", onClick: () => this.hooks.onRenameWorkspace(active.id) },
        { label: "Clone Workspace", onClick: () => this.hooks.onCloneWorkspace(active.id) },
        { label: "Delete Workspace", onClick: () => this.hooks.onDeleteWorkspace(active.id) },
      ]);
    });
    bar.appendChild(btn);

    if (this.wsDropdownOpen) {
      const list = document.createElement("div");
      list.className = "ws-list";
      for (const w of this.ws.listWorkspaces()) {
        const item = document.createElement("div");
        item.className = "ws-item" + (w.id === active.id ? " active" : "");
        const label = document.createElement("span");
        label.className = "ws-item-name";
        label.textContent = w.name;
        label.addEventListener("click", () => {
          this.wsDropdownOpen = false;
          if (w.id !== active.id) this.hooks.onSwitchWorkspace(w.id);
          else this.render();
        });
        item.appendChild(label);
        item.addEventListener("contextmenu", (e) => {
          showContextMenu(e, [
            { label: "Rename Workspace", onClick: () => this.hooks.onRenameWorkspace(w.id) },
            { label: "Clone Workspace", onClick: () => this.hooks.onCloneWorkspace(w.id) },
            { label: "Delete Workspace", onClick: () => this.hooks.onDeleteWorkspace(w.id) },
          ]);
        });
        list.appendChild(item);
      }
      const sep = document.createElement("div");
      sep.className = "ws-item-sep";
      list.appendChild(sep);
      const add = document.createElement("div");
      add.className = "ws-item ws-item-new";
      add.textContent = "+ New Workspace\u2026";
      add.addEventListener("click", () => {
        this.wsDropdownOpen = false;
        this.hooks.onNewWorkspace();
      });
      list.appendChild(add);
      bar.appendChild(list);
    }

    this.tree.appendChild(bar);
  }

  // ---- Tree building ----

  private buildTree(): FolderNode {
    const root: FolderNode = { name: "", path: "", folders: new Map(), files: [] };
    const ensure = (path: string): FolderNode => {
      if (!path) return root;
      const parts = path.split("/");
      let node = root;
      let acc = "";
      for (const seg of parts) {
        acc = acc ? `${acc}/${seg}` : seg;
        let child = node.folders.get(seg);
        if (!child) {
          child = { name: seg, path: acc, folders: new Map(), files: [] };
          node.folders.set(seg, child);
        }
        node = child;
      }
      return node;
    };
    for (const folder of this.ws.listFolders()) ensure(folder);
    for (const file of this.ws.list()) {
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      ensure(dir).files.push(file);
    }
    return root;
  }

  private renderFolderChildren(node: FolderNode, depth: number): void {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of folders) {
      this.renderFolderRow(f, depth);
      if (this.expanded.has(f.path)) this.renderFolderChildren(f, depth + 1);
    }
    const files = [...node.files].sort((a, b) => baseName(a).localeCompare(baseName(b)));
    for (const file of files) this.renderFileRow(file, depth);
  }

  private renderFolderRow(node: FolderNode, depth: number): void {
    const row = document.createElement("div");
    row.className = "row folder";
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const isOpen = this.expanded.has(node.path);
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = isOpen ? "\u25BE" : "\u25B8";
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = "\uD83D\uDCC1 " + node.name;
    row.append(caret, name);
    row.addEventListener("click", () => {
      if (isOpen) this.expanded.delete(node.path);
      else this.expanded.add(node.path);
      this.render();
    });
    row.addEventListener("contextmenu", (e) => {
      showContextMenu(e, [
        { label: "New File", onClick: () => this.hooks.onNewFile(node.path) },
        { label: "New Folder", onClick: () => this.hooks.onNewFolder(node.path) },
        { label: "Rename", onClick: () => this.hooks.onRenameFolder(node.path), separatorAfter: true },
        { label: "Delete", onClick: () => this.hooks.onDeleteFolder(node.path) },
      ]);
    });
    this.tree.appendChild(row);
  }

  private renderFileRow(path: string, depth: number): void {
    const row = document.createElement("div");
    row.className = "row file" + (path === this.ws.getActive() ? " active" : "");
    row.style.paddingLeft = `${8 + depth * 14 + 14}px`;
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = "\uD83D\uDCC4 " + baseName(path);
    name.title = path;
    row.appendChild(name);
    row.addEventListener("click", () => this.hooks.onOpen(path));
    row.addEventListener("contextmenu", (e) => {
      showContextMenu(e, [
        { label: "Open", onClick: () => this.hooks.onOpen(path) },
        { label: "Rename", onClick: () => this.hooks.onRename(path) },
        { label: "Duplicate", onClick: () => this.hooks.onDuplicate(path), separatorAfter: true },
        { label: "Delete", onClick: () => this.hooks.onDelete(path) },
      ]);
    });
    this.tree.appendChild(row);
  }
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
