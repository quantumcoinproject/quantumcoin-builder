import "./styles/app.css";

import { QCEditor, type PragmaStatus } from "./editor/QCEditor";
import { CompilerClient } from "./compiler/compilerClient";
import { DEFAULT_SETTINGS, type EditorDiagnostic } from "./compiler/types";
import { SidePanel } from "./panels/sidePanel";
import { Terminal } from "./app/terminal";
import { MenuBar, MENUS, type MenuDef, type MenuItem } from "./app/menu";
import { promptText, newWorkspaceDialog, confirmDialog, alertDialog } from "./app/dialogs";
import { BootstrapOverlay } from "./app/bootstrap";
import { brandIcon } from "./app/brand";
import { Store } from "./app/state";
import { Workspace } from "./files/workspace";
import { Explorer } from "./files/explorer";
import { Tabs } from "./files/tabs";
import { initSdk } from "./abi/sdk";
import { readZip } from "./export/zip";
import { downloadProjectZip } from "./export/download";
import { MAX_FILE_BYTES, MAX_SOURCE_CHARS, MAX_ZIP_TOTAL_BYTES } from "./app/limits";

const store = new Store();
const workspace = new Workspace();
const compiler = new CompilerClient();
const terminal = new Terminal();

// Surface non-fatal persistence warnings (e.g. localStorage quota) in the terminal.
workspace.onWarn((message) => terminal.log(message, "warning"));

