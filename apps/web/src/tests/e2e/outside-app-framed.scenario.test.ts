// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An OUTSIDE app, framed, in the real web app (S2). The fixture
// (`outside-app/metrics-fixture`) is shaped like a real metrics registry app:
// its UI reads its own tools through `app.invokeTool` inside
// `app.createResource`, follows the reader's language with `hostLocale`, opens
// its settings page with `navigate`, moves the page with a plain `<a href>` and
// marks its active row from the page's path (`currentPath`), ships a custom settings component and
// draws its icon from manifest data (`iconSvg`). It is installed like any
// outside package, never compiled into this build.
//
// IN A PLAIN BROWSER TAB (S16). No shell is emulated: an app that is not
// first-party runs in the sandboxed frame in a browser too, its document served
// by the server beside its bundle (`/api/apps/<name>/<version>/frame`, the
// shells' frame runtime and policy, the policy as a response header). Nothing
// of the app's code runs in the page, and the frame's opaque origin holds no
// session cookie.
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { appFramePolicy } from "@liaison/shared"
// 6-level relative — `liaison/tsconfig.json` has no alias to `scripts/`.
import { freezeApp } from "../../../../../scripts/freeze-app"
import { expect, loginAs, test } from "./fixtures/test"

const APP = "metrics-fixture"
const FIXTURE_DIR = resolve(__dirname, "outside-app", APP)

/** The SVG markup an `<img>` data URL carries. */
function decodeSvgDataUrl(src: string): string {
  const comma = src.indexOf(",")
  const meta = src.slice(0, comma)
  const body = src.slice(comma + 1)
  return meta.endsWith(";base64")
    ? Buffer.from(body, "base64").toString("utf8")
    : decodeURIComponent(body)
}

