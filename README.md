# QuantumCoin Builder

A browser-based **smart contracts and decentralized application development platform** for [QuantumCoin](https://quantumcoin.org).
Write Solidity, compile it in-browser with the pinned QuantumCoin `soljson` compiler,
inspect the **SDK-validated ABI** via `quantumcoin`, and **download creation + runtime
bytecode** — with **no deploy, wallet, or network flows**.

## Hard constraints

- **Web only**, static SPA (Vite + TypeScript, vanilla DOM — no React/Vue/Svelte).
- **In-house editor (`QCEditor`)**
- **Solidity 7.6 only** — single pinned compiler `soljson-v32b.8.12.js`.
- **Two runtime dependencies only**: `quantumcoin` and `quantum-coin-js-sdk`.
- **Fully self-contained** `dist/` — zero runtime CDN/third-party asset fetches.

## Quick start

```bash
npm install
npm run vendor:compiler   # downloads the ~23 MB Solidity 7.6 compiler (build-time only)
npm run vendor:icon       # downloads the QuantumCoin brand icon (build-time only)
npm run dev               # http://localhost:5173
```

`npm run dev` works without the vendored compiler, but compilation is disabled until
`vendor:compiler` has run.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server |
| `npm run build` | Vendor assets, typecheck, and produce a self-contained `dist/` |
| `npm run test` | Vitest unit/integration tests |
| `npm run test:e2e` | Playwright end-to-end smoke test |
| `npm run verify:allowed-deps` | Fail if `dependencies` contains anything other than the two SDKs |
| `npm run verify:self-contained` | Fail if `dist/` references any external asset URL |

## Architecture

```
src/
  main.ts              # bootstrap + wiring
  app/                 # shell, menu, terminal, bootstrap overlay, state store
  editor/              # QCEditor (document, tokenizer, highlight, gutter, diagnostics)
  compiler/            # worker client + protocol types
  abi/                 # quantumcoin Interface integration
  export/              # bytecode/ABI downloads + first-party ZIP
  styles/              # theme tokens + CSS
public/
  compiler-worker.js   # classic Web Worker that importScripts the vendored soljson
```