// Guard against closing/reloading the tab while edits could not be persisted
// (e.g. storage quota exceeded), so unsaved changes are not silently lost (QCB-D02).
window.addEventListener("beforeunload", (e) => {
  if (workspace.hasUnsavedChanges()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

let openFiles: string[] = [workspace.getActive()];
let explorerVisible = true;

let resolveShellReady!: () => void;
const shellReady = new Promise<void>((r) => {
  resolveShellReady = r;
});

// ---- Auto-compile (3s after the last edit) ----
const AUTO_COMPILE_DELAY = 3000;
let autoCompileTimer: number | null = null;
let autoCompileEnabled = false;

// Latest whole-program diagnostics, re-applied when switching to an open file so
// a non-active file's errors (e.g. it implements an interface changed elsewhere)
// remain visible as squiggles across tab switches.
let lastDiagnostics: EditorDiagnostic[] = [];

function scheduleAutoCompile(): void {
  if (!autoCompileEnabled) return;
  if (autoCompileTimer != null) clearTimeout(autoCompileTimer);
  autoCompileTimer = window.setTimeout(() => {
    autoCompileTimer = null;
    // Skip silently while the pragma is unsatisfied to avoid noisy errors mid-edit.
    if (!editor.getPragmaStatus().ok) return;
    void compileCurrent();
  }, AUTO_COMPILE_DELAY);
}

// Run a pending debounced compile immediately (e.g. before switching files) so
// diagnostics reflect the latest edits instead of waiting out the debounce.
function flushAutoCompile(): void {
  if (autoCompileTimer == null) return;
  clearTimeout(autoCompileTimer);
  autoCompileTimer = null;
  if (editor.getPragmaStatus().ok) void compileCurrent();
}

// ---- Editor ----
const editor = new QCEditor({
  onChange: (path, value) => {
    workspace.write(path, value);
    scheduleAutoCompile();
  },
  onPragmaChange: (status: PragmaStatus) => {
    store.set({ pragmaOk: status.ok });
    sidePanel.setPragmaOk(status.ok);
  },
  onPasteWarning: (message) => terminal.log(message, "warning"),
});

// ---- Side panel ----
const sidePanel = new SidePanel({
  onCompile: () => compileCurrent(),
  log: (msg, kind) => terminal.log(msg, kind),
});

// ---- Tabs / explorer ----
const tabs = new Tabs({
  onSelect: (path) => openFile(path),
  onClose: (path) => closeFile(path),
});
const explorer = new Explorer(workspace, {
  onOpen: (path) => openFile(path),
  onNewFile: (dir) => void newFile(dir),
  onNewFolder: (dir) => void newFolder(dir),
  onRename: (path) => void renameFile(path),
  onDelete: (path) => void deleteFile(path),
  onDuplicate: (path) => duplicateFile(path),
  onRenameFolder: (path) => void renameFolder(path),
  onDeleteFolder: (path) => void deleteFolder(path),
  onSwitchWorkspace: (id) => switchWorkspace(id),
  onNewWorkspace: () => void createWorkspace(),
  onRenameWorkspace: (id) => void renameWorkspace(id),
  onDeleteWorkspace: (id) => void deleteWorkspace(id),
  onCloneWorkspace: (id) => void cloneWorkspace(id),
});

// Module-scoped so workspace/recent changes can rebuild dynamic submenus.
let menubar: MenuBar;

// ---- Shell DOM ----
function buildShell(): void {
  const app = document.getElementById("app") as HTMLDivElement;
  app.className = "app";

  // Title bar
  const titlebar = document.createElement("div");
  titlebar.className = "titlebar";
  const brand = document.createElement("div");
  brand.className = "brand";
  brand.append(brandIcon("icon"), spanText("title", "QuantumCoin"), spanText("subtitle", "Platform Builder"));
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  const gear = document.createElement("button");
  gear.className = "icon-btn";
  gear.title = "Settings";
  gear.innerHTML = "&#9881;";
  gear.addEventListener("click", () => handleAction("tools.compilerSettings"));
  titlebar.append(brand, spacer, gear);

  // Menu bar (dynamic: Open Workspace and Recent submenus rebuild on demand)
  menubar = new MenuBar(handleAction, buildMenus);
  workspace.subscribe(() => menubar.refresh());

  // Body
  const body = document.createElement("div");
  body.className = "body";

  const center = document.createElement("div");
  center.style.display = "flex";
  center.style.flexDirection = "column";
  center.style.minWidth = "0";
  center.style.minHeight = "0";
  center.appendChild(tabs.el);
  editor.mount(center);

  body.append(explorer.el, center, sidePanel.el);

  app.append(titlebar, menubar.el, body, terminal.el);

  // Terminal diagnostic clicks -> jump editor
  terminal.setDiagnosticClickHandler((d) => focusDiagnostic(d));

  // Load the active document into the freshly mounted editor.
  const active = workspace.getActive();
  editor.setDocument(active, workspace.read(active));

  renderTabs();
  resolveShellReady();
}

function spanText(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

// Build menu definitions, injecting dynamic Open Workspace / Recent submenus.
function buildMenus(): MenuDef[] {
  const activeId = workspace.activeWorkspaceId();
  const wsItems: MenuItem[] = workspace.listWorkspaces().map((w) => ({
    id: `file.openWorkspace.${w.id}`,
    label: (w.id === activeId ? "\u25CF " : "\u2003") + w.name,
  }));

  const recentFileItems: MenuItem[] = workspace.recentFiles().map((f, i) => ({
    id: `file.recentFile.${i}`,
    label: `${f.path}  \u2014  ${f.wsName}`,
  }));
  const recentWsItems: MenuItem[] = workspace.recentWorkspaces().map((w, i) => ({
    id: `file.recentWs.${i}`,
    label: `\uD83D\uDCC1 ${w.name}`,
  }));
  const recentChildren: MenuItem[] = [];
  recentChildren.push(...recentFileItems);
  if (recentFileItems.length && recentWsItems.length) {
    if (recentChildren.length) recentChildren[recentChildren.length - 1]!.separatorAfter = true;
  }
  recentChildren.push(...recentWsItems);

  return MENUS.map((menu) => {
    if (menu.label !== "File") return menu;
    return {
      ...menu,
      items: menu.items.map((item) => {
        if (item.id === "file.openWorkspace") return { ...item, children: wsItems };
        if (item.id === "file.recent") return { ...item, children: recentChildren };
        return item;
      }),
    };
  });
}

// ---- File operations ----
function renderTabs(): void {
  openFiles = openFiles.filter((p) => workspace.has(p));
  if (!openFiles.includes(workspace.getActive())) openFiles.push(workspace.getActive());
  tabs.render(openFiles, workspace.getActive());
}

function openFile(path: string): void {
  if (!workspace.has(path)) return;
  // Persist current editor buffer before switching.
  workspace.write(editor.getPath(), editor.getValue());
  const hadPendingCompile = autoCompileTimer != null;
  workspace.setActive(path);
  if (!openFiles.includes(path)) openFiles.push(path);
  editor.setDocument(path, workspace.read(path));
  // A pending edit (e.g. to an interface) hasn't compiled yet; run it now so the
  // switched-to file reflects fresh cross-file errors. Otherwise re-apply the
  // last compile's diagnostics so this file's squiggles persist across switches.
  if (hadPendingCompile) flushAutoCompile();
  else editor.setDiagnostics(lastDiagnostics);
  renderTabs();
  explorer.render();
  editor.focus();
}

function closeFile(path: string): void {
  openFiles = openFiles.filter((p) => p !== path);
  if (openFiles.length === 0) {
    const next = workspace.list()[0];
    if (next) openFiles = [next];
  }
  const target = openFiles[openFiles.length - 1];
  if (workspace.getActive() === path && target) openFile(target);
  else renderTabs();
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

async function newFile(dir = ""): Promise<void> {
  const suggested = dir ? `${dir}/Untitled.sol` : "Untitled.sol";
  const name = await promptText("New File", "Path", suggested);
  if (!name) return;
  const created = workspace.create(name);
  openFiles.push(created);
  editor.setDocument(created, workspace.read(created));
  renderTabs();
  terminal.log(`Created ${created}`);
}

async function newFolder(dir = ""): Promise<void> {
  const suggested = dir ? `${dir}/` : "";
  const name = await promptText("New Folder", "Path", suggested);
  if (!name) return;
  const created = workspace.createFolder(name);
  if (created) terminal.log(`Created folder ${created}`);
}

async function renameFile(path: string): Promise<void> {
  const next = await promptText("Rename File", "Path", path);
  if (!next) return;
  const renamed = workspace.rename(path, next);
  openFiles = openFiles.map((p) => (p === path ? renamed : p));
  if (editor.getPath() === path) editor.setDocument(renamed, workspace.read(renamed));
  renderTabs();
  terminal.log(`Renamed ${path} \u2192 ${renamed}`);
}

function duplicateFile(path: string): void {
  const copy = workspace.duplicate(path);
  openFiles.push(copy);
  editor.setDocument(copy, workspace.read(copy));
  renderTabs();
  terminal.log(`Duplicated ${path} \u2192 ${copy}`);
}

async function deleteFile(path: string): Promise<void> {
  if (!(await confirmDialog("Delete File", `Delete ${path}?`, "Delete"))) return;
  workspace.delete(path);
  openFiles = openFiles.filter((p) => p !== path);
  reloadActiveAfterMutation();
  terminal.log(`Deleted ${path}`, "warning");
}

async function renameFolder(path: string): Promise<void> {
  const next = await promptText("Rename Folder", "Path", path);
  if (!next) return;
  const renamed = workspace.renameFolder(path, next);
  // File paths under the folder changed; resync open tabs and the editor.
  openFiles = openFiles.map((p) => (p === path || p.startsWith(path + "/") ? renamed + p.slice(path.length) : p));
  openFiles = openFiles.filter((p) => workspace.has(p));
  reloadActiveAfterMutation();
  terminal.log(`Renamed folder ${path} \u2192 ${renamed}`);
}

async function deleteFolder(path: string): Promise<void> {
  if (!(await confirmDialog("Delete Folder", `Delete folder ${path} and all its contents?`, "Delete"))) return;
  workspace.deleteFolder(path);
  openFiles = openFiles.filter((p) => workspace.has(p));
  reloadActiveAfterMutation();
  terminal.log(`Deleted folder ${path}`, "warning");
}

// After a mutation that may have changed the active file, make sure a valid file
// is loaded into the editor and reflected in the tab strip.
function reloadActiveAfterMutation(): void {
  const active = workspace.getActive();
  if (active && !openFiles.includes(active)) openFiles.push(active);
  editor.setDocument(active, active ? workspace.read(active) : "");
  renderTabs();
}

// ---- Workspace operations ----
async function createWorkspace(): Promise<void> {
  const res = await newWorkspaceDialog();
  if (!res) return;
  const meta = workspace.createWorkspace(res.name, res.template);
  onWorkspaceSwitched();
  terminal.log(`Created workspace "${meta.name}"`, "success");
}

function switchWorkspace(id: string): void {
  if (id === workspace.activeWorkspaceId()) return;
  workspace.write(editor.getPath(), editor.getValue());
  workspace.openWorkspace(id);
  onWorkspaceSwitched();
  terminal.log(`Switched to workspace "${workspace.activeWorkspace().name}"`);
}

async function renameWorkspace(id: string): Promise<void> {
  const current = workspace.listWorkspaces().find((w) => w.id === id);
  const next = await promptText("Rename Workspace", "Name", current?.name ?? "");
  if (!next) return;
  workspace.renameWorkspace(id, next);
  terminal.log(`Renamed workspace to "${next}"`);
}

async function cloneWorkspace(id: string): Promise<void> {
  const current = workspace.listWorkspaces().find((w) => w.id === id);
  const next = await promptText("Clone Workspace", "Name", `${current?.name ?? "workspace"} copy`);
  if (!next) return;
  workspace.write(editor.getPath(), editor.getValue());
  const meta = workspace.cloneWorkspace(id, next);
  if (meta) {
    onWorkspaceSwitched();
    terminal.log(`Cloned workspace to "${meta.name}"`, "success");
  }
}

async function deleteWorkspace(id: string): Promise<void> {
  const current = workspace.listWorkspaces().find((w) => w.id === id);
  if (!current) return;
  if (!(await confirmDialog("Delete Workspace", `Delete workspace "${current.name}" and all its files?`, "Delete"))) {
    return;
  }
  const wasActive = id === workspace.activeWorkspaceId();
  workspace.deleteWorkspace(id);
  if (wasActive) onWorkspaceSwitched();
  terminal.log(`Deleted workspace "${current.name}"`, "warning");
}

// Open a recent file, switching workspaces first if it lives in another one.
function openRecentFile(idx: number): void {
  const rec = workspace.recentFiles()[idx];
  if (!rec) return;
  if (rec.wsId !== workspace.activeWorkspaceId()) {
    workspace.write(editor.getPath(), editor.getValue());
    workspace.openWorkspace(rec.wsId);
    onWorkspaceSwitched();
  }
  if (workspace.has(rec.path)) openFile(rec.path);
  else terminal.log(`Recent file ${rec.path} no longer exists`, "warning");
}

// Reload editor/tabs/panels for the newly active workspace and recompile.
function onWorkspaceSwitched(): void {
  const active = workspace.getActive();
  openFiles = active ? [active] : [];
  editor.setDocument(active, active ? workspace.read(active) : "");
  lastDiagnostics = [];
  editor.setDiagnostics([]);
  renderTabs();
  explorer.render();
  sidePanel.resetRun();
  if (active && editor.getPragmaStatus().ok) void compileCurrent();
}

function importFromFile(): void {
  pickFile(".sol", async (file) => {
    if (!file.name.toLowerCase().endsWith(".sol")) {
      terminal.log(`Import rejected: ${file.name} is not a .sol file`, "error");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      terminal.log(
        `Import rejected: ${file.name} is ${fmtBytes(file.size)} (limit ${fmtBytes(MAX_FILE_BYTES)})`,
        "error",
      );
      return;
    }
    const text = await file.text();
    if (text.length > MAX_SOURCE_CHARS) {
      terminal.log(`Import rejected: ${file.name} exceeds ${MAX_SOURCE_CHARS} characters`, "error");
      return;
    }
    const name = workspace.importFile(file.name, text);
    openFiles.push(name);
    editor.setDocument(name, workspace.read(name));
    renderTabs();
    terminal.log(`Imported ${name}`, "success");
  });
}

function importFromZip(): void {
  pickFile(".zip", async (file) => {
    if (file.size > MAX_ZIP_TOTAL_BYTES) {
      terminal.log(
        `Zip rejected: ${file.name} is ${fmtBytes(file.size)} (limit ${fmtBytes(MAX_ZIP_TOTAL_BYTES)})`,
        "error",
      );
      return;
    }
    try {
      const entries = await readZip(file);
      let last = "";
      let imported = 0;
      let skipped = 0;
      for (const e of entries) {
        if (!e.name.toLowerCase().endsWith(".sol")) continue;
        if (e.text.length > MAX_SOURCE_CHARS) {
          skipped++;
          terminal.log(`Skipped ${e.name}: exceeds ${MAX_SOURCE_CHARS} characters`, "warning");
          continue;
        }
        last = workspace.importFile(e.name, e.text);
        imported++;
      }
      if (imported > 0) {
        openFiles.push(last);
        editor.setDocument(last, workspace.read(last));
        renderTabs();
        const suffix = skipped ? ` (${skipped} skipped)` : "";
        terminal.log(`Imported ${imported} file(s) from ${file.name}${suffix}`, "success");
      } else {
        terminal.log(`No importable .sol files found in ${file.name}`, "warning");
      }
    } catch (err) {
      terminal.log("Zip import failed: " + (err instanceof Error ? err.message : String(err)), "error");
    }
  });
}

function downloadProject(): void {
  workspace.write(editor.getPath(), editor.getValue());
  const sources = workspace.allSources();
  const count = Object.keys(sources).length;
  const filename = downloadProjectZip(sources);
  terminal.log(`Downloaded ${count} file(s) as ${filename}`, "success");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function pickFile(accept: string, onPick: (f: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) onPick(f);
  });
  input.click();
}

// ---- Compile ----
async function compileCurrent(): Promise<void> {
  workspace.write(editor.getPath(), editor.getValue());
  const pragma = editor.getPragmaStatus();
  if (!pragma.ok) {
    terminal.log(`Cannot compile: ${pragma.message}`, "error");
    return;
  }
  const active = workspace.getActive();
  const sources = workspace.allSources();
  terminal.log(`Compiling ${active} with Solidity 0.7.6 (soljson-v32b.8.12.js)\u2026`);
  try {
    const result = await compiler.compile(sources, DEFAULT_SETTINGS, (stage) =>
      terminal.log(`  ${stage}\u2026`),
    );
    lastDiagnostics = result.diagnostics;
    editor.setDiagnostics(result.diagnostics);
    for (const d of result.diagnostics) terminal.logDiagnostic(d);
    store.set({ lastResult: result });
    sidePanel.setResult(result);

    if (result.errorCount > 0) {
      terminal.log(`Compilation failed \u2014 ${result.errorCount} error(s), ${result.warningCount} warning(s).`, "error");
    } else {
      const names = result.contracts.map((c) => c.contractName).join(", ") || "(no contracts)";
      terminal.log(`Compiled successfully: ${names}. ${result.warningCount} warning(s).`, "success");
    }
  } catch (err) {
    terminal.log("Compiler error: " + (err instanceof Error ? err.message : String(err)), "error");
  }
}

function focusDiagnostic(d: EditorDiagnostic): void {
  if (d.file !== workspace.getActive() && workspace.has(d.file)) openFile(d.file);
  editor.gotoLine(d.line, true);
}

// ---- Menu actions ----
function handleAction(id: string): void {
  // Dynamic ids from rebuilt submenus (Open Workspace / Recent).
  if (id.startsWith("file.openWorkspace.")) {
    switchWorkspace(id.slice("file.openWorkspace.".length));
    return;
  }
  if (id.startsWith("file.recentFile.")) {
    const idx = Number(id.slice("file.recentFile.".length));
    openRecentFile(idx);
    return;
  }
  if (id.startsWith("file.recentWs.")) {
    const idx = Number(id.slice("file.recentWs.".length));
    const rec = workspace.recentWorkspaces()[idx];
    if (rec) switchWorkspace(rec.id);
    return;
  }

  switch (id) {
    case "file.new": void newFile(dirOf(workspace.getActive())); break;
    case "file.newFolder": void newFolder(dirOf(workspace.getActive())); break;
    case "file.newWorkspace": void createWorkspace(); break;
    case "file.openWorkspace": break; // parent submenu; no direct action
    case "file.recent": break; // parent submenu; no direct action
    case "file.open": importFromFile(); break;
    case "file.importZip": importFromZip(); break;
    case "file.download": downloadProject(); break;
    case "file.save":
      workspace.write(editor.getPath(), editor.getValue());
      terminal.log(`Saved ${editor.getPath()}`);
      break;
    case "file.rename": void renameFile(workspace.getActive()); break;
    case "file.close": closeFile(workspace.getActive()); break;
    case "edit.undo": editor.undo(); break;
    case "edit.redo": editor.redo(); break;
    case "edit.find": editor.openFindReplace(false); break;
    case "edit.replace": editor.openFindReplace(true); break;
    case "edit.gotoLine": editor.openGoToLine(); break;
    case "view.explorer": toggleExplorer(); break;
    case "view.compiler": sidePanel.showTab("compiler"); break;
    case "view.abi": sidePanel.showTab("abi"); break;
    case "view.run": sidePanel.showTab("run"); break;
    case "view.terminal": toggleTerminal(); break;
    case "build.compile":
    case "build.compileAll": compileCurrent(); break;
    case "tools.compilerSettings":
      terminal.log("Compiler settings: optimizer enabled (runs 200); Solidity 0.7.6 fixed. (UI in a later iteration.)");
      break;
    case "help.docs": window.open("https://quantumcoin.org", "_blank", "noopener"); break;
    case "help.explorer": window.open("https://quantumscan.com", "_blank", "noopener"); break;
    case "help.shortcuts":
      terminal.log("Shortcuts: Ctrl+S Save, Ctrl+Shift+B Compile, Ctrl+F Find, Ctrl+H Replace, Ctrl+G Go to line");
      break;
    case "help.about":
      void showAbout();
      break;
    default: break;
  }
}

// About dialog: dismissable OK dialog with a link to quantumcoin.org.
function showAbout(): Promise<void> {
  const body = document.createElement("span");
  const link = document.createElement("a");
  link.className = "explorer-link";
  link.href = "https://quantumcoin.org";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "QuantumCoin";
  body.append("QuantumCoin Builder: for developing decentralized applications on the ", link, " Blockchain.");
  return alertDialog("About QuantumCoin Builder", body);
}

function toggleExplorer(): void {
  explorerVisible = !explorerVisible;
  document.querySelector(".body")?.classList.toggle("no-explorer", !explorerVisible);
  explorer.el.style.display = explorerVisible ? "" : "none";
}

function toggleTerminal(): void {
  const root = document.querySelector(".app") as HTMLElement;
  const hidden = terminal.el.style.display === "none";
  terminal.el.style.display = hidden ? "" : "none";
  root.style.setProperty("--terminal-h", hidden ? "200px" : "0px");
}

// ---- Keyboard shortcuts (global) ----
function bindGlobalShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      compileCurrent();
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      handleAction("file.save");
    }
  });
}

