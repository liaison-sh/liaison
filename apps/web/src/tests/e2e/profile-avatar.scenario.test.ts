// SPDX-License-Identifier: FSL-1.1-ALv2
// Profile picture: a user uploads an avatar in Settings -> Profile, it replaces
// the initials, actually renders (the public capability URL loads real bytes),
// and Remove returns to the initials fallback.
import { expect, loginAs, test } from "./fixtures/test"

// A real 1x1 PNG (valid magic bytes + IHDR/IDAT/IEND) — the backend re-encodes
// it to webp, so the served image is a genuine decodable image regardless.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOwaTrxHwAFCgKGVPWdlAAAAABJRU5ErkJggg==",
  "base64",
)

test("profile picture upload replaces initials and renders, then removes", async ({
  page,
  env,
}) => {
  await loginAs(page, env, "admin@test.com", "12345678")

  const vitePort = env.ports[1]
  await page.goto(`http://localhost:${vitePort}/settings`)

  const preview = page.getByTestId("profile-avatar-preview")
  await expect(preview).toBeVisible({ timeout: 15_000 })
  // Fresh account: initials fallback, no <img> yet.
  await expect(preview.locator("img")).toHaveCount(0)

  // Upload via the (hidden) file input — setInputFiles drives it directly.
  const uploadResponse = page.waitForResponse(
    (r) => r.url().includes("/api/users/me/avatar") && r.request().method() === "POST",
  )
  await page.getByTestId("profile-avatar-file-input").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  })
  const uploaded = await uploadResponse
  expect(uploaded.ok(), await uploaded.text()).toBe(true)

  // The preview now shows an <img> pointing at the public capability URL...
  const img = preview.locator("img")
  await expect(img).toBeVisible({ timeout: 10_000 })
  await expect(img).toHaveAttribute("src", /\/api\/avatars\/[A-Za-z0-9_-]+/)

  // ...and it ACTUALLY loads (real bytes served over the public route): a broken
  // image would report naturalWidth 0.
  await expect
    .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0)

  // Remove returns to the initials fallback.
  const removeResponse = page.waitForResponse(
    (r) => r.url().includes("/api/users/me/avatar") && r.request().method() === "DELETE",
  )
  await page.getByTestId("profile-avatar-remove").click()
  const removed = await removeResponse
  expect(removed.ok(), await removed.text()).toBe(true)

  await expect(preview.locator("img")).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId("profile-avatar-remove")).toHaveCount(0)
})
