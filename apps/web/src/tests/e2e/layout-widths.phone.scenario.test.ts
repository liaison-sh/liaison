// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone shell at EVERY iPhone width, not only the 390px the other phone
// scenarios pin: 320 (SE 1st gen, and any iPhone with Display Zoom on) through
// 440 (Pro Max), with LONG real-world content (a long workspace name, a long
// user name, approval rows with long titles), since the simulator's short demo
// strings are exactly what hid a wide line before.
//
// For each width, light and dark, every main screen is measured against the
// DEVICE width: the document's scroll width, the layout viewport itself (a
// mobile engine widens it to fit overflowing content, which on the phone
// reads as a page cut on the right and, scaled with it, at the tab bar), every
// visible element's right edge, and the tab bar wholly on screen with its five
// labels.
//
// The Login test guards the iOS focus zoom: WebKit enlarges the page when a
// field under 16px takes focus, and inside the Capacitor app that zoom is
// permanent (the web view's pinch is disabled as soon as a zoom begins).
// Chromium does not emulate the zoom, so the trigger, the field's computed
// size, is what is measured.
//
// Runs in the `iphone` project, and in WebKit with PLAYWRIGHT_PROJECT=iphone-webkit.
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval } from "./helpers/approvals-seed"
import { ks } from "./helpers/db-reads"

const SIZES = [
  { width: 320, height: 568 }, // SE 1st gen
  { width: 320, height: 693 }, // iPhone 15 with Display Zoom
  { width: 375, height: 667 }, // SE 2nd/3rd
  { width: 375, height: 812 }, // 12/13 mini
  { width: 390, height: 844 }, // 12/13/14
  { width: 393, height: 852 }, // 15/16
  { width: 402, height: 874 }, // 16 Pro/17 Pro
  { width: 414, height: 896 }, // 11/XR
  { width: 428, height: 926 }, // 14 Plus
  { width: 430, height: 932 }, // 15/16 Plus, 15 Pro Max
  { width: 440, height: 956 }, // 16/17 Pro Max
] as const

const SCHEMES = ["light", "dark"] as const
const SEE = { timeout: 20_000 } as const
const SHOT_DIR = process.env.LAYOUT_SHOT_DIR
const SHOT_PREFIX = process.env.LAYOUT_SHOT_PREFIX ?? "shot"

async function shot(page: Page, size: { width: number; height: number }, name: string) {
  if (!SHOT_DIR) return
  if (size.width !== 320 || size.height !== 693) return
  await page.screenshot({ path: `${SHOT_DIR}/${SHOT_PREFIX}-${name}.png` })
}