// ---- Bootstrap ----
function startBootstrap(): void {
  const overlay = new BootstrapOverlay();
  const root = document.getElementById("bootstrap-root") as HTMLElement;

  overlay.addAsset("shell", "Application shell", async () => buildShell(), true);
  overlay.addAsset("editor", "Code editor (QCEditor)", async () => {
    // The editor mounts and loads the active document during shell build.
    await shellReady;
  }, true);
  overlay.addAsset("compiler", "Solidity compiler", async () => {
    overlay.setDetail("compiler", "loading soljson\u2026");
    await compiler.ping();
  }, false);
  overlay.addAsset("sdk", "QuantumCoin SDK (WASM)", async () => {
    await initSdk();
  }, false);
  overlay.addAsset("fonts", "Fonts", async () => {
    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, delay(4000)]);
    }
  }, true);

  overlay.mount(root);
  void overlay.run(() => {
    const app = document.getElementById("app") as HTMLElement;
    app.hidden = false;
    bindGlobalShortcuts();
    autoCompileEnabled = true;
    editor.focus();
    terminal.log("Ready. Write Solidity 0.7.6 \u2014 it auto-compiles ~3s after you stop typing (or Ctrl+Shift+B).");
    // Check the already-open files immediately (whole-program compile).
    if (editor.getPragmaStatus().ok) void compileCurrent();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

startBootstrap();
