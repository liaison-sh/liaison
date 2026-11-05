// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The rail on a short window. With more apps than the rail is tall, it draws
// the icons that fit and ends on a "+N" control; pointing at it, clicking it
// or dragging an app onto it opens the rail into extra columns to the right,
// laid over the sidebar. Every app is reachable and can be dragged to any
// slot, and nothing on the folded rail is drawn past its bottom edge.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WorkerEnv } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
// 6-level relative — `liaison/tsconfig.json` has no alias to `scripts/`.
import { freezeApp } from "../../../../../scripts/freeze-app"
import { expect, loginAs, test } from "./fixtures/test"

const RAIL_APPS =
  '[data-testid="activity-bar-apps"] [data-testid^="activity-"]:not([data-testid^="activity-bar-"])'

/** Every rail app button sits fully inside the app column: nothing is cut off. */
async function expectNothingClipped(page: Page): Promise<void> {
  const column = await page.getByTestId("activity-bar-apps").boundingBox()
  expect(column).not.toBeNull()
  const buttons = page.locator(RAIL_APPS)
  const more = page.getByTestId("activity-bar-more")
  const all: Locator[] = [...(await buttons.all())]
  if ((await more.count()) > 0) all.push(more)
  for (const button of all) {
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    if (!box || !column) continue
    expect(box.y).toBeGreaterThanOrEqual(column.y - 0.5)
    expect(box.y + box.height).toBeLessThanOrEqual(column.y + column.height + 0.5)
  }
}

/** Installs `count` minimal plugin apps, each with its own rail entry, through
 *  the real install route: enough apps that the rail cannot draw them all on
 *  a short window. */
