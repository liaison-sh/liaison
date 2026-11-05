// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B6 — gated post-back. reply_to_finding / send_dm / like_item follow the
// invoicing re-entry pattern: first entry (no ctx.approval) files an approval and
// returns pending_approval; on re-entry the external post runs exactly once.
// Idempotency: an already-handled target makes zero external calls. send_dm
// recomputes the DM window AT SEND TIME. like_item honors the support matrix.

import { describe, expect, test } from "bun:test"
import type { SocialApproval, SocialToolCtx } from "./ctx"
import { likeItem, likeItemPreflight, replyToFinding, replyToFindingPreflight, sendDm, sendDmPreflight } from "./post-back"
import { createMockDb, type MockDb } from "./test-db"

interface FetchCall {
  url: string
  method: string
  body?: Record<string, unknown> | string
  headers?: Record<string, string>
}

interface ApprovalInput {
  tool_name: string
  summary: string
  summary_detail?: {
    subtitle?: string
    lines?: string[]
    links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
  }
  current_payload: unknown
  editable_fields?: string[]
}

interface TestCtx extends SocialToolCtx {
  fetch: SocialToolCtx["fetch"] & { calls: FetchCall[] }
  __approvalInputs: ApprovalInput[]
}

function makeCtx(opts: {
  approval?: SocialApproval
  db?: MockDb
  fetchStatus?: number
  /** Extra URL-path-substring → JSON body routes (e.g. `/me/accounts`), layered
   *  over the default `{ id: "posted-1" }` POST response. First match wins. */
  routes?: Record<string, unknown>
  /** OAuth token the `connections` accessor returns (facebook page-token tests
   *  need a live user token so `resolveAccessToken` succeeds). `null` throws
   *  (simulates no connected account). */
  connectionToken?: string | null
} = {}): TestCtx {
  const calls: FetchCall[] = []
  const approvalInputs: ApprovalInput[] = []
  const fetchImpl = (async (
    url: string,
    init?: { method?: string; body?: Record<string, unknown> | string; headers?: Record<string, string> },
  ) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body, headers: init?.headers })
    const status = opts.fetchStatus ?? 200
    const match = Object.entries(opts.routes ?? {}).find(([path]) => url.includes(path))
    const json = match ? match[1] : { id: "posted-1" }
    // Mirrors the real sandbox fetch contract: {status, headers, body-string}.
    return {
      status,
      headers: {},
      body: JSON.stringify(json),
    }
  }) as TestCtx["fetch"]
  fetchImpl.calls = calls
  return {
    orgId: "org-1",
    db: opts.db ?? createMockDb(),
    fetch: fetchImpl,
    connections: {
      getToken: async (_name: string, _identifier?: string) => {
        if (opts.connectionToken === null) throw new Error("No access token stored")
        return opts.connectionToken ?? "user-token"
      },
    },
    config: { get: async () => null },
    approval: opts.approval,
    async requestApproval(input: ApprovalInput) {
      approvalInputs.push(input)
      return { approval_id: "appr-1" }
    },
    async emit() {},
    __approvalInputs: approvalInputs,
  } as TestCtx
}

async function seedFinding(
  db: MockDb,
  over: Partial<{
    id: string
    platform: string
    relation: string
    external_id: string
    status: string
    author_handle: string
    content_text: string
  }> = {},
): Promise<string> {
  const r = await db.insert("finding", {
    id: over.id ?? "f1",
    platform: over.platform ?? "facebook",
    external_id: over.external_id ?? "FB_123",
    relation: over.relation ?? "comment_on_our_content",
    status: over.status ?? "triaged",
    author_handle: over.author_handle ?? null,
    content_text: over.content_text ?? null,
  })
  return r.id
}