/** Every layout defect on the current screen, as readable strings. */
async function measure(page: Page, withTabBar: boolean): Promise<string[]> {
  const problems: string[] = []
  // THE DEVICE width, never `innerWidth`: a mobile browser WIDENS its layout
  // viewport to fit content wider than `width=device-width`, and every
  // in-page width then grows with the overflow it should be exposing. That is
  // the on-device defect itself: 393pt of screen showing a ~430px layout,
  // cut on the right, and its height scaled up with it, cut at the bottom.
  const device = page.viewportSize()!
  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }))
  if (doc.scrollWidth > device.width || doc.scrollWidth > doc.clientWidth) {
    problems.push(`document ${doc.scrollWidth}px wide on a ${device.width}px screen`)
  }
  if (doc.innerWidth !== device.width || doc.innerHeight !== device.height) {
    problems.push(`layout viewport ${doc.innerWidth}x${doc.innerHeight}`)
  }
  const offenders = await page.evaluate((limit) => {
    const found: string[] = []
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || r.right <= limit + 1) continue
      if (r.bottom < 0 || r.top > window.innerHeight) continue
      if (el.closest('[aria-hidden="true"]')) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === "hidden") continue
      // Content inside a DECLARED horizontal rail that itself fits is meant
      // to scroll sideways (the chip rails). A vertical list's `overflow-y-auto`
      // computes overflow-x to auto as well, so the computed style cannot tell
      // the two apart: only an element that asks for horizontal scrolling by
      // name counts as a rail. Anything else wider than the phone is a defect,
      // clipped or scrollable.
      let node = el.parentElement
      let inRail = false
      while (node && node !== document.body) {
        const cl = node.classList
        const declared =
          cl.contains("overflow-x-auto") ||
          cl.contains("overflow-x-scroll") ||
          node.style.overflowX === "auto" ||
          node.style.overflowX === "scroll"
        if (declared) {
          inRail = node.getBoundingClientRect().right <= limit + 1
          break
        }
        node = node.parentElement
      }
      if (inRail) continue
      const testid = el.getAttribute("data-testid")
      const cls =
        typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 4).join(".") : ""
      found.push(
        `${el.tagName.toLowerCase()}${testid ? `[${testid}]` : ""}.${cls} right=${Math.round(r.right)}`,
      )
    }
    return found
  }, device.width)
  for (const o of offenders.slice(0, 4)) problems.push(`past the edge: ${o}`)
  if (withTabBar) {
    const bar = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="phone-tab-bar"]')
      if (!nav) return null
      const probe = document.createElement("div")
      probe.style.cssText = "position:fixed;padding-bottom:env(safe-area-inset-bottom,0px)"
      document.body.appendChild(probe)
      const safeBottom = Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0
      probe.remove()
      const r = nav.getBoundingClientRect()
      const labels = [...nav.querySelectorAll("button > span:not([role='status'])")].map((s) => {
        const b = s.getBoundingClientRect()
        return {
          text: s.textContent ?? "",
          inside: b.left >= r.left - 1 && b.right <= r.right + 1 && b.bottom <= r.bottom + 1,
          cut: (s as HTMLElement).scrollWidth > (s as HTMLElement).clientWidth + 1,
          bottom: b.bottom,
        }
      })
      return {
        bottom: r.bottom,
        right: r.right,
        limit: (window.visualViewport?.height ?? window.innerHeight) - safeBottom,
        innerWidth: window.visualViewport?.width ?? window.innerWidth,
        labels,
      }
    })
    if (!bar) problems.push("no tab bar")
    else {
      if (bar.bottom > Math.min(bar.limit, device.height) + 1)
        problems.push(`tab bar bottom ${Math.round(bar.bottom)} > ${bar.limit}`)
      if (bar.right > Math.min(bar.innerWidth, device.width) + 1)
        problems.push(`tab bar right ${Math.round(bar.right)}`)
      if (bar.labels.length !== 5) problems.push(`tab bar has ${bar.labels.length} labels`)
      for (const l of bar.labels) {
        if (!l.inside || l.cut || l.bottom > Math.min(bar.limit, device.height) + 1)
          problems.push(`tab label cut: ${l.text}`)
      }
    }
  }
  return problems
}

async function check(
  page: Page,
  size: { width: number; height: number },
  screen: string,
  failures: string[],
  withTabBar = true,
) {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const p of await measure(page, withTabBar)) {
      failures.push(`${size.width}x${size.height} ${scheme} ${screen}: ${p}`)
    }
  }
  await shot(page, size, screen)
}

async function runWidths(page: Page) {
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")
  const failures: string[] = []

  for (const size of SIZES) {
    await page.setViewportSize(size)

    await page.getByTestId("phone-tab-home").click()
    await expect(page.getByTestId("home-phone")).toBeVisible(SEE)
    await expect(page.getByTestId("home-greeting")).toBeVisible(SEE)
    await check(page, size, "home", failures)

    await page.getByTestId("phone-tab-chats").click()
    await expect(page.getByTestId("chats-screen")).toBeVisible(SEE)
    await expect(page.getByTestId("chats-personal-agent-row")).toBeVisible(SEE)
    await check(page, size, "chats", failures)

    await page.getByTestId("chats-personal-agent-row").click()
    await expect(page.getByTestId("phone-thread-header")).toBeVisible(SEE)
    await expect(page.getByTestId("compose-editor")).toBeVisible(SEE)
    await check(page, size, "thread", failures)

    await page.getByTestId("phone-tab-work").click()
    await expect(page.getByTestId("work-screen")).toBeVisible(SEE)
    await check(page, size, "work", failures)

    await page.getByTestId("phone-tab-search").click()
    await expect(page.getByTestId("search-tab")).toBeVisible(SEE)
    await check(page, size, "search", failures)

    await page.getByTestId("phone-tab-you").click()
    await expect(page.getByTestId("you-screen")).toBeVisible(SEE)
    await expect(page.getByTestId("you-row-you-notifications")).toBeVisible(SEE)
    await check(page, size, "you", failures)

    await page.getByTestId("you-row-you-notifications").click()
    await expect(page.getByTestId("notification-settings")).toBeVisible(SEE)
    await expect(page.getByTestId("notification-settings-loading")).toHaveCount(0, SEE)
    await check(page, size, "notifications", failures)
    // Back to You, so the next width's You seat lands on You, not on the
    // section the settings tab was left on.
    await page.getByTestId("settings-phone-back").click()
    await expect(page.getByTestId("you-screen")).toBeVisible(SEE)
  }

  expect(failures, `${failures.length} layout defects:\n${failures.join("\n")}`).toEqual([])
}

