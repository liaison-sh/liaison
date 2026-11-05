// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B-NEW-3 — like_item unsupported-relation arm (§4.5 support matrix / §7 / §12).
//
// YouTube has no like-as-channel API, so a like on a YT finding returns
// `unsupported` with ZERO external calls. The UI greys the [Like] action for the
// YT finding and enables it for a supported FB `comment_on_our_content` finding.
// Both directions are asserted (anti-rubber-stamp): YT disabled AND FB enabled.
import { loginAs } from "../fixtures/test"
import { expect, test } from "./helpers/social-fixtures"
import {
  getSocialRequests,
  graphLikePosts,
  installSocialApp,
  resetSocialMock,
  seedFinding,
  socialTool,
} from "./helpers/social-harness"

test.describe("Social Ground Control like support", () => {
  test("youtube like unsupported zero calls UI greys action", async ({ page, env, world, qa }) => {
    const token = qa.admin.token
    const s = env.serverUrl
    const orgId = world.org.id

    await resetSocialMock(s, token)
    await installSocialApp({ serverUrl: s, token, orgId })

    // A YouTube comment-on-our-content (unsupported like) and a Facebook one (supported).
    const yt = await seedFinding({
      serverUrl: s,
      token,
      orgId,
      platform: "youtube",
      relation: "comment_on_our_content",
      contentText: "Great video — wish I could like-as-channel here.",
      authorHandle: "@yt_fan",
      status: "new",
    })
    const fb = await seedFinding({
      serverUrl: s,
      token,
      orgId,
      platform: "facebook",
      relation: "comment_on_our_content",
      contentText: "This post is excellent.",
      authorHandle: "@fb_fan",
      status: "new",
    })

    // ── Server: like the YT finding → `unsupported`, NO external call, NO approval.
    const likeYt = await socialTool({
      serverUrl: s,
      token,
      tool: "like_item",
      params: { finding_id: yt.findingId },
    })
    // like_item's stage-time preflight refuses an unlikeable target up front
    // with a typed error (422 like_unsupported_for_target), before any staging
    // or external call; it used to surface as a 500.
    expect(likeYt.status, JSON.stringify(likeYt.body)).toBe(422)
    expect(JSON.stringify(likeYt.body)).toContain("Liking is not supported for this youtube item")
    // Zero Graph /likes POSTs recorded — the unsupported arm short-circuits the fetch.
    expect(graphLikePosts(await getSocialRequests(s, token)).length).toBe(0)

    // ── UI: the detail-pane Like button is disabled for YT, enabled for FB. ────
    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/social/findings`)
    await page.waitForLoadState("networkidle")
    await expect(page.locator('[data-testid="social-findings-list"]')).toBeVisible({
      timeout: 15_000,
    })

    // Select the YT finding → Like disabled.
    await page.locator(`[data-testid="social-finding-row-${yt.findingId}"]`).click()
    await expect(page.locator('[data-testid="social-finding-detail"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="social-like"]'),
      "YT comment-on-our-content like must be disabled (no YT like-as-channel API)",
    ).toBeDisabled()

    // Select the FB finding → Like enabled.
    await page.locator(`[data-testid="social-finding-row-${fb.findingId}"]`).click()
    await expect(page.locator('[data-testid="social-finding-detail"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="social-like"]'),
      "FB comment-on-our-content like must be enabled (supported)",
    ).toBeEnabled()
  })
})
