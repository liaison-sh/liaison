// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16.5 — End-to-end Playwright proof that a runtime-installed plugin app
// ships a UI bundle that the real frontend can dynamic-import, with the Solid
// shim resolving via the import map. The settings-page DOM mount is verified
// by the actual Phase 16 (Shopify) and Phase 17+ e2e harnesses once a plugin
// declares a manifest view; this scenario keeps the surface minimal and pins
// the loader half: install → manifest announcement → bundle fetch → import
// map + shim actually resolve `solid-js` in the live browser.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// 6-level relative — `liaison/tsconfig.json` has no alias to `scripts/`.
import { freezeApp } from "../../../../../scripts/freeze-app"
import { expect, loginAs, test } from "./fixtures/test"

test.describe("Plugin UI bundle — end-to-end mount", () => {
  test("installed plugin's ui.js is dynamic-imported and Solid runtime is shared", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // Build a fixture tarball with a SolidJS UI export.
    const workspace = mkdtempSync(join(tmpdir(), "e2e-ui-"))
    const appDir = join(workspace, "src-app")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "e2e-ui-fixture",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["e2e-ui-fixture:noop"],
      }),
    )
    writeFileSync(join(appDir, "handlers.ts"), `export const noop = async () => ({})`)
    writeFileSync(
      join(appDir, "ui.tsx"),
      `import { createSignal } from "solid-js"
       export function SettingsPanel() {
         const [n] = createSignal(42)
         return <div data-testid="e2e-ui-fixture-settings">value:{n()}</div>
       }`,
    )
    const { tarballPath } = await freezeApp({
      appName: "e2e-ui-fixture",
      appDir,
      outDir: join(workspace, "dist"),
    })

    // Install via the generic _test endpoint added in Task 9.5.
    const fd = new FormData()
    fd.append("tarball", new Blob([readFileSync(tarballPath)]), "e2e-ui-fixture.liaisonapp")
    fd.append("grantedScopes", JSON.stringify(["e2e-ui-fixture:noop"]))
    const installRes = await fetch(`${env.serverUrl}/api/_test/apps/install`, {
      method: "POST",
      body: fd,
    })
    expect(installRes.status).toBe(200)

    const reloadRes = await fetch(`${env.serverUrl}/api/_test/apps/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId: world.org.id }),
    })
    expect(reloadRes.status).toBe(200)

    // Login + capture console errors so the import map / shim failures surface.
    const consoleErrors: string[] = []
    const seenRequests: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", (err) => consoleErrors.push(err.message))
    page.on("request", (r) => seenRequests.push(r.url()))

    await loginAs(page, env, qa.admin.email, "12345678")

    // After login the frontend calls /api/apps/manifests and dynamic-imports
    // each app's UI bundle. Assert the bundle URL is present in network
    // resources, that no resolution errors fired, and that the kernel set
    // window.__liaisonSolid before the import map resolved.
    await page.waitForLoadState("networkidle")

    // Verify the kernel announces the fixture via /api/apps/manifests with a
    // non-null uiBundleUrl. The frontend's dynamic-import path depends on it.
    const manifestRes = await fetch(`${env.serverUrl}/api/apps/manifests`, {
      headers: { Authorization: `Bearer ${qa.admin.token}` },
    })
    expect(manifestRes.status).toBe(200)
    const manifestJson = (await manifestRes.json()) as {
      data: Array<{ name: string; uiBundleUrl: string | null }>
    }
    const fixtureEntry = manifestJson.data.find((a) => a.name === "e2e-ui-fixture")
    // The announced URL carries a signed `t` token for the bundle route.
    const bundleUrl = fixtureEntry?.uiBundleUrl ?? ""
    expect(bundleUrl.split("?")[0]).toBe("/api/apps/e2e-ui-fixture/1.0.0/ui.js")

    // Probe the announced bundle URL directly to confirm the route serves it.
    const directBundleRes = await fetch(`${env.serverUrl}${bundleUrl}`)
    expect(directBundleRes.status).toBe(200)
    const directBody = await directBundleRes.text()
    expect(directBody).toContain("SettingsPanel")

    // Shell.onMount → loadManifestApps fires the dynamic import() — wait for
    // the recorded request before asserting. `performance.getEntriesByType`
    // is unreliable for Vite-proxied ESM-import fetches in dev mode, so we
    // assert on the wire-level request log captured via `page.on("request")`.
    await expect
      .poll(() => seenRequests.some((u) => u.includes("/api/apps/e2e-ui-fixture/1.0.0/ui.js")), {
        timeout: 10000,
      })
      .toBe(true)

    const shims = await page.evaluate(() => ({
      // biome-ignore lint/suspicious/noExplicitAny: window-global shim probe
      solid: typeof (window as any).__liaisonSolid?.createSignal === "function",
      // biome-ignore lint/suspicious/noExplicitAny: window-global shim probe
      solidWeb: typeof (window as any).__liaisonSolidWeb?.render === "function",
      // biome-ignore lint/suspicious/noExplicitAny: window-global shim probe
      solidStore: typeof (window as any).__liaisonSolidStore?.createStore === "function",
    }))
    expect(shims.solid).toBe(true)
    expect(shims.solidWeb).toBe(true)
    expect(shims.solidStore).toBe(true)

    // Pin: no "Failed to fetch dynamically imported module" or "does not
    // provide an export named" errors — those mean the import map or the
    // Solid shim is broken.
    expect(
      consoleErrors.filter((m) =>
        /Failed to fetch dynamically imported module|does not provide an export named/.test(m),
      ),
    ).toEqual([])

    rmSync(workspace, { recursive: true, force: true })
  })
})