test.describe("the phone shell at every iPhone width", () => {
  test("Home, Chats, a thread, Work, Search, You and Notifications fit 320 to 440", async ({
    authenticatedPage: page,
    env,
    world,
  }) => {
    test.setTimeout(420_000)
    // LONG real-world content: the simulator's demo strings were short enough
    // to fit, a real workspace's were not.
    const orgs = `${ks(env)}.organizations`
    const users = `${ks(env)}.users`
    const [before] = (await env.db.sql.unsafe(`SELECT name FROM ${orgs} WHERE id = $1`, [
      world.org.id,
    ])) as Array<{ name: string }>
    const [me] = (await env.db.sql.unsafe(`SELECT name FROM ${users} WHERE id = $1`, [
      world.admin.id,
    ])) as Array<{ name: string }>
    await env.db.sql.unsafe(`UPDATE ${orgs} SET name = $2 WHERE id = $1`, [
      world.org.id,
      "Acme Retail Operations International",
    ])
    await env.db.sql.unsafe(`UPDATE ${users} SET name = $2 WHERE id = $1`, [
      world.admin.id,
      "Avery-Dominic Whitfield-Larsen",
    ])
    const requester = await createApprovalActor(world, {
      name: "Stephanie Requester With A Very Long Display Name",
      scopes: ["test:gated:write"],
    })
    for (const n of [1, 2, 3]) {
      await seedGatedApproval(env, world.org.id, {
        requesterUserId: requester.id,
        participantUserIds: [world.admin.id],
        approverUserIds: [world.admin.id],
        title: `Remboursement exceptionnel du client Supercalifragilisticexpialidocious-${n} pour le hub de Varsovie`,
        params: {
          message: `Remboursement exceptionnel du client Supercalifragilisticexpialidocious-${n} pour le hub de Varsovie`,
        },
      })
    }
    // Home's first feed fetch predates the seed above.
    await page.reload()
    try {
      await runWidths(page)
    } finally {
      await env.db.sql.unsafe(`UPDATE ${orgs} SET name = $2 WHERE id = $1`, [
        world.org.id,
        before.name,
      ])
      await env.db.sql.unsafe(`UPDATE ${users} SET name = $2 WHERE id = $1`, [
        world.admin.id,
        me.name,
      ])
    }
  })

  test("Login fits 320 to 440, and focusing its fields never zooms the page", async ({
    page,
    env,
  }) => {
    test.setTimeout(180_000)
    const failures: string[] = []
    await page.goto(`http://localhost:${env.ports[1]}/login`)
    const toggle = page.getByRole("button", { name: /sign in with a password/i })
    await toggle.waitFor({ state: "visible", timeout: 30_000 })
    await toggle.click()
    await expect(page.getByLabel("Password")).toBeVisible(SEE)

    for (const size of SIZES) {
      await page.setViewportSize(size)
      await expect(page.getByTestId("auth-card")).toBeVisible(SEE)
      await check(page, size, "login", failures, false)

      // What WebKit zooms on is a focused field under 16px. Chromium does not
      // emulate the zoom itself, so the trigger is measured on every field,
      // and the visual viewport's scale is read after focus as well.
      for (const label of ["Email", "Password"]) {
        const field = page.getByLabel(label)
        await field.tap()
        const probe = await field.evaluate((el) => ({
          fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
          scale: window.visualViewport?.scale ?? 1,
        }))
        if (probe.fontSize < 16)
          failures.push(`${size.width}x${size.height} login ${label}: font ${probe.fontSize}px`)
        if (probe.scale !== 1)
          failures.push(`${size.width}x${size.height} login ${label}: zoom ${probe.scale}`)
      }
      await page.getByLabel("Email").blur()
      for (const p of await measure(page, false)) {
        failures.push(`${size.width}x${size.height} login after focus: ${p}`)
      }
    }

    expect(failures, `${failures.length} layout defects:\n${failures.join("\n")}`).toEqual([])
  })
})
