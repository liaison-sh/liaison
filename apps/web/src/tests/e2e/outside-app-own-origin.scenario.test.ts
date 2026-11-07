// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An OUTSIDE app's screen on an ORIGIN OF ITS OWN (LIAISON_APP_FRAME_ORIGIN_TEMPLATE).
//
// Two origins on one machine: the page is the worker's Vite server
// (`http://localhost:<vite>`), and the frame host is the API's own port under the
// template `http://{app}--{org}.localhost:<api>` (Chromium resolves *.localhost to
// loopback; the frame host serves only its frame document, straight from the API).
// The same metrics-shaped fixture as outside-app-framed: framed, it lists its own
// tool's registry (invokeTool), reads its org from the host's context, and asks the
// host to open files by id (openFile): one its own tool result named (the host
// fetches it), one it never saw (refused before any fetch).
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
// 6-level relative — `liaison/tsconfig.json` has no alias to `scripts/`.
import { freezeApp } from "../../../../../scripts/freeze-app"
import { createProfiledE2ETest } from "./fixtures/profiled-test"
import { expect, loginAs } from "./fixtures/test"

const APP = "metrics-fixture"
const FIXTURE_DIR = resolve(__dirname, "outside-app", APP)

const test = createProfiledE2ETest({
  workerIdOffset: 280,
  portCount: 2,
  before: async (ports) => ({
    env: {
      LIAISON_APP_FRAME_ORIGIN_TEMPLATE: `http://{app}--{org}.localhost:${ports[0]}`,
      // The page's origin, the frame's only ancestor and correspondent.
      ALLOWED_ORIGINS: `http://localhost:${ports[1]}`,
    },
    teardowns: [],
  }),
})

test.describe("Outside app, framed on its own origin", () => {
  test("its frame keeps an origin of its own, talks to the page only, and opens files through the host", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "app.manifest.json"), "utf8")) as {
      scopes: string[]
    }
    const workspace = mkdtempSync(join(tmpdir(), "e2e-own-origin-app-"))
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

      const pageErrors: string[] = []
      page.on("pageerror", (err) => pageErrors.push(err.message))
      const fileRequests: string[] = []
      page.on("request", (req) => {
        const url = new URL(req.url())
        if (url.pathname.startsWith("/api/files/")) fileRequests.push(url.pathname)
      })
      const frameDocs: Array<{ url: string; headers: Record<string, string>; status: number }> = []
      page.on("response", (res) => {
        if (new URL(res.url()).pathname.startsWith("/frame/")) {
          frameDocs.push({ url: res.url(), headers: res.headers(), status: res.status() })
        }
      })

      await loginAs(page, env, qa.admin.email, "12345678")
      await page.reload()
      await page.waitForSelector("[data-shell]", { timeout: 60_000 })
      const pageOrigin = new URL(page.url()).origin

      await page.getByTestId("activity-metrics").click()
      const frameEl = page.locator(`[data-testid="isolated-app-frame"][data-app="${APP}"]`)
      await expect(frameEl).toHaveCount(1, { timeout: 15_000 })

      // The frame is the app's own host, minted for this org, and keeps that origin.
      const src = new URL((await frameEl.getAttribute("src")) ?? "")
      expect(src.hostname).toMatch(new RegExp(`^${APP}--[a-z0-9-]+\\.localhost$`))
      expect(src.port).toBe(String(env.ports[0]))
      expect(src.pathname).toMatch(/^\/frame\/\d+\.\d+\.\d+$/)
      const sandbox = ((await frameEl.getAttribute("sandbox")) ?? "").split(/\s+/)
      expect(sandbox).toEqual(["allow-scripts", "allow-forms", "allow-same-origin"])

      // 1. invokeTool: the registry its own tool returns, through the page.
      const frame = page.frameLocator(`[data-testid="isolated-app-frame"][data-app="${APP}"]`)
      const metrics = frame.getByTestId("metrics-fixture-metric")
      await expect(metrics).toHaveCount(3, { timeout: 20_000 })
      await expect(frame.getByTestId("metrics-fixture-context-org")).toHaveText(world.org.id)

      // The document: framed by this page only, no X-Frame-Options, no cookie.
      expect(frameDocs.length).toBeGreaterThan(0)
      const doc = frameDocs[0]
      expect(doc.status).toBe(200)
      expect(doc.headers["content-security-policy"]).toContain(`frame-ancestors ${pageOrigin}`)
      expect(doc.headers["content-security-policy"]).toContain(
        "sandbox allow-scripts allow-forms allow-same-origin",
      )
      expect(doc.headers["content-security-policy"]).toContain("connect-src 'none'")
      expect(doc.headers["x-frame-options"]).toBeUndefined()
      expect(doc.headers["set-cookie"]).toBeUndefined()

      // Its own origin: real storage, and none of the page's cookies.
      const appFrame = page.frames().find((f) => f.url().startsWith(src.origin))
      if (!appFrame) throw new Error("the app's frame is not in the page")
      expect(await appFrame.evaluate(() => window.origin)).toBe(src.origin)
      expect(
        await appFrame.evaluate(() => {
          localStorage.setItem("probe", "kept")
          return `${localStorage.getItem("probe")}|${document.cookie}`
        }),
      ).toBe("kept|")
      const context = page.context()
      const cookiesForFrame = await context.cookies(src.origin)
      expect(cookiesForFrame).toEqual([])

      // The frame host serves nothing else: not the web app, not the API.
      for (const path of ["/", "/api/apps/manifests", "/api/auth/refresh"]) {
        const res = await page.request.get(`${src.origin}${path}`)
        expect({ path, status: res.status() }).toEqual({ path, status: 404 })
      }

      // 2. openFile: a file its own tool result named is fetched by the host (it does not
      // exist here, so the host reports the failure); one it never saw is refused before
      // any fetch of its bytes.
      await frame.getByTestId("metrics-fixture-open-foreign").click()
      await expect(frame.getByTestId("metrics-fixture-file-outcome")).toHaveText(
        "openFile: not a file of this app",
        { timeout: 10_000 },
      )
      expect(fileRequests).not.toContain("/api/files/someone-elses-file-0001/inline")
      await frame.getByTestId("metrics-fixture-open-report").click()
      await expect
        .poll(() => fileRequests.includes("/api/files/fixture-report-0001/inline"), {
          timeout: 10_000,
        })
        .toBe(true)
      await expect(frame.getByTestId("metrics-fixture-file-outcome")).not.toHaveText(
        "openFile: not a file of this app",
      )

      // (Messages from any other origin are dropped both ways: isolated-app.test.tsx and
      // app-frame/runtime.test.ts.)
      await expect(metrics).toHaveCount(3)
      expect(pageErrors).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