describe("replyToFinding (B6 re-entry + idempotency)", () => {
  test("first entry returns pending_approval; re-entry posts exactly once", async () => {
    const db = createMockDb()
    await seedFinding(db)
    const first = await replyToFinding(makeCtx({ db }), { finding_id: "f1", reply_text: "thanks!" })
    expect(first).toMatchObject({ status: "pending_approval", approval_id: "appr-1" })

    const ctx2 = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const second = await replyToFinding(ctx2, { finding_id: "f1", reply_text: "thanks!" })
    expect(second).toMatchObject({ status: "completed" })
    expect(ctx2.fetch.calls.filter((c) => c.method === "POST").length).toBe(1)
    const f = (await db.findMany("finding", { where: { id: "f1" } }))[0] as { status: string }
    expect(f.status).toBe("handled")
  })

  test("files the approval with the host bridge shape: fully-qualified tool_name + summary + current_payload", async () => {
    // Regression guard for the gated re-entry contract — the host bridge reads
    // `input.tool_name.indexOf(...)`, so a `{ tool, params }` shape throws
    // "undefined is not an object" at the real boundary (caught by the B10 E2E).
    const db = createMockDb()
    await seedFinding(db)
    const ctx = makeCtx({ db })
    await replyToFinding(ctx, { finding_id: "f1", reply_text: "thanks!" })
    expect(ctx.__approvalInputs.length).toBe(1)
    const input = ctx.__approvalInputs[0]!
    expect(input.tool_name).toBe("social:reply_to_finding")
    expect(typeof input.summary).toBe("string")
    expect(input.summary.length).toBeGreaterThan(0)
    expect(input.current_payload).toMatchObject({ finding_id: "f1", reply_text: "thanks!" })
  })

  test("summary_detail carries platform, author, original content, and the VERBATIM reply text", async () => {
    const db = createMockDb()
    await seedFinding(db, {
      platform: "instagram",
      author_handle: "@jdoe",
      content_text: "This pedal is amazing!",
    })
    const ctx = makeCtx({ db })
    await replyToFinding(ctx, { finding_id: "f1", reply_text: "Thanks so much for the kind words!" })
    const input = ctx.__approvalInputs[0]!
    const detail = input.summary_detail!
    expect(detail.subtitle).toContain("instagram")
    expect(detail.lines).toContain("Platform: instagram")
    expect(detail.lines).toContain("Author: @jdoe")
    expect(detail.lines).toContain("Original: This pedal is amazing!")
    expect(detail.lines).toContain("Reply: Thanks so much for the kind words!")
  })

  test("approving an already-handled finding makes 0 external calls", async () => {
    const db = createMockDb()
    await seedFinding(db, { status: "handled" })
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: "x" })
    expect(res).toMatchObject({ status: "noop", reason: "already_handled" })
    expect(ctx.fetch.calls.length).toBe(0)
  })

  test("reply_text rides in the POST body, never path-interpolated (injection)", async () => {
    const db = createMockDb()
    await seedFinding(db, { platform: "facebook", relation: "comment_on_our_content", external_id: "FB_123" })
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const evil = "thanks!../../../delete?confirm=true&x=1"
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: evil })
    expect(res).toMatchObject({ status: "completed" })
    const call = ctx.fetch.calls.find((c) => c.method === "POST")!
    expect(call.url).toBe("https://graph.facebook.com/v26.0/FB_123/comments")
    expect(call.url).not.toContain("delete")
    expect(call.url).not.toContain("..")
    // The body is a serialized JSON string (the sandbox fetch bridge sends
    // init.body verbatim — an object would be coerced to "[object Object]").
    expect(typeof call.body).toBe("string")
    expect(JSON.parse(call.body as string)).toMatchObject({ message: evil })
  })

  test("a gone (404) re-entry returns a typed failed status, persists status=failed, no infinite retry", async () => {
    const db = createMockDb()
    await seedFinding(db)
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" }, fetchStatus: 404 })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: "x" })
    expect(res).toMatchObject({ status: "failed", reason: "gone" })
    // §4.3/§7: gone is a terminal, observable `failed` state (not a silent revert).
    const f = (await db.findMany("finding", { where: { id: "f1" } }))[0] as { status: string }
    expect(f.status).toBe("failed")
  })

  test("first entry writes nothing on the finding; the approval payload carries the draft and target", async () => {
    // Reads derive "awaiting approval" from the pending request (pending.ts), so a stored
    // awaiting_approval could only go stale once the request is denied or expires.
    const db = createMockDb()
    await seedFinding(db, { status: "triaged" })
    const ctx = makeCtx({ db })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: "drafted reply" })
    expect(res).toEqual({ status: "pending_approval", approval_id: "appr-1" })
    const f = (await db.findMany("finding", { where: { id: "f1" } }))[0] as {
      status: string
      suggested_reply?: string | null
      approval_request_id?: string | null
    }
    expect(f.status).toBe("triaged")
    expect(f.suggested_reply ?? null).toBeNull()
    expect(f.approval_request_id ?? null).toBeNull()
    expect(ctx.__approvalInputs[0]?.current_payload).toEqual({ finding_id: "f1", reply_text: "drafted reply" })
  })

  // C3: post-back dispatches on the finding's platform so each reply hits the
  // CORRECT API host — YouTube → googleapis.com, Facebook → graph.facebook.com,
  // Instagram → graph.instagram.com (Instagram Business Login). The pre-fix bug
  // hardcoded graph.facebook.com for all platforms.
  test.each([
    ["facebook", "graph.facebook.com", "/comments"],
    ["instagram", "graph.instagram.com", "/replies"],
    ["youtube", "www.googleapis.com", "/comments"],
  ])("reply on %s posts to the %s host", async (platform, host, edge) => {
    const db = createMockDb()
    await seedFinding(db, { platform, external_id: "X_123", relation: "comment_on_our_content" })
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: "hi" })
    expect(res).toMatchObject({ status: "completed" })
    const call = ctx.fetch.calls.find((c) => c.method === "POST")!
    expect(new URL(call.url).host).toBe(host)
    expect(call.url).toContain(edge)
    // The reply text never rides in the URL/path (injection-safe).
    expect(call.url).not.toContain("hi")
  })

  // A `keyword_match` finding is a VIDEO match — its external_id is a VIDEO id,
  // not a comment id. `replyRequest` (comments.insert with parentId) would
  // shape an invalid request; `replyToFinding` must dispatch to the adapter's
  // `topLevelCommentRequest` (commentThreads.insert) instead when the finding
  // is a keyword_match and the adapter supports it.
  test("a keyword_match (video) finding posts a TOP-LEVEL comment (commentThreads.insert), not a reply", async () => {
    const db = createMockDb()
    await seedFinding(db, { platform: "youtube", external_id: "vid-abc", relation: "keyword_match" })
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: "Nice video!" })
    expect(res).toMatchObject({ status: "completed" })
    const call = ctx.fetch.calls.find((c) => c.method === "POST")!
    expect(call.url).toBe("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet")
    const body = JSON.parse(call.body as string)
    expect(body).toMatchObject({
      snippet: { videoId: "vid-abc", topLevelComment: { snippet: { textOriginal: "Nice video!" } } },
    })
  })

  // The core bug: a Facebook Page POST authorized with the connected USER
  // token 400s. `replyToFinding` must resolve the owning Page's token via
  // `/me/accounts` and attach it as the POST's Authorization header.
  test("facebook reply resolves the owning PAGE token via /me/accounts, not the connected user token", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      id: "ss1",
      platform: "facebook",
      account_external_id: "user-1",
      source_type: "discovery",
      active: true,
    })
    await seedFinding(db, { platform: "facebook", external_id: "page-1_comment-9", relation: "comment_on_our_content" })
    const ctx = makeCtx({
      db,
      approval: { approvalRequestId: "appr-1" },
      connectionToken: "user-token",
      routes: { "/me/accounts": { data: [{ id: "page-1", access_token: "page-1-token" }] } },
    })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: "hi" })
    expect(res).toMatchObject({ status: "completed" })
    const accountsCall = ctx.fetch.calls.find((c) => c.url.includes("/me/accounts"))!
    expect(accountsCall.headers).toEqual({ Authorization: "Bearer user-token" })
    const postCall = ctx.fetch.calls.find((c) => c.method === "POST")!
    expect(postCall.url).toBe("https://graph.facebook.com/v26.0/page-1_comment-9/comments")
    expect(postCall.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer page-1-token" })
  })
})

