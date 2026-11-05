// SPDX-License-Identifier: FSL-1.1-ALv2
// boot.lazy-mount-and-home-populate — login renders the shell + Home populates
// in a single auth roundtrip (B1), and with 3 persisted background tabs only
// the active tab's component subtree mounts at boot; a background tab mounts
// its component only on first click (B2 hasBeenActive latch in MainPanel).
//
// Visual baseline (Home populated) generated via:
//   `bunx --bun playwright test --update-snapshots=all --grep "boot.lazy-mount"`
import { expect, loginAs, test } from "./fixtures/test"

test("boot.lazy-mount-and-home-populate", async ({ page, env, qa, world }) => {
  // Seed a small amount of attention data so Home populates with something
  // besides the empty state (also proves the render-early boot still reaches
  // a working attention fetch, not just a blank shell).
  await world.threads.sendMessage(
    qa.threads.q2Marketing,
    qa.amina,
    `boot-journey message ${Date.now()}`,
  )

  // Persist 3 background thread tabs + Home as active BEFORE the app ever
  // loads, mirroring a real rehydrated session (localStorage survives reload).
  // Home stays active so its content-area is the one exercised for populate;
  // the other three tabs are rehydrated but never activated in this browser
  // context, which is exactly the B2 lazy-mount contract under test.
  await page.goto(`http://localhost:${env.ports[1]}/login`)
  // Threads THIS viewer is in: a rehydrated tab for a thread the booting user
  // is not a participant of is refused by the API (403 on read, 404 on the
  // thread), and the shell says so with an error toast, which is right but is
  // not what this journey is about.
  const bgThreads = [
    qa.threads.q2Marketing,
    qa.threads.sprintRetro,
    qa.threads.securityAudit,
  ] as const
  await page.evaluate(
    (threads) => {
      const tabs = [
        { type: "kernel:home", entityId: "home", label: "Home", isPreview: false, routePath: "/" },
        ...threads.map((t) => ({
          type: "thread",
          entityId: t.id,
          label: t.title ?? "Thread",
          isPreview: false,
          routePath: `/threads/${t.id}`,
        })),
      ]
      window.localStorage.setItem(
        "liaison:tabs",
        JSON.stringify({ tabs, activeTabId: "kernel:home:home" }),
      )
    },
    bgThreads.map((t) => ({ id: t.id, title: t.title })),
  )

  // Boot: log in (single auth roundtrip per B1's initializeAuth/completeRuntimeInit split).
  await loginAs(page, env, "admin@test.com", "12345678")

  // Shell renders: tab bar + activity bar + Home visible.
  await expect(page.getByTestId("activity-bar")).toBeVisible()
  await expect(page.getByTestId("tabstrip")).toBeVisible()
  await expect(page.getByTestId("home")).toBeVisible({ timeout: 15000 })

  // Home populates (attention feed reaches a real state, not stuck loading).
  await expect(page.getByTestId("home-status")).toBeVisible({ timeout: 15000 })
  await expect
    .poll(async () => (await page.getByTestId("home-status").textContent()) ?? "", {
      timeout: 15000,
    })
    .not.toBe("")

  // All 4 tabs rehydrated from localStorage.
  const tabButtons = page.getByTestId("tabstrip").locator("[data-tab-id]")
  await expect(tabButtons).toHaveCount(4, { timeout: 10000 })

  // Lazy first-mount (B2): the 3 background thread tabs are rehydrated but
  // never activated, so their reactive content subtree was never created —
  // MainPanel's `<Show when={hasTabBeenActive(tab.id)}>` wrapper renders
  // nothing underneath. Probe generically via the wrapper's own child count
  // (no tab-type-specific testid needed): an inactive, never-mounted tab's
  // `[data-tab-active="false"]` div has zero children. MainPanel doesn't tag
  // the wrapper with the tab id directly, but Home is the only ever-active
  // tab at this point, so every OTHER wrapper must currently be unmounted.
  const unmountedCounts = await page.evaluate(() => {
    const wrappers = Array.from(
      document.querySelectorAll('[data-testid="tab-content-area"] > [data-tab-active]'),
    )
    return wrappers.map((w) => ({
      active: w.getAttribute("data-tab-active"),
      childCount: w.childElementCount,
    }))
  })
  const activeWrappers = unmountedCounts.filter((w) => w.active === "true")
  const inactiveWrappers = unmountedCounts.filter((w) => w.active === "false")
  expect(activeWrappers.length).toBe(1)
  expect(activeWrappers[0]?.childCount).toBeGreaterThan(0)
  expect(inactiveWrappers.length).toBe(3)
  for (const w of inactiveWrappers) {
    expect(w.childCount).toBe(0)
  }

  // Click a background tab -> it mounts on first activation (real DOM outcome:
  // its wrapper goes from 0 children to >0, and the thread page's own content
  // becomes visible). Tab ids are QUALIFIED by the registry
  // (normalizeTabType("thread") -> "kernel:thread"), matching the same
  // qualified-id convention documented for HOME_TAB_TYPE in tab-store.ts.
  const target = bgThreads[0]!
  await page.locator(`[data-tab-id="kernel:thread:${target.id}"]`).click()
  await expect
    .poll(
      async () => {
        return await page.evaluate(() => {
          const w = document.querySelector(
            `[data-testid="tab-content-area"] > [data-tab-active="true"]`,
          )
          return w ? w.childElementCount : -1
        })
      },
      { timeout: 10000 },
    )
    .toBeGreaterThan(0)

  // Visual baseline: Home populated (navigate back).
  await page.getByTestId("activity-home").click()
  await expect(page.getByTestId("home")).toBeVisible()
  await expect(
    page.getByTestId("home-feed").or(page.getByTestId("home-feed-groups")).first(),
  ).toBeVisible({ timeout: 10000 })
  // Nothing on this journey is refused, so a cold boot leaves no error toast
  // behind; asserting it keeps one out of the baseline below.
  await expect(page.getByTestId("toast-error")).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await expect(page.getByTestId("home")).toHaveScreenshot("boot-home-populated.png", {
    maxDiffPixelRatio: 0.05,
    mask: [page.getByTestId("home-status")],
  })
})
