import { describe, it, expect, beforeEach } from "vitest";
import { Workspace } from "../../src/files/workspace";

const LS_INDEX = "qcpbm.workspaces.v1";
const LS_WS_PREFIX = "qcpbm.ws.";

// localStorage mock whose setItem can be toggled to throw (simulating quota).
class MemoryStorage {
  private m = new Map<string, string>();
  fail = false;
  get length(): number {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.fail) {
      const e = new Error("QuotaExceededError");
      e.name = "QuotaExceededError";
      throw e;
    }
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  rawKeys(): string[] {
    return [...this.m.keys()];
  }
}

function installStorage(): MemoryStorage {
  const s = new MemoryStorage();
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = s;
  return s;
}

function seedIndex(s: MemoryStorage, id: string): void {
  s.setItem(
    LS_INDEX,
    JSON.stringify({ activeId: id, list: [{ id, name: "W", createdAt: 1, lastOpenedAt: 1 }] }),
  );
}

describe("QCB-D01: corrupt workspace data is preserved, not silently destroyed", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = installStorage();
  });

  it("backs up corrupt data to a .corrupt.<ts> key and warns (backup succeeds)", () => {
    const id = "ws_corrupt";
    seedIndex(storage, id);
    const corruptRaw = "{ this is : not json ]";
    storage.setItem(LS_WS_PREFIX + id, corruptRaw);

    const ws = new Workspace();
    const warnings: string[] = [];
    ws.onWarn((m) => warnings.push(m)); // flushes buffered warnings from construction

    const backupKeys = storage.rawKeys().filter((k) => k.startsWith(`${LS_WS_PREFIX}${id}.corrupt.`));
    expect(backupKeys).toHaveLength(1);
    expect(storage.getItem(backupKeys[0]!)).toBe(corruptRaw);
    expect(warnings.some((w) => /corrupt/i.test(w))).toBe(true);
    // App remains usable: the workspace was seeded with sample contracts.
    expect(ws.list().length).toBeGreaterThan(0);
  });

  it("does not overwrite the corrupt primary key when the backup itself fails", () => {
    const id = "ws_unbacked";
    seedIndex(storage, id);
    const corruptRaw = "<<< truncated >>>";
    storage.setItem(LS_WS_PREFIX + id, corruptRaw);

    storage.fail = true; // every subsequent setItem throws (backup + persist)
    const ws = new Workspace();
    storage.fail = false;
    const warnings: string[] = [];
    ws.onWarn((m) => warnings.push(m));

    // The original corrupt bytes must be untouched (protected from overwrite).
    expect(storage.getItem(LS_WS_PREFIX + id)).toBe(corruptRaw);
    expect(warnings.some((w) => /no backup could be saved/i.test(w))).toBe(true);
    expect(ws.hasUnsavedChanges()).toBe(true);
  });

  it("treats missing data as a fresh workspace without creating a backup", () => {
    const id = "ws_missing";
    seedIndex(storage, id); // index references id but no ws.<id> data key exists

    new Workspace();
    const backupKeys = storage.rawKeys().filter((k) => k.includes(".corrupt."));
    expect(backupKeys).toHaveLength(0);
  });
});

describe("QCB-D02: persist failures are surfaced via hasUnsavedChanges()", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = installStorage();
  });

  it("sets unsaved on a failed write and clears it once a write succeeds", () => {
    const ws = new Workspace(); // constructs cleanly (fail=false)
    expect(ws.hasUnsavedChanges()).toBe(false);

    const active = ws.getActive();
    expect(active).not.toBe("");

    storage.fail = true;
    ws.write(active, "// edit that cannot be persisted\n");
    expect(ws.hasUnsavedChanges()).toBe(true);

    storage.fail = false;
    ws.write(active, "// edit that persists\n");
    expect(ws.hasUnsavedChanges()).toBe(false);
  });
});
