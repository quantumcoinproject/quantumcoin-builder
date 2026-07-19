// File workspace manager (Remix-style): multiple named workspaces, nested
// folders, a per-workspace file tree, recents, and localStorage persistence.
//
// Storage layout:
//   qcpbm.workspaces.v1  -> { activeId, list: WorkspaceMeta[] }   (index)
//   qcpbm.ws.<id>        -> { files: Record<path,string>, folders: string[], active }
//   qcpbm.recents.v1     -> { files: RecentFile[], workspaces: RecentWorkspace[] }
//
// File keys are normalized POSIX paths (e.g. "contracts/Token.sol"); folders are
// tracked explicitly so empty folders persist. The compiler consumes allSources().

import { STORAGE_SOL, EXAMPLE_TOKEN_SOL, EXAMPLE_DETAILED_SOL } from "../app/sample";
import { MAX_PATH_DEPTH, MAX_PATH_LEN } from "../app/limits";

const LS_INDEX = "qcpbm.workspaces.v1";
const LS_RECENTS = "qcpbm.recents.v1";
const LS_WS_PREFIX = "qcpbm.ws.";
const RECENTS_CAP = 12;

export type WorkspaceListener = () => void;
/** Optional sink for non-fatal persistence warnings (e.g. localStorage quota). */
export type WorkspaceWarn = (message: string) => void;
export type WorkspaceTemplate = "blank" | "samples";

export interface WorkspaceMeta {
  id: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
}

interface WorkspaceIndex {
  activeId: string;
  list: WorkspaceMeta[];
}

interface WorkspaceData {
  files: Record<string, string>;
  folders: string[];
  active: string;
  /** Resolved npm package name -> exact version installed under .deps/npm. */
  dependencies: Record<string, string>;
}

export interface RecentFile {
  wsId: string;
  wsName: string;
  path: string;
  at: number;
}
export interface RecentWorkspace {
  id: string;
  name: string;
  at: number;
}
interface Recents {
  files: RecentFile[];
  workspaces: RecentWorkspace[];
}

export class Workspace {
  private index!: WorkspaceIndex;
  private data!: WorkspaceData; // active workspace's contents
  private recents: Recents = { files: [], workspaces: [] };
  private listeners = new Set<WorkspaceListener>();
  private warn: WorkspaceWarn | null = null;
  private quotaWarned = false;
  // True while a persist attempt has failed (e.g. quota) and in-memory state has
  // therefore diverged from storage; drives the beforeunload guard (QCB-D02).
  private unsaved = false;
  // Warnings raised before a sink is registered (e.g. corruption detected in the
  // constructor, which runs before main.ts calls onWarn) are buffered and flushed.
  private pendingWarnings: string[] = [];
  // Workspace ids whose corrupt on-disk bytes could not be backed up: persisting
  // to these keys is suppressed so the original (recoverable) data is preserved.
  private protectedIds = new Set<string>();

  constructor() {
    this.loadRecents();
    this.loadIndex();
    this.data = this.readWorkspaceData(this.index.activeId) ?? this.seed("samples");
    this.ensureActiveValid();
    this.persistActive();
    this.recordRecentWorkspace(this.activeMeta());
  }

  // ---- Loading / persistence ----

  private loadIndex(): void {
    let idx: WorkspaceIndex | null = null;
    try {
      const raw = localStorage.getItem(LS_INDEX);
      if (raw) idx = JSON.parse(raw) as WorkspaceIndex;
    } catch {
      idx = null;
    }
    if (!idx || !Array.isArray(idx.list) || idx.list.length === 0) {
      const meta = this.newMeta("Default");
      this.index = { activeId: meta.id, list: [meta] };
      this.writeWorkspaceData(meta.id, this.seed("samples"));
      this.persistIndex();
      return;
    }
    this.index = idx;
    if (!idx.list.some((w) => w.id === idx!.activeId)) {
      this.index.activeId = idx.list[0]!.id;
    }
  }

  private loadRecents(): void {
    try {
      const raw = localStorage.getItem(LS_RECENTS);
      if (raw) {
        const r = JSON.parse(raw) as Partial<Recents>;
        this.recents = { files: r.files ?? [], workspaces: r.workspaces ?? [] };
      }
    } catch {
      this.recents = { files: [], workspaces: [] };
    }
  }

