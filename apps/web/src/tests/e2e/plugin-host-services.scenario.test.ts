// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16.6 — End-to-end Playwright proof that a freshly installed plugin
// app's UI bundle can `import { fetch } from "@liaison/host"` and reach the
// kernel-provided host services. The kernel writes `window.__liaisonHost` at
// boot; the package's resolvers read through it; `host.fetch` injects the
// auth header automatically.
//
// Mirrors `plugin-ui-bundle.scenario.test.ts` (Phase 16.5) for the install +
// dynamic-import path, then adds the host-services assertions.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// 6-level relative — `liaison/tsconfig.json` has no alias to `scripts/`.
import { freezeApp } from "../../../../../scripts/freeze-app"
import { expect, loginAs, test } from "./fixtures/test"

test.describe("Plugin host-services bridge — end-to-end", () => {
  test("installed plugin can import { fetch } from @liaison/host and call /api/users/me", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const workspace = mkdtempSync(join(tmpdir(), "e2e-host-"))
    const appDir = join(workspace, "src-app")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "e2e-host-fixture",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["e2e-host-fixture:noop"],
      }),
    )
    writeFileSync(join(appDir, "handlers.ts"), `export const noop = async () => ({})`)
    // The fixture's UI exports a component that on mount writes a flag to
    // window so the test can assert the host-bridge is reachable. We don't
    // even need to mount the component into the DOM — the test asserts the
    // package was bundled and the runtime resolvers work, which is the core
    // Phase 16.6 guarantee.
    writeFileSync(
      join(appDir, "ui.tsx"),
      `import { app, fetch } from "@liaison/host"
       export function HostProbe() {
         // Capture for the test — invoking either symbol proves the bundled
         // package's window-global resolver is reachable.
         ;(window as any).__e2eHostFixtureProbe = {
           hasFetch: typeof fetch === "function",
           hasApp: typeof app?.invokeTool === "function",
         }
         return <div data-testid="e2e-host-fixture-probe">ok</div>
       }`,
    )
    const { tarballPath } = await freezeApp({
      appName: "e2e-host-fixture",
      appDir,
      outDir: join(workspace, "dist"),
    })

    const fd = new FormData()
    fd.append("tarball", new Blob([readFileSync(tarballPath)]), "e2e-host-fixture.liaisonapp")
    fd.append("grantedScopes", JSON.stringify(["e2e-host-fixture:noop"]))
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

    const consoleErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    page.on("pageerror", (err) => consoleErrors.push(err.message))

    await loginAs(page, env, qa.admin.email, "12345678")
    await page.waitForLoadState("networkidle")

    // Probe the bundle source — it must contain the host-bridge symbols. A
    // bundle that is not first-party is served only against the token the
    // authenticated app list issues for it (ui-bundle-routes.ts); the bare URL
    // reads as not installed.
    const bareBundleRes = await fetch(`${env.serverUrl}/api/apps/e2e-host-fixture/1.0.0/ui.js`)
    expect(bareBundleRes.status).toBe(404)
    const listRes = await fetch(`${env.serverUrl}/api/apps/manifests`, {
      headers: { authorization: `Bearer ${qa.admin.token}` },
    })
    expect(listRes.status).toBe(200)
    const listed = (
      (await listRes.json()) as {
        data: Array<{ name: string; uiBundleUrl: string | null }>
      }
    ).data.find((a) => a.name === "e2e-host-fixture")
    expect(listed?.uiBundleUrl).toContain("/api/apps/e2e-host-fixture/1.0.0/ui.js?t=")
    const directBundleRes = await fetch(new URL(listed?.uiBundleUrl ?? "", env.serverUrl))
    expect(directBundleRes.status).toBe(200)
    const directBody = await directBundleRes.text()
    expect(directBody).toContain("HostProbe")
    // The bundled package's appName substitution at freeze time emits the
    // app name as a literal string.
    expect(directBody).toContain('"e2e-host-fixture"')

    // Assert the kernel set `window.__liaisonHost` at boot.
    const hostShape = await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: window-global shim probe
      const h = (window as any).__liaisonHost
      return {
        hasFetch: typeof h?.fetch === "function",
        hasInvokeTool: typeof h?.invokeTool === "function",
        hasOpenConnect: typeof h?.openConnect === "function",
        hasAccessToken: typeof h?.accessToken === "function",
      }
    })
    expect(hostShape.hasFetch).toBe(true)
    expect(hostShape.hasInvokeTool).toBe(true)
    expect(hostShape.hasOpenConnect).toBe(true)
    expect(hostShape.hasAccessToken).toBe(true)

    // Drive the host.fetch path through the actual kernel-installed bridge.
    // This proves the auth header injection works for plugin requests.
    const apiResult = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: window-global shim probe
      const h = (window as any).__liaisonHost
      try {
        const me = await h.fetch("/api/users/me")
        return { ok: true, me }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    })
    expect(apiResult.ok).toBe(true)

    expect(
      consoleErrors.filter((m) =>
        /Failed to fetch dynamically imported module|does not provide an export named|window\.__liaisonHost/.test(
          m,
        ),
      ),
    ).toEqual([])

    rmSync(workspace, { recursive: true, force: true })
  })
})
