// Lightweight right-click context menu: an absolutely-positioned list opened at
// the cursor, dismissed on outside click, Escape, scroll, or selection.

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  separatorAfter?: boolean;
}

let openMenu: HTMLElement | null = null;

function closeContextMenu(): void {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

/** Open a context menu at the event's position with the given items. */
export function showContextMenu(ev: MouseEvent, items: ContextMenuItem[]): void {
  ev.preventDefault();
  ev.stopPropagation();
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "ctx-item" + (item.disabled ? " disabled" : "");
    row.textContent = item.label;
    if (!item.disabled) {
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        closeContextMenu();
        item.onClick();
      });
    }
    menu.appendChild(row);
    if (item.separatorAfter) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
    }
  }

  document.body.appendChild(menu);
  openMenu = menu;

  // Keep the menu within the viewport.
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  const x = Math.min(ev.clientX, innerWidth - rect.width - 4);
  const y = Math.min(ev.clientY, innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;
}

// Global dismissers (registered once).
document.addEventListener("click", () => closeContextMenu());
document.addEventListener("contextmenu", (e) => {
  // Allow our own menu handlers to open first; close any stale one otherwise.
  if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
});
window.addEventListener("scroll", () => closeContextMenu(), true);
