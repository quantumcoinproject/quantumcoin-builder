import { test, expect } from "@playwright/test";

/**
 * Full compile -> diagnostics -> artifacts flow (Mini §12.1).
 *
 * Requires the vendored ~24 MB soljson compiler. When it has not been vendored
 * (e.g. the fast CI build), this spec skips itself rather than failing.
 */
test("compiles the sample contract and exposes artifacts", async ({ page, baseURL }) => {
  // NOTE: `vite preview` serves index.html (HTTP 200, text/html) as an SPA
  // fallback for unknown paths, so `probe.ok()` alone is not enough to tell
  // whether the compiler was actually vendored. Confirm the response is really
  // the JS asset before running the (otherwise failing) compile flow.
  const probe = await page.request.get(`${baseURL}/assets/compilers/soljson-v32b.8.14.js`);
  const contentType = probe.headers()["content-type"] ?? "";
  const vendored = probe.ok() && /javascript|ecmascript/i.test(contentType);
  test.skip(!vendored, "soljson compiler not vendored — run `npm run vendor:compiler`");

  await page.goto("/");
  await expect(page.locator('[data-testid="ide-root"]')).toBeVisible({ timeout: 30_000 });

  // Compile via the Compiler panel button.
  await page.locator(".side .ptab", { hasText: "Compiler" }).click();
  await page.locator(".side .btn.block", { hasText: "Compile" }).first().click();

  // Compilation succeeds (soljson load + compile may take a few seconds).
  await expect(page.locator(".term-body")).toContainText("Compiled successfully", { timeout: 60_000 });

  // Status row reports zero errors.
  await expect(page.locator(".side .status-row")).toContainText("0 errors");

  // Artifacts become available (ABI + bytecode rows).
  await expect(page.locator(".side .art-row", { hasText: "ABI" })).toBeVisible();
  await expect(page.locator(".side .art-row", { hasText: "Creation bytecode" })).toBeVisible();

  // ABI panel lists the contract's functions via the quantumcoin Interface.
  await page.locator(".side .ptab", { hasText: "ABI" }).click();
  await expect(page.locator(".side .pbody")).toContainText("setValue");
  await expect(page.locator(".side .pbody")).toContainText("getValue");

  // A write function shows a selector computed by the SDK.
  const setValueFn = page.locator(".side .fn", { hasText: "setValue" });
  await expect(setValueFn).toContainText("selector: 0x");

  // Entering an argument yields full calldata encoded via the quantumcoin SDK (WASM).
  await setValueFn.locator(".arg-input").first().fill("42");
  await expect(setValueFn).toContainText(/calldata: 0x[0-9a-fA-F]{8,}/);

  // Download all artifacts as a ZIP.
  await page.locator(".side .ptab", { hasText: "Compiler" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".side .btn.block", { hasText: ".zip" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/Storage-artifacts\.zip/);
});
