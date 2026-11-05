// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M3 fix round, item 6: the Monitoring incident board at 390 px.
//
// Monitoring went through the whole CardTable conversion with no browser test
// of any kind: its board could have rendered a sideways table, or nothing, and
// every suite would still have been green. This is its first real driver. The
// app installs from its frozen `.liaisonapp` through the harness install route,
// one incident is seeded the way the alert webhook writes one, and the board is
// judged at the phone tier: cards, no table, the triage action reachable, and
// nothing spilling past the viewport.
import { resolve } from "node:path"
import { bundledAppTarball } from "./bundled-app-tarball"
import { expect, loginAs, test } from "./fixtures/test"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

// __dirname = liaison/apps/web/src/tests/e2e
const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..")
const MONITORING_BUNDLE = bundledAppTarball(LIAISON_ROOT, "monitoring")

const INCIDENT_TITLE = "Disk usage above 90 percent on node-a"

async function post(
  serverUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

test.describe("Monitoring incident board at phone width", () => {
  test.setTimeout(120_000)

  test.beforeAll(async ({ env, world, qa }) => {
    await post(env.serverUrl, qa.admin.token, "/api/_test/monitoring/install-for-test", {
      orgId: world.org.id,
      bundlePath: MONITORING_BUNDLE,
    })
  })

  test("the incident board is rows, not a sideways table, and Ack is a tap away", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const seeded = await post(
      env.serverUrl,
      qa.admin.token,
      "/api/_test/monitoring/seed-incident",
      {
        orgId: world.org.id,
        title: INCIDENT_TITLE,
        severity: "critical",
        status: "open",
      },
    )
    const incidentId = seeded.incidentId as string

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/monitoring`)
    await page.waitForLoadState("networkidle")

    await expect(page.getByTestId("monitoring-dashboard")).toBeVisible({ timeout: 20_000 })

    // (a) The seeded incident is on the board as a one-line row (the Overview's
    //     incident row since the monitoring redesign, not a CardTable card).
    const row = page.getByTestId(`monitoring-incident-row-${incidentId}`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText(INCIDENT_TITLE)

    // (b) No table at this width.
    expect(await page.locator("table").count()).toBe(0)
    await expectNoHorizontalClipping(page)

    // (c) Ack is reachable: the row's hover actions are hidden below md, and a
    //     tap on the row opens the incident, whose header carries Ack.
    await expect(page.getByTestId(`monitoring-ack-${incidentId}`)).toBeHidden()
    await row.tap()
    const detail = page.getByTestId("monitoring-incident-detail")
    await expect(detail).toBeVisible({ timeout: 20_000 })
    const ack = page.getByTestId("monitoring-detail-ack")
    await expect(ack).toBeVisible()
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    const box = await ack.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth)

    // (d) Nothing is clipped on the incident either.
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m3fx-monitoring.png`, fullPage: true })

    // (e) And the action actually triages the incident.
    await ack.tap()
    await expect(page.getByTestId("monitoring-detail-status")).toContainText(/Acknowledged/i, {
      timeout: 20_000,
    })
    await expectNoHorizontalClipping(page)
  })
})