  private readWorkspaceData(id: string): WorkspaceData | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(LS_WS_PREFIX + id);
    } catch {
      return null;
    }
    if (!raw) return null; // missing: safe for the caller to seed
    try {
      const d = JSON.parse(raw) as Partial<WorkspaceData>;
      if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("not an object");
      return {
        files: d.files ?? {},
        folders: d.folders ?? [],
        active: d.active ?? "",
        dependencies: d.dependencies ?? {},
      };
    } catch {
      // Corrupt: present but unparseable (e.g. a power-loss-truncated write).
      // Preserve the original bytes before any caller seeds + overwrites this key.
      this.handleCorrupt(id, raw);
      return null;
    }
  }

  /**
   * Back up a corrupt workspace value so a subsequent seed+overwrite cannot
   * destroy recoverable data. If the backup itself fails (e.g. quota), mark the
   * id protected so `writeWorkspaceData` never overwrites the original bytes.
   */
  private handleCorrupt(id: string, raw: string): void {
    const backupKey = `${LS_WS_PREFIX}${id}.corrupt.${Date.now()}`;
    let backedUp = false;
    try {
      localStorage.setItem(backupKey, raw);
      backedUp = true;
    } catch {
      backedUp = false;
    }
    if (backedUp) {
      this.emitWarn(
        "A workspace could not be read (its saved data was corrupted). A backup was kept in browser storage; download your project (.zip) to preserve it.",
      );
    } else {
      this.protectedIds.add(id);
      this.emitWarn(
        "A workspace could not be read (its saved data was corrupted) and no backup could be saved. Changes to it will not be persisted to avoid overwriting the corrupted data; download your project (.zip).",
      );
    }
  }

  /** Register a sink for non-fatal persistence warnings (localStorage quota). */
  onWarn(fn: WorkspaceWarn): void {
    this.warn = fn;
    const pending = this.pendingWarnings;
    this.pendingWarnings = [];
    for (const m of pending) fn(m);
  }

  /** Emit a warning now, or buffer it until a sink is registered. */
  private emitWarn(message: string): void {
    if (this.warn) this.warn(message);
    else this.pendingWarnings.push(message);
  }

  private reportQuota(): void {
    if (this.quotaWarned) return;
    this.quotaWarned = true;
    this.emitWarn(
      "Storage limit reached: recent changes may not be saved. Download your project (.zip) and remove large or unused files.",
    );
  }

  private writeWorkspaceData(id: string, data: WorkspaceData): void {
    // Never overwrite corrupt bytes we could not back up (QCB-D01). Edits to a
    // protected workspace cannot be persisted, so flag them as unsaved too.
    if (this.protectedIds.has(id)) {
      this.unsaved = true;
      return;
    }
    try {
      localStorage.setItem(LS_WS_PREFIX + id, JSON.stringify(data));
      this.unsaved = false;
    } catch {
      this.unsaved = true;
      this.reportQuota();
    }
  }

  private persistIndex(): void {
    try {
      localStorage.setItem(LS_INDEX, JSON.stringify(this.index));
    } catch {
      this.unsaved = true;
      this.reportQuota();
    }
  }

  /** True when a persist attempt has failed and unsaved edits remain in memory. */
  hasUnsavedChanges(): boolean {
    return this.unsaved;
  }

  private persistActive(): void {
    this.writeWorkspaceData(this.index.activeId, this.data);
  }

  private persistRecents(): void {
    try {
      localStorage.setItem(LS_RECENTS, JSON.stringify(this.recents));
    } catch {
      /* ignore */
    }
  }

  private seed(template: WorkspaceTemplate): WorkspaceData {
    if (template === "samples") {
      return {
        files: {
          "Storage.sol": STORAGE_SOL,
          "ExampleToken.sol": EXAMPLE_TOKEN_SOL,
          "ExampleDetailed.sol": EXAMPLE_DETAILED_SOL,
        },
        folders: [],
        active: "Storage.sol",
        dependencies: {},
      };
    }
    const name = "Untitled.sol";
    return { files: { [name]: skeleton(name) }, folders: [], active: name, dependencies: {} };
  }

  // ---- Events ----

  subscribe(l: WorkspaceListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(): void {
    this.persistActive();
    for (const l of this.listeners) l();
  }

  // ---- File tree (active workspace) ----

  /** File paths in the active workspace, sorted folders-first then by name. */
  list(): string[] {
    return Object.keys(this.data.files).sort(pathCompare);
  }
  /** Explicit folder paths (including empty ones). */
  listFolders(): string[] {
    return [...this.data.folders].sort(pathCompare);
  }
  has(path: string): boolean {
    return path in this.data.files;
  }
  read(path: string): string {
    return this.data.files[path] ?? "";
  }
  getActive(): string {
    return this.data.active;
  }

  setActive(path: string): void {
    if (path in this.data.files && path !== this.data.active) {
      this.data.active = path;
      this.recordRecentFile(path);
      this.emit();
    }
  }

  write(path: string, content: string): void {
    if (!(path in this.data.files)) return; // never create via write
    this.data.files[path] = content;
    this.persistActive();
  }

  /** Create a new file (defaults to a `.sol` extension), returning its final path. */
  create(pathRaw: string): string {
    const base = normalizePath(pathRaw, true);
    let p = base;
    let n = 1;
    while (p in this.data.files) p = addSuffix(base, `-${n++}`);
    this.data.files[p] = skeleton(p);
    this.ensureParents(p);
    this.data.active = p;
    this.recordRecentFile(p);
    this.emit();
    return p;
  }

  /** Duplicate a file next to itself, returning the copy's path. */
  duplicate(path: string): string {
    if (!(path in this.data.files)) return path;
    let c = addSuffix(path, "-copy");
    let n = 1;
    while (c in this.data.files) c = addSuffix(path, `-copy-${n++}`);
    this.data.files[c] = this.data.files[path]!;
    this.data.active = c;
    this.recordRecentFile(c);
    this.emit();
    return c;
  }

  importFile(name: string, content: string): string {
    const path = normalizePath(name, false);
    this.data.files[path] = content;
    this.ensureParents(path);
    this.data.active = path;
    this.recordRecentFile(path);
    this.emit();
    return path;
  }

  /**
   * Import a file without overwriting an existing one: on a name collision the
   * base name gets an `_1`, `_2`, ... suffix (before the extension). Returns the
   * final path. Used by ZIP import into an existing workspace.
   */
  importFileUnique(name: string, content: string): string {
    const path = this.addFileNoClobber(name, content);
    this.data.active = path;
    this.recordRecentFile(path);
    this.emit();
    return path;
  }

  rename(oldPath: string, newRaw: string): string {
    if (!(oldPath in this.data.files)) return oldPath;
    const newPath = normalizePath(newRaw, true);
    if (newPath === oldPath || newPath in this.data.files) return oldPath;
    this.data.files[newPath] = this.data.files[oldPath]!;
    delete this.data.files[oldPath];
    this.ensureParents(newPath);
    if (this.data.active === oldPath) this.data.active = newPath;
    this.emit();
    return newPath;
  }

  /** Move a file into `destFolder` (empty string = workspace root). */
  move(path: string, destFolderRaw: string): string {
    if (!(path in this.data.files)) return path;
    const dest = normalizeFolder(destFolderRaw);
    const target = dest ? `${dest}/${basename(path)}` : basename(path);
    return this.rename(path, target);
  }

  delete(path: string): void {
    if (!(path in this.data.files)) return;
    delete this.data.files[path];
    if (this.data.active === path) this.ensureActiveValid();
    this.emit();
  }

  // ---- Folders ----

  createFolder(rawPath: string): string {
    const base = normalizeFolder(rawPath);
    if (!base) return "";
    let f = base;
    let n = 1;
    while (this.data.folders.includes(f) || f in this.data.files) f = `${base}-${n++}`;
    this.addFolderWithParents(f);
    this.emit();
    return f;
  }

  renameFolder(oldRaw: string, newRaw: string): string {
    const oldF = normalizeFolder(oldRaw);
    const newF = normalizeFolder(newRaw);
    if (!newF || newF === oldF) return oldF;
    const op = `${oldF}/`;
    const np = `${newF}/`;
    for (const f of Object.keys(this.data.files)) {
      if (f.startsWith(op)) {
        const nf = np + f.slice(op.length);
        this.data.files[nf] = this.data.files[f]!;
        delete this.data.files[f];
        if (this.data.active === f) this.data.active = nf;
      }
    }
    this.data.folders = this.data.folders.map((d) =>
      d === oldF ? newF : d.startsWith(op) ? np + d.slice(op.length) : d,
    );
    this.addFolderWithParents(newF);
    this.emit();
    return newF;
  }

  deleteFolder(rawPath: string): void {
    const folder = normalizeFolder(rawPath);
    if (!folder) return;
    const prefix = `${folder}/`;
    for (const f of Object.keys(this.data.files)) {
      if (f === folder || f.startsWith(prefix)) delete this.data.files[f];
    }
    this.data.folders = this.data.folders.filter((d) => d !== folder && !d.startsWith(prefix));
    this.ensureActiveValid();
    this.emit();
  }

  // ---- Workspaces ----

  listWorkspaces(): WorkspaceMeta[] {
    return [...this.index.list];
  }
  activeWorkspaceId(): string {
    return this.index.activeId;
  }
  activeWorkspace(): WorkspaceMeta {
    return this.activeMeta();
  }

  createWorkspace(name: string, template: WorkspaceTemplate): WorkspaceMeta {
    const meta = this.newMeta(uniqueName(name || "workspace", this.index.list));
    this.index.list.push(meta);
    this.writeWorkspaceData(meta.id, this.seed(template));
    this.switchTo(meta.id);
    return meta;
  }

  /**
   * Create a new workspace populated with exactly `files` and switch to it.
   * Duplicate names within the batch are de-duplicated with `_1`, `_2` suffixes.
   * Returns the created workspace and the final file paths.
   */
  createWorkspaceFromFiles(
    name: string,
    files: { name: string; content: string }[],
  ): { meta: WorkspaceMeta; paths: string[] } {
    const meta = this.newMeta(uniqueName(name || "workspace", this.index.list));
    this.index.list.push(meta);
    this.index.activeId = meta.id;
    meta.lastOpenedAt = Date.now();
    this.data = { files: {}, folders: [], active: "", dependencies: {} };
    const paths = files.map((f) => this.addFileNoClobber(f.name, f.content));
    this.data.active = paths[0] ?? "";
    this.recordRecentWorkspace(meta);
    this.recordRecentFile(this.data.active);
    this.persistIndex();
    this.persistActive();
    this.emit();
    return { meta, paths };
  }

  openWorkspace(id: string): void {
    if (id === this.index.activeId) return;
    if (!this.index.list.some((w) => w.id === id)) return;
    this.switchTo(id);
  }

  cloneWorkspace(id: string, name: string): WorkspaceMeta | null {
    const src = this.readWorkspaceData(id);
    if (!src) return null;
    const meta = this.newMeta(uniqueName(name || "copy", this.index.list));
    this.index.list.push(meta);
    this.writeWorkspaceData(meta.id, {
      files: { ...src.files },
      folders: [...src.folders],
      active: src.active,
      dependencies: { ...src.dependencies },
    });
    this.switchTo(meta.id);
    return meta;
  }

  renameWorkspace(id: string, name: string): void {
    const m = this.index.list.find((w) => w.id === id);
    if (!m || !name.trim()) return;
    m.name = name.trim();
    this.recents.workspaces = this.recents.workspaces.map((w) => (w.id === id ? { ...w, name: m.name } : w));
    this.recents.files = this.recents.files.map((f) => (f.wsId === id ? { ...f, wsName: m.name } : f));
    this.persistRecents();
    this.persistIndex();
    this.emit();
  }

  deleteWorkspace(id: string): void {
    const i = this.index.list.findIndex((w) => w.id === id);
    if (i < 0) return;
    this.index.list.splice(i, 1);
    try {
      localStorage.removeItem(LS_WS_PREFIX + id);
    } catch {
      /* ignore */
    }
    this.recents.workspaces = this.recents.workspaces.filter((w) => w.id !== id);
    this.recents.files = this.recents.files.filter((f) => f.wsId !== id);
    this.persistRecents();

    if (this.index.list.length === 0) {
      const meta = this.newMeta("Default");
      this.index.list.push(meta);
      this.writeWorkspaceData(meta.id, this.seed("samples"));
      this.index.activeId = meta.id;
    } else if (!this.index.list.some((w) => w.id === this.index.activeId)) {
      this.index.activeId = this.index.list[0]!.id;
    }
    this.data = this.readWorkspaceData(this.index.activeId) ?? this.seed("samples");
    this.ensureActiveValid();
    this.persistIndex();
    this.recordRecentWorkspace(this.activeMeta());
    this.emit();
  }

  private switchTo(id: string): void {
    const meta = this.index.list.find((w) => w.id === id);
    if (!meta) return;
    this.index.activeId = id;
    meta.lastOpenedAt = Date.now();
    this.data = this.readWorkspaceData(id) ?? this.seed("blank");
    this.ensureActiveValid();
    this.recordRecentWorkspace(meta);
    this.persistIndex();
    this.persistActive();
    this.emit();
  }

  // ---- Recents ----

  recentFiles(): RecentFile[] {
    return [...this.recents.files];
  }
  recentWorkspaces(): RecentWorkspace[] {
    return [...this.recents.workspaces];
  }

  private recordRecentFile(path: string): void {
    if (!path) return;
    const wsId = this.index.activeId;
    const wsName = this.activeMeta().name;
    this.recents.files = [
      { wsId, wsName, path, at: Date.now() },
      ...this.recents.files.filter((f) => !(f.wsId === wsId && f.path === path)),
    ].slice(0, RECENTS_CAP);
    this.persistRecents();
  }

  private recordRecentWorkspace(meta: WorkspaceMeta): void {
    this.recents.workspaces = [
      { id: meta.id, name: meta.name, at: Date.now() },
      ...this.recents.workspaces.filter((w) => w.id !== meta.id),
    ].slice(0, RECENTS_CAP);
    this.persistRecents();
  }

  // ---- Compilation ----

  /** All sources (for multi-file compilation with workspace-relative imports). */
  allSources(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.data.files).filter(([path]) => path.toLowerCase().endsWith(".sol")),
    );
  }

  dependencyVersion(name: string): string | null {
    return this.data.dependencies[name] ?? null;
  }

  /** Solidity Standard JSON remappings for packages cached under `.deps/npm`. */
  dependencyRemappings(): string[] {
    const out: string[] = [];
    for (const [name, version] of Object.entries(this.data.dependencies)) {
      const root = `.deps/npm/${name}@${version}/`;
      out.push(`${name}/=${root}`);
      out.push(`${name}@${version}/=${root}`);
    }
    return out;
  }

  /**
   * Atomically replace one npm package in the active workspace. Only the files
   * supplied by the verified resolver are written; stale versions are removed.
   */
  installDependency(name: string, version: string, files: { path: string; content: string }[]): void {
    const oldVersion = this.data.dependencies[name];
    if (oldVersion) {
      const oldRoot = `.deps/npm/${name}@${oldVersion}/`;
      for (const path of Object.keys(this.data.files)) {
        if (path.startsWith(oldRoot)) delete this.data.files[path];
      }
      this.data.folders = this.data.folders.filter((f) => !f.startsWith(oldRoot.slice(0, -1)));
    }

    const root = `.deps/npm/${name}@${version}`;
    for (const file of files) {
      const rawPath = `${root}/${file.path}`;
      const path = normalizePath(rawPath, false);
      if (path !== rawPath || !path.startsWith(`${root}/`)) {
        throw new Error(`Unsafe or overlong npm package path: ${file.path}`);
      }
      this.data.files[path] = file.content;
      this.ensureParents(path);
    }
    this.data.dependencies[name] = version;
    this.emit();
  }

  // ---- Internals ----

  private activeMeta(): WorkspaceMeta {
    return this.index.list.find((w) => w.id === this.index.activeId) ?? this.index.list[0]!;
  }

  private newMeta(name: string): WorkspaceMeta {
    const now = Date.now();
    const id = `ws_${now.toString(36)}_${randomToken()}`;
    return { id, name, createdAt: now, lastOpenedAt: now };
  }

  private ensureActiveValid(): void {
    if (this.data.active && this.data.active in this.data.files) return;
    this.data.active = Object.keys(this.data.files).sort(pathCompare)[0] ?? "";
  }

  private ensureParents(path: string): void {
    const d = dirname(path);
    if (d) this.addFolderWithParents(d);
  }

  /** Write a file into the active workspace without overwriting; suffixes `_N` on collision. */
  private addFileNoClobber(name: string, content: string): string {
    const base = normalizePath(name, false);
    let p = base;
    let n = 1;
    while (p in this.data.files) p = addSuffix(base, `_${n++}`);
    this.data.files[p] = content;
    this.ensureParents(p);
    return p;
  }

  private addFolderWithParents(folder: string): void {
    const parts = folder.split("/");
    let acc = "";
    for (const seg of parts) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (acc && !this.data.folders.includes(acc)) this.data.folders.push(acc);
    }
  }
}

