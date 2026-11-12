// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B-NEW-2 — post-back failure arm: parent gone (410) leaves the finding `failed`,
// never a false `handled` (§7 / §9 post-back arms / §4.6 status enum).
//
// Forces the social platform mock to return 410 for the `/comments` POST, then
// drives the gated reply_to_finding → park → approve → re-enter. The re-entry's
// `classifyHttp` maps 410 → `gone` → terminal `failed`. Catches a regression
// where a post-back error is swallowed and the finding wrongly flips to handled.
//
// MUST use 410 (or 404), NOT 429: 404/410 → `gone` → `failed`; 429 →
// `rate_limited` → `triaged` (transient) — a different arm.
import { decideApproval, waitForApproval } from "../helpers/approvals"
import { expect, test } from "./helpers/social-fixtures"
import {
  getApprovalResult,
  getFinding,
  getSocialRequests,
  graphCommentPosts,
  installSocialApp,
  parkedForApproval,
  resetSocialMock,
  seedFinding,
  setSocialMockMode,
  socialTool,
} from "./helpers/social-harness"

test.describe("Social Ground Control post-back failure", () => {
  test("parent gone 410 leaves finding failed not handled", async ({ env, world, qa }) => {
    const token = qa.admin.token
    const s = env.serverUrl
    const orgId = world.org.id

    await resetSocialMock(s, token)
    await installSocialApp({ serverUrl: s, token, orgId })

    const finding = await seedFinding({
      serverUrl: s,
      token,
      orgId,
      platform: "facebook",
      relation: "comment_on_our_content",
      contentText: "Comment on a post that gets deleted before we reply.",
      authorHandle: "@ghost",
      status: "new",
    })

    // Force the post-back to 410 (parent gone — terminal).
    await setSocialMockMode(s, token, 410)

    // Drive the gated reply → park for approval.
    const reply = await socialTool({
      serverUrl: s,
      token,
      asAgent: true,
      tool: "reply_to_finding",
      params: { finding_id: finding.findingId, reply_text: "Thanks for the comment!" },
    })
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    expect(parkedForApproval(reply.body), JSON.stringify(reply.body)).toBe(true)
    expect(graphCommentPosts(await getSocialRequests(s, token)).length).toBe(0)

    // Approve → kernel re-enters → the /comments POST gets a 410.
    const pending = await waitForApproval({ serverUrl: s, token, toolPrefix: "social:" })
    const decided = await decideApproval({
      serverUrl: s,
      token,
      requestId: pending.id,
      decision: "approve",
    })
    // The platform refused the reply: the decision says so (nothing was posted), and as a
    // gone parent refuses the same reply again, the request closes instead of re-pending.
    expect(decided.status, JSON.stringify(decided.body)).toBe(422)
    expect(decided.body).toMatchObject({
      error: { code: "handler_failed", details: { details: { code: "reply_gone", final: true } } },
    })

    // Exactly one Graph POST attempt was made (the failed re-entry).
    let posts = graphCommentPosts(await getSocialRequests(s, token))
    const deadline = Date.now() + 10_000
    while (posts.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      posts = graphCommentPosts(await getSocialRequests(s, token))
    }
    if (posts.length !== 1) {
      // What the approved run did instead, so a failure here names it.
      const result = await getApprovalResult({ serverUrl: s, token, requestId: pending.id })
      const reqs = await getSocialRequests(s, token)
      throw new Error(
        `expected exactly one Graph comment POST (the failed re-entry), got ${posts.length}; ` +
          `handler result ${JSON.stringify(result)}; mock saw ${JSON.stringify(reqs.map((r) => `${r.method} ${r.url}`))}`,
      )
    }

    // The finding is now `failed` (the flat §4.6 enum), NOT `handled`.
    // Poll briefly — the status write happens during the async re-entry.
    let status: string | undefined
    const statusDeadline = Date.now() + 8_000
    while (Date.now() < statusDeadline) {
      const after = await getFinding({ serverUrl: s, token, findingId: finding.findingId })
      status = (after.finding as { status?: string } | undefined)?.status
      if (status === "failed") break
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(status, "finding must be 'failed', never falsely 'handled'").toBe("failed")
    expect(status).not.toBe("handled")

    // The re-entry handler result reports the gone reason — a "wrong failure
    // reason" regression must fail here too.
    const res = await getApprovalResult({ serverUrl: s, token, requestId: pending.id })
    const handlerResult = res.result as { status?: string; reason?: string } | null
    if (handlerResult) {
      expect(handlerResult.status).toBe("failed")
      expect(handlerResult.reason).toBe("gone")
    }

    // Reset mock to 200 for any subsequent test on this shared worker.
    await setSocialMockMode(s, token, 200)
  })
})
