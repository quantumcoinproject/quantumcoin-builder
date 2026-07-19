import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

test("resolves a scoped npm Solidity import with progress and compiles it", async ({ page }) => {
  const tarball = gzipSync(makeTar([
    ["package/contracts/Dep.sol", "pragma solidity 0.7.6; library Dep { function one() internal pure returns (uint256) { return 1; } }"],
    ["package/package.json", '{"name":"@test/dep","version":"1.2.3"}'],
  ]));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

  await page.route("https://registry.npmjs.org/%40test%2Fdep", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        "dist-tags": { latest: "1.2.3" },
        versions: {
          "1.2.3": {
            version: "1.2.3",
            dist: {
              tarball: "https://registry.npmjs.org/@test/dep/-/dep-1.2.3.tgz",
              integrity,
            },
          },
        },
      }),
    });
  });
  await page.route("https://api.osv.dev/v1/querybatch", async (route) => {
    await route.fulfill({ contentType: "application/json", body: '{"results":[{}]}' });
  });
  await page.route("https://registry.npmjs.org/@test/dep/-/dep-1.2.3.tgz", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      contentType: "application/octet-stream",
      headers: { "content-length": String(tarball.byteLength) },
      body: tarball,
    });
  });

  await page.goto("/");
  await expect(page.locator('[data-testid="ide-root"]')).toBeVisible({ timeout: 30_000 });
  await page.locator("textarea.qce-input").fill(`
pragma solidity 0.7.6;
import "@test/dep/contracts/Dep.sol";
contract Storage {
  function getValue() public pure returns (uint256) { return Dep.one(); }
}`);
  await page.locator(".side .ptab", { hasText: "Compiler" }).click();
  await page.locator(".side .btn.block", { hasText: "Compile" }).first().click();

  await expect(page.locator(".npm-progress-modal")).toBeVisible();
  await expect(page.locator(".term-body")).toContainText("Installed @test/dep@1.2.3", { timeout: 30_000 });
  await expect(page.locator(".term-body")).toContainText("Compiled successfully", { timeout: 60_000 });
  await expect(page.locator(".npm-progress-modal")).toHaveCount(0);
});

test("declining an audit warning prevents package download", async ({ page }) => {
  let downloaded = false;
  await page.route("https://registry.npmjs.org/risky", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            dist: {
              tarball: "https://registry.npmjs.org/risky/-/risky-1.0.0.tgz",
              integrity: "sha512-unused",
            },
          },
        },
      }),
    });
  });
  await page.route("https://api.osv.dev/v1/querybatch", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: '{"results":[{"vulns":[{"id":"GHSA-test","summary":"Known test vulnerability","database_specific":{"severity":"HIGH"}}]}]}',
    });
  });
  await page.route("https://registry.npmjs.org/risky/-/risky-1.0.0.tgz", async (route) => {
    downloaded = true;
    await route.abort();
  });

  await page.goto("/");
  await expect(page.locator('[data-testid="ide-root"]')).toBeVisible({ timeout: 30_000 });
  await page.locator(".menubar .menu .label", { hasText: "File" }).click();
  await page.locator(".menubar .mi", { hasText: "Add NPM Dependency" }).click();
  const modal = page.locator(".modal", { hasText: "Add NPM Dependency" });
  await modal.locator('input[type="text"]').fill("risky");
  await modal.getByRole("button", { name: "Resolve" }).click();

  const warning = page.locator(".npm-risk-modal");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("GHSA-test");
  await expect(warning.getByRole("button", { name: "No" })).toBeFocused();
  await warning.getByRole("button", { name: "No" }).click();
  await expect(page.locator(".term-body")).toContainText("was declined");
  expect(downloaded).toBe(false);
});

function makeTar(entries: Array<[string, string]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of entries) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header[156] = "0".charCodeAt(0);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