// ---- Path helpers ----

// Reduce an arbitrary, possibly-hostile path to a safe workspace key: forward
// slashes only, no control/reserved characters, no "." / ".." segments (so an
// imported name can never traverse outside the workspace or confuse the
// compiler's source-unit resolution), and bounded length/depth.
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

// Collision-resistant workspace-id suffix from the platform CSPRNG (QCB-008),
// with a non-crypto fallback for environments lacking Web Crypto.
function randomToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 12);
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(6));
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).slice(2, 14);
}

function sanitizeSegments(raw: string): string[] {
  const cleaned = raw
    .trim()
    .replace(/\\/g, "/")
    // Drop control chars and Windows-reserved characters within names.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "")
    .replace(/\/+/g, "/");
  const out: string[] = [];
  for (const seg of cleaned.split("/")) {
    const s = seg.trim();
    if (!s || s === "." || s === "..") continue; // strip empties and traversal
    // Reject reserved keys so a crafted path can never pollute the prototype of
    // the object-keyed `files`/`folders` maps (QCB-005).
    if (RESERVED_SEGMENTS.has(s.toLowerCase())) continue;
    out.push(s);
  }
  return out.slice(0, MAX_PATH_DEPTH);
}

function normalizePath(raw: string, defaultSol: boolean): string {
  const segs = sanitizeSegments(raw);
  let p = segs.join("/");
  if (!p) p = "Untitled";
  if (p.length > MAX_PATH_LEN) p = p.slice(0, MAX_PATH_LEN);
  if (defaultSol && !/\.[A-Za-z0-9]+$/.test(basename(p))) p += ".sol";
  return p;
}

