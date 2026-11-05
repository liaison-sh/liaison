// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B-NEW-1 — DM window-tag boundary trilogy at SEND TIME (§4.3 / §9 #2 / §4.6).
//
// The correctness-critical send path: the gated `send_dm` recomputes the reply
// window when the human approves, and tags the outbound `dm_message` row. B0
// covers the UI pills; this asserts the SEND SEMANTICS through the gated tool +
// the recorded Graph `/me/messages` POST + the persisted outbound row.
//
//   Δ ≤ 24h           → tag "none",        1 POST, 1 outbound row
//   24h < Δ ≤ 7d      → tag "human_agent", 1 POST, 1 outbound row
//   Δ > 7d            → window closed,     0 POSTs, 0 outbound rows (native fallback)
//
// Mutation-testing depth: assert the recorded mock request AND the DB row (via
// dm_get), not just the tool return — a broken window calc that still returns
// "ok" must fail here.
import { decideApproval, waitForApproval } from "../helpers/approvals"
import { expect, test } from "./helpers/social-fixtures"
import {
  type DmMessageRow,
  dmGet,
  getSocialRequests,
  graphMessagePosts,
  installSocialApp,
  parkedForApproval,
  resetSocialMock,
  seedConversation,
  socialTool,
} from "./helpers/social-harness"

const DAY_MS = 24 * 60 * 60 * 1000

/** Approve the parked send and wait for the async re-entry POST (or confirm none). */
async function approveAndSettle(s: string, token: string, expectPost: boolean): Promise<void> {
  const pending = await waitForApproval({ serverUrl: s, token, toolPrefix: "social:" })
  const decided = await decideApproval({
    serverUrl: s,
    token,
    requestId: pending.id,
    decision: "approve",
  })
  expect(decided.status, JSON.stringify(decided.body)).toBe(200)
  // Re-entry is async; poll the recorder. For the closed case (no POST), give the
  // re-entry a bounded window to NOT produce a post, then assert zero below.
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const posts = graphMessagePosts(await getSocialRequests(s, token))
    if (expectPost && posts.length >= 1) return
    await new Promise((r) => setTimeout(r, 300))
  }
}

function outboundRows(messages: DmMessageRow[]): DmMessageRow[] {
  return messages.filter((m) => m.direction === "outbound")
}

test.describe("Social Ground Control DM window tag", () => {
  test("send-time window trilogy none human_agent blocked", async ({ env, world, qa }) => {
    const token = qa.admin.token
    const s = env.serverUrl
    const orgId = world.org.id

    await resetSocialMock(s, token)
    await installSocialApp({ serverUrl: s, token, orgId })

    // ── Case 1: Δ ≈ 0 (within 24h) → tag "none" ───────────────────────────────
    {
      const convo = await seedConversation({
        serverUrl: s,
        token,
        orgId,
        platform: "instagram",
        participantHandle: "@open_now",
        lastInboundAt: new Date().toISOString(),
      })
      const first = await socialTool({
        serverUrl: s,
        token,
        asAgent: true,
        tool: "send_dm",
        params: { conversation_id: convo.conversationId, body: "Thanks for reaching out!" },
      })
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect(parkedForApproval(first.body), JSON.stringify(first.body)).toBe(true)
      // Zero DM POSTs before approval (the gate proof).
      expect(graphMessagePosts(await getSocialRequests(s, token)).length).toBe(0)

      await approveAndSettle(s, token, true)

      const posts = graphMessagePosts(await getSocialRequests(s, token))
      expect(posts.length, "exactly one /me/messages POST after approve (none case)").toBe(1)
      // The body carries the reply text (injection-safe — body, not URL).
      const body = JSON.parse(posts[0].body ?? "{}") as {
        message?: { text?: string }
        text?: string
      }
      const sentText = body.message?.text ?? body.text ?? JSON.stringify(body)
      expect(sentText).toContain("Thanks for reaching out")

      const { messages } = await dmGet({
        serverUrl: s,
        token,
        conversationId: convo.conversationId,
      })
      const out = outboundRows(messages)
      expect(out.length, "exactly one outbound dm_message row (none case)").toBe(1)
      expect(out[0].sent_via_tag, "sent_via_tag must be 'none' (NOT 'standard' — C4)").toBe("none")
    }

    // Reset the recorder between cases so the per-case POST counts are isolated.
    await resetSocialMock(s, token)

    // ── Case 2: 24h < Δ ≤ 7d → tag "human_agent" ──────────────────────────────
    {
      const convo = await seedConversation({
        serverUrl: s,
        token,
        orgId,
        platform: "instagram",
        participantHandle: "@open_3d",
        lastInboundAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
      })
      const first = await socialTool({
        serverUrl: s,
        token,
        asAgent: true,
        tool: "send_dm",
        params: { conversation_id: convo.conversationId, body: "Following up on your message." },
      })
      expect(parkedForApproval(first.body), JSON.stringify(first.body)).toBe(true)
      expect(graphMessagePosts(await getSocialRequests(s, token)).length).toBe(0)

      await approveAndSettle(s, token, true)

      const posts = graphMessagePosts(await getSocialRequests(s, token))
      expect(posts.length, "exactly one /me/messages POST after approve (human_agent case)").toBe(1)
      // The POST body carries the HUMAN_AGENT messaging tag.
      const raw = posts[0].body ?? "{}"
      expect(raw, "POST body must carry the HUMAN_AGENT messaging tag").toMatch(/HUMAN_AGENT/)

      const { messages } = await dmGet({
        serverUrl: s,
        token,
        conversationId: convo.conversationId,
      })
      const out = outboundRows(messages)
      expect(out.length, "exactly one outbound dm_message row (human_agent case)").toBe(1)
      expect(out[0].sent_via_tag, "sent_via_tag must be 'human_agent'").toBe("human_agent")
    }

    await resetSocialMock(s, token)

    // ── Case 3: Δ > 7d → window closed → zero POSTs, zero outbound rows ────────
    {
      const convo = await seedConversation({
        serverUrl: s,
        token,
        orgId,
        platform: "instagram",
        participantHandle: "@closed_8d",
        lastInboundAt: new Date(Date.now() - 7 * DAY_MS - 60_000).toISOString(),
      })
      const first = await socialTool({
        serverUrl: s,
        token,
        asAgent: true,
        tool: "send_dm",
        params: { conversation_id: convo.conversationId, body: "Late reply that must not send." },
      })
      // send_dm's stage-time preflight refuses a closed window up front: no
      // approval is parked for a send that can never deliver.
      expect(parkedForApproval(first.body), JSON.stringify(first.body)).toBe(false)
      expect(JSON.stringify(first.body)).toContain("reply window")

      // §4.6: a closed window makes NO send and NO sentinel-tag outbound row.
      const posts = graphMessagePosts(await getSocialRequests(s, token))
      expect(posts.length, "zero /me/messages POSTs for a closed window").toBe(0)

      const { messages } = await dmGet({
        serverUrl: s,
        token,
        conversationId: convo.conversationId,
      })
      expect(outboundRows(messages).length, "no outbound dm_message row on >7d").toBe(0)
    }
  })
})