describe("sendDm (B6 window recompute)", () => {
  async function seedConversation(db: MockDb, lastInboundAt: string | null): Promise<void> {
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "IG_PSID",
      last_inbound_at: lastInboundAt,
      status: "open",
    })
  }
  const now = Date.now()
  const twoHoursAgo = new Date(now - 2 * 3600_000).toISOString()
  const threeDaysAgo = new Date(now - 3 * 86400_000).toISOString()
  const eightDaysAgo = new Date(now - 8 * 86400_000).toISOString()

  // C4 / §9 #2: within 24h the recorded tag is "none" (NOT "standard").
  test("within 24h posts with NO tag and records sent_via_tag='none' + one outbound row", async () => {
    const db = createMockDb()
    await seedConversation(db, twoHoursAgo)
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const res = await sendDm(ctx, { conversation_id: "c1", body: "hi" })
    expect(res).toMatchObject({ status: "completed", sent_via_tag: "none" })
    const rows = (await db.findMany("dm_message", {
      where: { conversation_id: "c1", direction: "outbound" },
    })) as Array<{ sent_via_tag: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]!.sent_via_tag).toBe("none")
    // The send used a RESPONSE messaging_type (no HUMAN_AGENT tag).
    const call = ctx.fetch.calls.find((c) => c.method === "POST")!
    expect(JSON.parse(call.body as string)).toMatchObject({ messaging_type: "RESPONSE" })
  })

  test("beyond 7d: no API send, no outbound row, window_closed fallback", async () => {
    const db = createMockDb()
    await seedConversation(db, eightDaysAgo)
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const res = await sendDm(ctx, { conversation_id: "c1", body: "hi" })
    expect(res).toMatchObject({ status: "window_closed" })
    expect(ctx.fetch.calls.length).toBe(0)
    expect(await db.count("dm_message", { where: { conversation_id: "c1", direction: "outbound" } })).toBe(0)
  })

  test("within 7d posts with HUMAN_AGENT tag and records the outbound row", async () => {
    const db = createMockDb()
    await seedConversation(db, threeDaysAgo)
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const res = await sendDm(ctx, { conversation_id: "c1", body: "hi" })
    expect(res).toMatchObject({ status: "completed", sent_via_tag: "human_agent" })
    expect(await db.count("dm_message", { where: { conversation_id: "c1", direction: "outbound" } })).toBe(1)
  })

  test("first entry (no approval) returns pending_approval, no send", async () => {
    const db = createMockDb()
    await seedConversation(db, threeDaysAgo)
    const ctx = makeCtx({ db })
    const res = await sendDm(ctx, { conversation_id: "c1", body: "hi" })
    expect(res).toMatchObject({ status: "pending_approval" })
    expect(ctx.fetch.calls.length).toBe(0)
  })

  test("summary_detail carries platform, recipient, and the VERBATIM message body", async () => {
    const db = createMockDb()
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "IG_PSID",
      last_inbound_at: twoHoursAgo,
      status: "open",
      participant_handle: "@jdoe",
      participant_display_name: "Jane Doe",
    })
    const ctx = makeCtx({ db })
    await sendDm(ctx, { conversation_id: "c1", body: "Thanks for reaching out, here's the info!" })
    const input = ctx.__approvalInputs[0]!
    const detail = input.summary_detail!
    expect(detail.subtitle).toBe("Sends a direct message")
    expect(detail.lines).toContain("Platform: instagram")
    expect(detail.lines).toContain("Recipient: Jane Doe")
    expect(detail.lines).toContain("Message: Thanks for reaching out, here's the info!")
  })
})