function normalizeFolder(raw: string): string {
  let p = sanitizeSegments(raw).join("/");
  if (p.length > MAX_PATH_LEN) p = p.slice(0, MAX_PATH_LEN);
  return p;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function skeleton(path: string): string {
  const c = basename(path).replace(/\.sol$/, "").replace(/[^A-Za-z0-9_]/g, "_") || "Contract";
  return `// SPDX-License-Identifier: MIT\npragma solidity 0.7.6;\n\ncontract ${c} {\n}\n`;
}

/** Insert `suffix` before the file extension (or at the end if none). */
function addSuffix(path: string, suffix: string): string {
  const b = basename(path);
  const d = dirname(path);
  const dot = b.lastIndexOf(".");
  const nb = dot > 0 ? b.slice(0, dot) + suffix + b.slice(dot) : b + suffix;
  return d ? `${d}/${nb}` : nb;
}

function uniqueName(name: string, list: WorkspaceMeta[]): string {
  const taken = new Set(list.map((w) => w.name));
  if (!taken.has(name)) return name;
  let n = 1;
  while (taken.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

/** Sort so folders/paths group naturally: compare segment by segment. */
function pathCompare(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i] !== pb[i]) return pa[i]!.localeCompare(pb[i]!);
  }
  return pa.length - pb.length;
}
