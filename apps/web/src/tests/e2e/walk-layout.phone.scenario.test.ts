// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Layout defects from the 2026-09-22 live walk, measured in a real browser at
// 390x844: the project title ran under the list/kanban toggle and task titles
// were cut to three letters; the calendar month title read "Sept…"; the
// Knowledge CTA folded against the title. Geometry, not class names.
import type { Locator, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"
import { expectNoHorizontalClipping } from "./phone-helpers"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
})

const SEE = { timeout: 20_000 } as const
const SHOT_DIR = process.env.WALK_SHOT_DIR

async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error("element has no box")
  return b
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

async function shot(page: Page, name: string) {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png` })
}

test("walk-layout.phone: project detail, calendar and knowledge headers fit 390px", async ({
  page,
  env,
  qa,
  world,
}) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  const seeded = await seedProjectWithTasks(env, qa.admin.token, {
    name: "RJ & Régulation",
    tasks: [
      { title: "Rapport mensuel au mandataire judiciaire", statusLabel: "backlog" },
      { title: "Point d'étape avec l'administrateur", statusLabel: "backlog" },
    ],
  })

  await loginAs(page, env, "admin@test.com", "12345678")
  const base = `http://localhost:${env.ports[1]}`

  // ── Project detail ────────────────────────────────────────────────────
  await page.goto(`${base}/projects/${seeded.id}`)
  const title = page.getByTestId("project-workspace.title")
  await expect(title).toBeVisible(SEE)
  await expect(page.getByTestId("project-list-view.task-title").first()).toBeVisible(SEE)
  await shot(page, "project-phone")
  expect(overlaps(await box(title), await box(page.getByTestId("project-view-list")))).toBe(false)
  expect(overlaps(await box(title), await box(page.getByTestId("project-view-kanban")))).toBe(false)
  const taskTitle = page.getByTestId("project-list-view.task-title").first()
  // "Rap…" was ~30px wide. The row must give the title most of its width.
  expect((await box(taskTitle)).width).toBeGreaterThan(150)
  await expectNoHorizontalClipping(page)

  // ── Calendar ──────────────────────────────────────────────────────────
  await page.goto(`${base}/calendar`)
  const calTitle = page.getByTestId("calendar-title")
  await expect(calTitle).toBeVisible(SEE)
  await shot(page, "calendar-phone")
  const truncated = await calTitle.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
  expect(truncated).toBe(false)
  await expectNoHorizontalClipping(page)

  // ── Knowledge home ────────────────────────────────────────────────────
  await page.goto(`${base}/knowledge`)
  const kTitle = page.getByTestId("knowledge-title")
  const cta = page.getByTestId("knowledge-home-create-from-cta")
  await expect(cta).toBeVisible(SEE)
  await shot(page, "knowledge-phone")
  expect(overlaps(await box(kTitle), await box(cta))).toBe(false)
  // One line of text: the label did not fold (the button's own height is the
  // 44px touch target, so count the text's line boxes instead).
  const textLines = await cta.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size
  })
  expect(textLines).toBe(1)
  await expectNoHorizontalClipping(page)
})