describe("sendDm facebook page-token resolution (conversation metadata plumbing)", () => {
  const now = Date.now()
  const twoHoursAgo = new Date(now - 2 * 3600_000).toISOString()

  test("reads convo.metadata.pageId and sends with THAT page's token, not the user token", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      id: "ss1",
      platform: "facebook",
      account_external_id: "user-1",
      source_type: "dm",
      active: true,
    })
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "facebook",
      external_id: "cust-1",
      last_inbound_at: twoHoursAgo,
      status: "open",
      metadata: { pageId: "page-b" },
    })
    const ctx = makeCtx({
      db,
      approval: { approvalRequestId: "appr-1" },
      connectionToken: "user-token",
      routes: {
        "/me/accounts": {
          data: [
            { id: "page-a", access_token: "token-a" },
            { id: "page-b", access_token: "token-b" },
          ],
        },
      },
    })
    const res = await sendDm(ctx, { conversation_id: "c1", body: "hi" })
    expect(res).toMatchObject({ status: "completed" })
    const postCall = ctx.fetch.calls.find((c) => c.method === "POST")!
    expect(postCall.url).toBe("https://graph.facebook.com/v26.0/me/messages")
    expect(postCall.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer token-b" })
  })

  test("missing metadata.pageId falls back to the first managed page (never the user token)", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      id: "ss1",
      platform: "facebook",
      account_external_id: "user-1",
      source_type: "dm",
      active: true,
    })
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "facebook",
      external_id: "cust-1",
      last_inbound_at: twoHoursAgo,
      status: "open",
      // No metadata — conversation synced before this fix.
    })
    const ctx = makeCtx({
      db,
      approval: { approvalRequestId: "appr-1" },
      connectionToken: "user-token",
      routes: { "/me/accounts": { data: [{ id: "page-a", access_token: "token-a" }] } },
    })
    const res = await sendDm(ctx, { conversation_id: "c1", body: "hi" })
    expect(res).toMatchObject({ status: "completed" })
    const postCall = ctx.fetch.calls.find((c) => c.method === "POST")!
    expect(postCall.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer token-a" })
  })
})