async function installRailApps(env: WorkerEnv, orgId: string, count: number): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "e2e-rail-"))
  try {
    for (let i = 0; i < count; i++) {
      const name = `e2e-rail-${i}`
      const appDir = join(workspace, name)
      mkdirSync(appDir, { recursive: true })
      writeFileSync(
        join(appDir, "app.manifest.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          packageFormat: 1,
          license: "MIT",
          scopes: [`${name}:noop`],
          views: {
            activityBar: {
              icon: "RailIcon",
              label: `Rail app ${i}`,
              order: 500 + i,
              tabAction: { type: "home", entityId: "home", label: `Rail app ${i}` },
            },
            tabTypes: { home: { component: "RailHome", label: `Rail app ${i}` } },
          },
        }),
      )
      writeFileSync(join(appDir, "handlers.ts"), "export const noop = async () => ({})")
      writeFileSync(
        join(appDir, "ui.tsx"),
        `export function RailIcon(props: { size?: number }) {
           return <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" fill="currentColor" /></svg>
         }
         export function RailHome() {
           return <div data-testid="${name}-home">Rail app ${i}</div>
         }`,
      )
      const { tarballPath } = await freezeApp({
        appName: name,
        appDir,
        outDir: join(workspace, "dist", name),
      })
      const fd = new FormData()
      fd.append("tarball", new Blob([readFileSync(tarballPath)]), `${name}.liaisonapp`)
      fd.append("grantedScopes", JSON.stringify([`${name}:noop`]))
      const res = await fetch(`${env.serverUrl}/api/_test/apps/install`, {
        method: "POST",
        body: fd,
      })
      expect(res.status, await res.clone().text()).toBe(200)
    }
    const reload = await fetch(`${env.serverUrl}/api/_test/apps/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId }),
    })
    expect(reload.status).toBe(200)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** Rail entry testids in DOM order: column one top to bottom, then column two. */
async function railOrder(page: Page): Promise<string[]> {
  const ids: string[] = []
  for (const button of await page.locator(RAIL_APPS).all()) {
    const id = await button.getAttribute("data-testid")
    if (id) ids.push(id)
  }
  return ids
}

test.describe("activity bar overflow", () => {
  test("the QA world on a standard window clips nothing on the rail", async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.getByTestId("activity-bar")).toBeVisible()
    await expectNothingClipped(page)
    const more = page.getByTestId("activity-bar-more")
    if ((await more.count()) > 0) {
      // Some apps are folded away: the open rail still shows them all.
      const behind = Number(await more.getAttribute("data-overflow-count"))
      const onRail = await page.locator(RAIL_APPS).count()
      await more.click()
      await expect(page.locator(RAIL_APPS)).toHaveCount(onRail + behind)
      console.log(`[rail] overflow at 1440x900: ${behind} folded away`)
    } else {
      console.log("[rail] all apps fit at 1440x900")
    }
  })

  test("a short window opens the rail into columns and reorders across them", async ({
    page,
    env,
    world,
    qa,
  }) => {
    await installRailApps(env, world.org.id, 8)
    await page.setViewportSize({ width: 1440, height: 700 })
    await loginAs(page, env, qa.admin.email, "12345678")
    const rail = page.getByTestId("activity-bar")
    const track = page.getByTestId("activity-bar-apps-track")
    await expect(rail).toBeVisible()
    const more = page.getByTestId("activity-bar-more")
    // The installed apps register once their manifests load.
    await expect(more).toBeVisible({ timeout: 20000 })
    await expect
      .poll(async () => Number(await more.getAttribute("data-overflow-count")), { timeout: 20000 })
      .toBeGreaterThanOrEqual(1)
    await expect(page.getByTestId("activity-rail-app-7")).toHaveCount(0, { timeout: 20000 })
    await expect(more).toHaveAttribute("aria-expanded", "false")
    await expect(more).toHaveText(/^\+\d+$/)
    await expect(track).toHaveAttribute("data-columns", "1")
    await expectNothingClipped(page)
    const behind = Number(await more.getAttribute("data-overflow-count"))
    const onRail = await page.locator(RAIL_APPS).count()
    const sidebar = page.getByTestId("sidebar")
    const sidebarBefore = (await sidebar.count()) > 0 ? await sidebar.boundingBox() : null

    // A plain pass of the pointer down the rail does not open it.
    const railBox = await rail.boundingBox()
    expect(railBox).not.toBeNull()
    if (!railBox) return
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + 20)
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height - 20, {
      steps: 8,
    })
    await page.mouse.move(900, 400)
    await expect(track).toHaveAttribute("data-columns", "1")

    // Pointing at "+N" opens it: every app, in columns to the right, laid over
    // the sidebar without moving it.
    await more.hover()
    await expect(track).not.toHaveAttribute("data-columns", "1")
    await expect(rail).toHaveAttribute("data-rail-open", "true")
    await expect(more).toHaveCount(0)
    await expect(page.locator(RAIL_APPS)).toHaveCount(onRail + behind)
    const firstBox = await page.locator(RAIL_APPS).first().boundingBox()
    const lastBox = await page.getByTestId("activity-rail-app-7").boundingBox()
    expect(firstBox && lastBox && lastBox.x > firstBox.x + firstBox.width).toBe(true)
    if (sidebarBefore) expect(await sidebar.boundingBox()).toEqual(sidebarBefore)

    // The pointer leaving the rail folds it.
    await page.mouse.move(900, 400)
    await expect(track).toHaveAttribute("data-columns", "1")
    await expect(more).toBeVisible()
    await expectNothingClipped(page)

    // Keyboard: "+N" opens on Enter, focus lands on the first folded app,
    // Escape folds it and hands focus back to "+N".
    await more.focus()
    await page.keyboard.press("Enter")
    await expect(track).not.toHaveAttribute("data-columns", "1")
    await expect(page.locator(`${RAIL_APPS}:focus`)).toHaveCount(1)
    await page.keyboard.press("Escape")
    await expect(track).toHaveAttribute("data-columns", "1")
    await expect(more).toBeFocused()

    // Drag the last app from the second column to the top of the first: the
    // order persists, so the app now stays on the folded rail, across a reload.
    await more.click()
    const firstId = (await railOrder(page))[0]
    expect(firstId).toBeTruthy()
    await page.getByTestId("activity-rail-app-7").dragTo(page.getByTestId(firstId ?? ""))
    await expect.poll(async () => (await railOrder(page))[0]).toBe("activity-rail-app-7")
    await page.mouse.move(900, 400)
    await expect(track).toHaveAttribute("data-columns", "1")
    await expect(page.getByTestId("activity-rail-app-7")).toBeVisible()
    await page.reload()
    await expect(page.getByTestId("activity-bar-more")).toBeVisible({ timeout: 20000 })
    await expect
      .poll(async () => (await railOrder(page))[0], { timeout: 20000 })
      .toBe("activity-rail-app-7")

    // The app chosen from the second column opens; folded, it keeps a slot.
    await page.getByTestId("activity-bar-more").click()
    const lastInOrder = (await railOrder(page)).at(-1)
    expect(lastInOrder).toBeTruthy()
    await page.getByTestId(lastInOrder ?? "").click()
    await page.mouse.move(900, 400)
    await expect(track).toHaveAttribute("data-columns", "1")
    const railEntry = page.getByTestId(lastInOrder ?? "")
    await expect(railEntry).toBeVisible()
    await expect(railEntry).toHaveAttribute("aria-current", "page")
    await expectNothingClipped(page)
  })
})
