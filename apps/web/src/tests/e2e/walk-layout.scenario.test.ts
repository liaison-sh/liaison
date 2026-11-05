// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Desktop defects from the 2026-09-22 live walk, measured in a real browser:
// an activity-bar tooltip swallowing the next icon's click, the SLA settings
// hour inputs spilling out of their card, and "+ Add source" painted dark on
// dark.
import { expect, loginAs, test } from "./fixtures/test"

test.use({ viewport: { width: 1440, height: 900 } })

const SEE = { timeout: 20_000 } as const
const SHOT_DIR = process.env.WALK_SHOT_DIR

function luminance([r, g, b]: number[]): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function rgb(css: string): number[] {
  const m = css.match(/[\d.]+/g)
  if (!m) throw new Error(`unparsable color ${css}`)
  return m.slice(0, 3).map(Number)
}

test("walk-layout.desktop: tooltip, SLA hours card, Add source contrast", async ({ page, env }) => {
  await loginAs(page, env, "admin@test.com", "12345678")
  const base = `http://localhost:${env.ports[1]}`
  await expect(page.locator("[data-shell][data-shell-ready='true']")).toBeVisible(SEE)

  // ── Tooltip: hover + click Search, then Mail must take the click at once.
  const search = page.getByTestId("activity-search")
  await search.hover()
  await page.waitForTimeout(600) // past the 300 ms open delay: the hint is up
  await search.click()
  await page.waitForTimeout(600)
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/tooltip-after-click.png` })
  // The walk: 30 s of "element intercepts pointer events". 3 s is plenty.
  await page.getByTestId("activity-mail").click({ timeout: 3_000 })

  // ── SLA settings (Tickets page, Response times & email): every hour input
  // stays inside its section.
  await page.goto(`${base}/settings/tickets/sla-email`)
  const start = page.getByTestId("settings-input-sla.businessHours.weekly-mon-start")
  await expect(start).toBeVisible(SEE)
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/sla-email.png` })
  const spill = await page.evaluate(() => {
    const out: string[] = []
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="time"]')) {
      const card = input.closest("section")
      if (!card) continue
      const a = input.getBoundingClientRect()
      const c = card.getBoundingClientRect()
      if (a.right > c.right + 1 || a.left < c.left - 1) out.push(input.dataset.testid ?? "?")
    }
    return out
  })
  expect(spill).toEqual([])

  // ── Synced sources: the Add button's text is readable on its fill.
  await page.goto(`${base}/settings/knowledge/synced-sources`)
  const add = page.getByTestId("synced-sources-add-button")
  await expect(add).toBeVisible(SEE)
  if (SHOT_DIR) await add.screenshot({ path: `${SHOT_DIR}/add-source.png` })
  const { color, background } = await add.evaluate((el) => {
    const s = getComputedStyle(el)
    return { color: s.color, background: s.backgroundColor }
  })
  const [l1, l2] = [luminance(rgb(color)), luminance(rgb(background))].sort((a, b) => b - a)
  expect((l1 + 0.05) / (l2 + 0.05)).toBeGreaterThanOrEqual(4.5)
  const lines = await add.evaluate((el) => Math.round(el.getBoundingClientRect().height))
  // One line: a default button is 40 px tall, a wrapped label at least 56.
  expect(lines).toBeLessThanOrEqual(40)
})