// STAGE-TIME preflight (manifest `preflight: sendDmPreflightHandler`). send_dm is gated, so the kernel
// files a `pending_approval` BEFORE the handler runs — the handler's own send-time window recompute
// (which returns `window_closed`, no send) only fires post-approval, too late for the agent to know the
// window is shut. For a CLOSED window (>7d since last inbound, or no inbound) the agent would otherwise
// stage a send that can NEVER deliver (the aged-DM-window failure mode the rubric grades as a fabricated/
// silently-failed send). The preflight runs BEFORE the gate and surfaces a typed `dm_window_closed` error
// at the CALL SITE for a closed window, so the agent honestly declines the send and points to the native
// app. An OPEN window (standard ≤24h or human-agent ≤7d — incl. the scenario's ~5-day conversation)
// preflights `ok` and proceeds to the gate. FAILS-WITHOUT the preflight (a closed-window send is staged
// as a doomed approval); PASSES-WITH (closed errors at stage time; open proceeds).
describe("sendDm stage-time preflight (closed window surfaces BEFORE the gate)", () => {
  async function seedConversation(db: MockDb, lastInboundAt: string | null): Promise<void> {
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "IG_PSID",
      last_inbound_at: lastInboundAt,
      status: "open",
    })
  }
  const now = Date.now()
  const fiveDaysAgo = new Date(now - 5 * 86400_000).toISOString()
  const twoHoursAgo = new Date(now - 2 * 3600_000).toISOString()
  const eightDaysAgo = new Date(now - 8 * 86400_000).toISOString()

  test("closed window (>7d) → typed dm_window_closed error at stage time, no approval staged", async () => {
    const db = createMockDb()
    await seedConversation(db, eightDaysAgo)
    const ctx = makeCtx({ db })
    const res = await sendDmPreflight(ctx, { conversation_id: "c1" })
    expect(res).toEqual({
      error: {
        code: "dm_window_closed",
        message: expect.stringContaining("native app"),
      },
    })
    expect(ctx.fetch.calls.length).toBe(0)
    expect((ctx as TestCtx).__approvalInputs.length).toBe(0)
  })

  test("no inbound on record → closed → dm_window_closed at stage time", async () => {
    const db = createMockDb()
    await seedConversation(db, null)
    const res = await sendDmPreflight(makeCtx({ db }), { conversation_id: "c1" })
    expect(res).toMatchObject({ error: { code: "dm_window_closed" } })
  })

  test("human-agent window (~5d, the scenario case) → preflight ok (proceeds to the gate)", async () => {
    const db = createMockDb()
    await seedConversation(db, fiveDaysAgo)
    const res = await sendDmPreflight(makeCtx({ db }), { conversation_id: "c1" })
    expect(res).toEqual({ ok: true })
  })

  test("standard window (≤24h) → preflight ok (proceeds to the gate)", async () => {
    const db = createMockDb()
    await seedConversation(db, twoHoursAgo)
    const res = await sendDmPreflight(makeCtx({ db }), { conversation_id: "c1" })
    expect(res).toEqual({ ok: true })
  })

  test("missing conversation → typed not_found error (never a silent pass to the gate)", async () => {
    const res = await sendDmPreflight(makeCtx({ db: createMockDb() }), { conversation_id: "nope" })
    expect(res).toMatchObject({ error: { code: "not_found" } })
  })
})

