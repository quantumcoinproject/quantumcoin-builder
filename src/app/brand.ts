// QuantumCoin brand mark. Prefers the vendored same-origin PNG (§9.2); falls back
// to an inline SVG placeholder if the PNG has not been vendored yet (dev only).

const ICON_SRC = "/assets/icons/quantum-coin-64.png";

const SVG_FALLBACK = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 26"><defs><linearGradient id="qc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="0.55" stop-color="#818cf8"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs><path d="M12 1 22 6.5 22 19.5 12 25 2 19.5 2 6.5Z" fill="none" stroke="url(#qc)" stroke-width="1.8"/><path d="M12 6 17 9 17 17 12 20 7 17 7 9Z" fill="url(#qc)" opacity="0.85"/></svg>`,
)}`;

export function brandIcon(className: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = className;
  img.alt = "QuantumCoin";
  img.src = ICON_SRC;
  img.addEventListener(
    "error",
    () => {
      img.src = SVG_FALLBACK;
    },
    { once: true },
  );
  return img;
}