test.describe("Outside app, framed in a browser tab", () => {
  test("a metrics-shaped outside app works framed: icon, own tools, settings, unsupported calls", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "app.manifest.json"), "utf8")) as {
      iconSvg: string
      scopes: string[]
    }
    const workspace = mkdtempSync(join(tmpdir(), "e2e-outside-app-"))
    try {
      const { tarballPath } = await freezeApp({
        appName: APP,
        appDir: FIXTURE_DIR,
        outDir: join(workspace, "dist"),
      })
      const fd = new FormData()
      fd.append("tarball", new Blob([readFileSync(tarballPath)]), `${APP}.liaisonapp`)
      fd.append("grantedScopes", JSON.stringify(manifest.scopes))
      const installRes = await fetch(`${env.serverUrl}/api/_test/apps/install`, {
        method: "POST",
        body: fd,
      })
      expect(installRes.status, await installRes.clone().text()).toBe(200)
      const reloadRes = await fetch(`${env.serverUrl}/api/_test/apps/reload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: world.org.id }),
      })
      expect(reloadRes.status).toBe(200)

      const consoleErrors: string[] = []
      page.on("pageerror", (err) => consoleErrors.push(err.message))
      // The page never loads the app's bundle as a script: it fetches its text
      // for the frame. Every frame document response is kept, for its headers.
      const bundleScripts: string[] = []
      const frameDocuments: Array<{ url: string; csp: string | undefined; status: number }> = []
      page.on("request", (req) => {
        if (req.url().includes(`/api/apps/${APP}/`) && req.resourceType() === "script") {
          bundleScripts.push(req.url())
        }
      })
      page.on("response", (res) => {
        if (
          new URL(res.url()).pathname.startsWith(`/api/apps/${APP}/`) &&
          res.url().includes("/frame")
        ) {
          frameDocuments.push({
            url: res.url(),
            csp: res.headers()["content-security-policy"],
            status: res.status(),
          })
        }
      })

      await loginAs(page, env, qa.admin.email, "12345678")
      await page.reload()
      await page.waitForSelector("[data-shell]", { timeout: 60_000 })
      // A plain browser tab: no shell globals.
      expect(
        await page.evaluate(() => {
          const g = globalThis as Record<string, unknown>
          return [g.__LIAISON_SERVER_ADDRESS__, g.__LIAISON_APP_FRAME_URL__, g.__LIAISON_NATIVE__]
        }),
      ).toEqual([undefined, undefined, undefined])

      // 1. The activity bar icon is the manifest's SVG, as an image, never markup.
      const entry = page.getByTestId("activity-metrics")
      await expect(entry).toBeVisible({ timeout: 30_000 })
      const icon = entry.getByTestId("isolated-app-icon")
      await expect(icon).toHaveCount(1)
      expect(await icon.evaluate((el) => el.tagName)).toBe("IMG")
      const src = (await icon.getAttribute("src")) ?? ""
      expect(src.startsWith("data:image/svg+xml")).toBe(true)
      expect(decodeSvgDataUrl(src)).toBe(manifest.iconSvg)
      await expect(page.locator('svg path[d="M3 3v18h18"]')).toHaveCount(0)

      // 2. The explorer, framed, lists the registry its own tool returns.
      await entry.click()
      const explorerFrame = page.locator(`[data-testid="isolated-app-frame"][data-app="${APP}"]`)
      await expect(explorerFrame).toHaveCount(1, { timeout: 15_000 })
      // The server's frame document for this app, sandboxed to an opaque origin.
      const frameSrc = (await explorerFrame.getAttribute("src")) ?? ""
      expect(new URL(frameSrc).origin).toBe(new URL(page.url()).origin)
      expect(new URL(frameSrc).pathname).toMatch(new RegExp(`^/api/apps/${APP}/[^/]+/frame$`))
      expect(new URL(frameSrc).searchParams.get("t")).toBeTruthy()
      const sandbox = ((await explorerFrame.getAttribute("sandbox")) ?? "").split(/\s+/)
      expect(sandbox).toContain("allow-scripts")
      expect(sandbox).not.toContain("allow-same-origin")
      const explorer = page.frameLocator(`[data-testid="isolated-app-frame"][data-app="${APP}"]`)
      const metrics = explorer.getByTestId("metrics-fixture-metric")
      await expect(metrics).toHaveCount(3, { timeout: 20_000 })
      await expect(metrics.nth(0)).toHaveText("Active members (1.2.0)")
      await expect(metrics.nth(1)).toHaveAttribute("data-metric-id", "revenue.monthly")
      // hostLocale reaches the frame.
      await expect(explorer.getByTestId("metrics-fixture-locale")).toHaveText(/^en/)

      // The document came with its policy as a response header, and the frame
      // cannot read the session cookie: its origin is opaque.
      expect(frameDocuments.length).toBeGreaterThan(0)
      const served = frameDocuments[0]
      expect(served.status).toBe(200)
      const nonce = /'nonce-([0-9a-f]+)'/.exec(served.csp ?? "")?.[1] ?? ""
      expect(served.csp).toBe(
        `${appFramePolicy(nonce)}; frame-ancestors 'self'; sandbox allow-scripts allow-forms`,
      )
      const appFrame = page.frames().find((f) => f.url().includes(`/api/apps/${APP}/`))
      if (!appFrame) throw new Error("the app's frame is not in the page")
      expect(
        await appFrame.evaluate(() => {
          try {
            return `read:${document.cookie}`
          } catch (err) {
            return `refused:${(err as Error).name}`
          }
        }),
      ).toBe("refused:SecurityError")
      expect(await appFrame.evaluate(() => window.origin)).toBe("null")

      // 3. A host method the host does not have answers unsupported, at once.
      await explorer.getByTestId("metrics-fixture-probe-unknown").click()
      await expect(explorer.getByTestId("metrics-fixture-probe-result")).toHaveText("unsupported", {
        timeout: 2_000,
      })

      // 3b. A plain in-app link moves the PAGE, through the host's navigate: the
      // frame stays on its own document (a frame that leaves it is stopped), and
      // the app sees the page's new path, so its active row follows.
      await expect(explorer.getByTestId("metrics-fixture-path")).toHaveText(`/${APP}`)
      await expect(explorer.getByTestId("metrics-fixture-link")).toHaveAttribute(
        "data-active",
        "false",
      )
      await explorer.getByTestId("metrics-fixture-link").click()
      await expect(page).toHaveURL(new RegExp(`/${APP}/revenue\\.monthly$`), { timeout: 15_000 })
      await expect(explorer.getByTestId("metrics-fixture-path")).toHaveText(
        `/${APP}/revenue.monthly`,
        { timeout: 10_000 },
      )
      await expect(explorer.getByTestId("metrics-fixture-link")).toHaveAttribute(
        "data-active",
        "true",
      )
      await expect(page.getByTestId("isolated-app-stopped")).toHaveCount(0)
      await expect(metrics).toHaveCount(3)
      expect(appFrame.url()).toContain(`/api/apps/${APP}/`)

      // 4. navigate to its own settings page works, and its custom settings
      // component renders there, framed, reading its own tool.
      await explorer.getByTestId("metrics-fixture-open-settings").click()
      await expect(page).toHaveURL(new RegExp(`/settings/apps/${APP}$`), { timeout: 15_000 })
      // The explorer tab stays open behind it: the settings frame is the one
      // the settings page's custom block holds.
      const settings = page
        .getByTestId("settings-custom-MetricsSettings")
        .frameLocator(`[data-testid="isolated-app-frame"][data-app="${APP}"]`)
      await expect(settings.getByTestId("metrics-fixture-settings-status")).toHaveText(
        "Connected, formula 3.1.0, 3 metrics",
        { timeout: 20_000 },
      )

      // 5. An app that sends its own frame elsewhere is stopped: the page tears
      // the frame down and posts nothing to whatever loaded there.
      const settingsFrame = await (
        await page
          .getByTestId("settings-custom-MetricsSettings")
          .locator(`[data-testid="isolated-app-frame"][data-app="${APP}"]`)
          .elementHandle()
      )?.contentFrame()
      if (!settingsFrame) throw new Error("the settings frame is not in the page")
      await settingsFrame.evaluate(() => {
        window.location.href = "about:blank"
      })
      await expect(
        page.getByTestId("settings-custom-MetricsSettings").getByTestId("isolated-app-stopped"),
      ).toHaveCount(1, { timeout: 10_000 })

      expect(consoleErrors).toEqual([])
      expect(bundleScripts).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