describe("likeItem (B6 support matrix)", () => {
  test.each([
    ["FB own-page comment", { platform: "facebook", relation: "comment_on_our_content" }, "completed"],
    ["IG own-media comment", { platform: "instagram", relation: "comment_on_our_content" }, "completed"],
    ["IG third-party mention", { platform: "instagram", relation: "mention_in_post" }, "unsupported"],
    ["YouTube comment", { platform: "youtube", relation: "comment_on_our_content" }, "unsupported"],
  ])("like_item %s → %s", async (_label, target, expected) => {
    const db = createMockDb()
    await seedFinding(db, { platform: target.platform, relation: target.relation, external_id: "X_1" })
    const ctx = makeCtx({ db, approval: { approvalRequestId: "appr-1" } })
    const res = await likeItem(ctx, { finding_id: "f1" })
    expect(res.status).toBe(expected as typeof res.status)
    if (expected === "unsupported") expect(ctx.fetch.calls.length).toBe(0)
  })

  test("summary_detail carries platform, author, and the original content on first entry", async () => {
    const db = createMockDb()
    await seedFinding(db, {
      platform: "facebook",
      relation: "comment_on_our_content",
      author_handle: "@customer1",
      content_text: "Love this product!",
    })
    const ctx = makeCtx({ db })
    await likeItem(ctx, { finding_id: "f1" })
    const input = ctx.__approvalInputs[0]!
    const detail = input.summary_detail!
    expect(detail.subtitle).toContain("facebook")
    expect(detail.lines).toContain("Platform: facebook")
    expect(detail.lines).toContain("Author: @customer1")
    expect(detail.lines).toContain("Original: Love this product!")
  })
})

// STAGE-TIME preflight (manifest `preflight: likeItemPreflightHandler`). like_item is gated, so the
// kernel files a `pending_approval` BEFORE the handler runs — the handler's own support-matrix
// short-circuit (`unsupported`) only fires post-approval, too late for the agent to know YouTube likes
// are unsupported. The like-honesty chaos run failed exactly here: all 5 likes (3 FB + 2 YouTube) came
// back `pending_approval`, so the agent staged YouTube likes that can never succeed. The preflight runs
// BEFORE the gate and surfaces a typed `like_unsupported_for_target` error to the agent at the CALL
// SITE for an unsupported target, so it proposes gated likes only where supported and honestly declines
// YouTube. FAILS-WITHOUT the preflight (no up-front unsupported signal → the agent stages a doomed like);
// PASSES-WITH (the unsupported target errors at stage time, the supported target preflights `ok`).
describe("likeItem stage-time preflight (supported-vs-unsupported surfaces BEFORE the gate)", () => {
  test("YouTube comment → typed like_unsupported_for_target error at stage time, no fetch, no approval", async () => {
    const db = createMockDb()
    await seedFinding(db, { platform: "youtube", relation: "comment_on_our_content", external_id: "YT_1" })
    const ctx = makeCtx({ db })
    const res = await likeItemPreflight(ctx, { finding_id: "f1" })
    expect(res).toEqual({
      error: {
        code: "like_unsupported_for_target",
        message: expect.stringContaining("not supported"),
      },
    })
    // The preflight must NOT post anything (no external call) and must NOT file an approval — the whole
    // point is the agent learns it is unsupported BEFORE a gated like is ever staged.
    expect(ctx.fetch.calls.length).toBe(0)
    expect((ctx as TestCtx).__approvalInputs.length).toBe(0)
  })

  test.each([
    ["FB own-page comment", { platform: "facebook", relation: "comment_on_our_content" }],
    ["IG own-media comment", { platform: "instagram", relation: "comment_on_our_content" }],
  ])("%s → preflight ok (a supported like proceeds to the gate)", async (_label, target) => {
    const db = createMockDb()
    await seedFinding(db, { platform: target.platform, relation: target.relation, external_id: "OK_1" })
    const ctx = makeCtx({ db })
    const res = await likeItemPreflight(ctx, { finding_id: "f1" })
    expect(res).toEqual({ ok: true })
    expect(ctx.fetch.calls.length).toBe(0)
  })

  test("IG third-party mention → unsupported at stage time (only own-content comments are likeable)", async () => {
    const db = createMockDb()
    await seedFinding(db, { platform: "instagram", relation: "mention_in_post", external_id: "IG_M1" })
    const res = await likeItemPreflight(makeCtx({ db }), { finding_id: "f1" })
    expect(res).toMatchObject({ error: { code: "like_unsupported_for_target" } })
  })

  test("missing finding → typed not_found error (never a silent pass to the gate)", async () => {
    const res = await likeItemPreflight(makeCtx({ db: createMockDb() }), { finding_id: "nope" })
    expect(res).toMatchObject({ error: { code: "not_found" } })
  })
})

// STAGE-TIME preflight (manifest `preflight: replyToFindingPreflightHandler`), following the send_dm /
// like_item pattern in this same file. reply_to_finding is gated, so before this existed a finding_id
// that matches no finding still filed a `pending_approval`, and the handler's `failed: not_found` only
// fired once a human clicked approve: an error only the agent could have fixed. A gated call must not be
// parked for a human when the data it needs is missing. FAILS-WITHOUT (an unknown id reaches the gate);
// PASSES-WITH (it is refused at the call site, with no approval filed and no external post).
// A failed reply must stay diagnosable after the container logs rotate: the HTTP status and the
// provider's own error text land on the finding and in the result the kernel keeps on the approval.
describe("replyToFinding failure reason is recorded", () => {
  test("a 403 quotaExceeded re-entry stores http status + provider error on the finding and returns them", async () => {
    const db = createMockDb()
    await seedFinding(db, { platform: "youtube", relation: "keyword_match", external_id: "VID_1" })
    await db.update("finding", "f1", { metadata: { keep: "me" } })
    const ctx = makeCtx({
      db,
      approval: { approvalRequestId: "appr-9" },
      fetchStatus: 403,
      routes: {
        "/commentThreads": {
          error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] },
        },
      },
    })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: "x" })
    expect(res).toMatchObject({
      status: "failed",
      reason: "blocked",
      http_status: 403,
      provider_error: expect.stringContaining("quotaExceeded"),
    })
    const f = (await db.findMany("finding", { where: { id: "f1" } }))[0] as {
      status: string
      metadata: Record<string, unknown>
    }
    expect(f.status).toBe("failed")
    expect(f.metadata.keep).toBe("me")
    expect(f.metadata.last_reply_failure).toMatchObject({
      reason: "blocked",
      http_status: 403,
      provider_error: expect.stringContaining("exceeded your quota"),
      approval_request_id: "appr-9",
    })
  })
})

// Two reply approvals for the same finding become two public posts once a reviewer approves both.
// The preflight (runs before the gate) refuses a second one while the first is still pending.
describe("replyToFinding stage-time preflight refuses a second pending reply", () => {
  function withPending(ctx: TestCtx, rows: unknown[]): TestCtx {
    ctx.approvals = { pendingFor: async () => JSON.stringify(rows) }
    return ctx
  }

  test("a pending reply on the same finding -> reply_already_pending naming that approval", async () => {
    const db = createMockDb()
    await seedFinding(db)
    const ctx = withPending(makeCtx({ db }), [
      { id: "appr-1", tool_name: "social:reply_to_finding", target_id: "f1", payload: { finding_id: "f1", reply_text: "a" } },
    ])
    const res = await replyToFindingPreflight(ctx, { finding_id: "f1" })
    expect(res).toEqual({
      error: { code: "reply_already_pending", message: expect.stringContaining("appr-1") },
    })
  })

  test("a pending reply on ANOTHER finding, or only a pending like, does not block", async () => {
    const db = createMockDb()
    await seedFinding(db)
    const other = withPending(makeCtx({ db }), [
      { id: "appr-2", tool_name: "social:reply_to_finding", target_id: "f2", payload: {} },
      { id: "appr-3", tool_name: "social:like_item", target_id: "f1", payload: {} },
    ])
    expect(await replyToFindingPreflight(other, { finding_id: "f1" })).toEqual({ ok: true })
  })
})

describe("replyToFinding stage-time preflight (unknown finding refused BEFORE the gate)", () => {
  test("missing finding -> typed not_found, no approval filed, no fetch", async () => {
    const ctx = makeCtx({ db: createMockDb() })
    const res = await replyToFindingPreflight(ctx, { finding_id: "nope" })
    expect(res).toEqual({
      error: { code: "not_found", message: expect.stringContaining("nope") },
    })
    expect(ctx.fetch.calls.length).toBe(0)
    expect((ctx as TestCtx).__approvalInputs.length).toBe(0)
  })

  test("existing finding -> preflight ok (proceeds to the gate), still no side effects", async () => {
    const db = createMockDb()
    await seedFinding(db, { platform: "facebook", relation: "comment_on_our_content" })
    const ctx = makeCtx({ db })
    const res = await replyToFindingPreflight(ctx, { finding_id: "f1" })
    expect(res).toEqual({ ok: true })
    expect(ctx.fetch.calls.length).toBe(0)
    expect((ctx as TestCtx).__approvalInputs.length).toBe(0)
  })
})

// Approvals are for agents: a person's own call holding the deciding scope is
// granted inline (`auto_approved`, nothing filed). The handler must then act
// right away, never park the target as awaiting an approval that does not exist.
describe("granted inline (auto_approved): the action runs on first entry", () => {
  function inlineCtx(db: MockDb): TestCtx {
    const ctx = makeCtx({ db })
    ctx.requestApproval = async () => ({ approval_id: null, auto_approved: true })
    return ctx
  }

  test("reply_to_finding posts once and marks the finding handled", async () => {
    const db = createMockDb()
    await seedFinding(db)
    const ctx = inlineCtx(db)
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: "thanks!" })
    expect(res).toMatchObject({ status: "completed" })
    expect(ctx.fetch.calls.filter((c) => c.method === "POST").length).toBe(1)
    const f = (await db.findMany("finding", { where: { id: "f1" } }))[0] as { status: string }
    expect(f.status).toBe("handled")
  })

  test("like_item likes once", async () => {
    const db = createMockDb()
    await seedFinding(db, { platform: "facebook", relation: "comment_on_our_content", external_id: "X_1" })
    const ctx = inlineCtx(db)
    const res = await likeItem(ctx, { finding_id: "f1" })
    expect(res.status).toBe("completed")
    expect(ctx.fetch.calls.filter((c) => c.method === "POST").length).toBe(1)
  })

  test("send_dm sends within the window", async () => {
    const db = createMockDb()
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "IG_PSID",
      last_inbound_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      status: "open",
    })
    const ctx = inlineCtx(db)
    const res = await sendDm(ctx, { conversation_id: "c1", body: "hello" })
    expect(res.status).toBe("completed")
    expect(ctx.fetch.calls.filter((c) => c.method === "POST").length).toBe(1)
  })
})
