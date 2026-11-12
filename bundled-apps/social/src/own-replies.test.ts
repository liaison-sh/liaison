// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Our own replies are never findings, and a reply whose post timed out on our
// side is reconciled, never posted twice.
//
//  - Ingest: a comment the org's own Page wrote (Meta echoes it like any other)
//    is not stored as a finding; it marks the finding it answers `handled` and a
//    matching reply intent as landed. Webhook and sync paths both.
//  - Post-back: reply_to_finding looks for our reply before posting; its
//    reconciler (manifest `reconcileHandler`) settles an approval whose outcome
//    is unknown from the recorded echo or from a read of the target's replies.

import { describe, expect, test } from "bun:test"
import type { AdapterContext, DiscoverResult, PlatformAdapter } from "./adapters/types"
import type { SocialToolCtx } from "./ctx"
import { parseWebhookJob, upsertFinding } from "./ingest"
import { reconcileReplyToFinding, replyToFinding } from "./post-back"
import { runDiscoverySync } from "./sync"
import { createMockDb, type MockDb } from "./test-db"

const PAGE = "111"
const POST = `${PAGE}_222`
const CUSTOMER_COMMENT = "222_333"
const OUR_REPLY = "222_444"
const REPLY = "Thanks, glad you like it!"

interface Call {
  url: string
  method: string
  body?: unknown
  timeoutMs?: number
}

interface Recorder {
  calls: Call[]
  protocol: Array<{ step: string; ref?: unknown }>
}

/** A ctx whose fetch answers Graph like Meta does: `/me/accounts` lists the
 *  Page, `GET {comment}/comments` lists `replies`, a POST answers `post`. */
function ctxFor(
  db: MockDb,
  opts: {
    approvalRequestId?: string
    replies?: Array<{ id: string; message: string; from: { id: string } }> | "error"
    post?: { status: number; body: unknown } | "timeout"
  } = {},
): SocialToolCtx & Recorder {
  const rec: Recorder = { calls: [], protocol: [] }
  const ctx = {
    orgId: "org-1",
    db,
    async fetch(url: string, init?: { method?: string; body?: unknown; timeoutMs?: number }) {
      const method = init?.method ?? "GET"
      rec.calls.push({ url, method, body: init?.body, timeoutMs: init?.timeoutMs })
      if (url.includes("/me/accounts")) {
        return {
          status: 200,
          body: JSON.stringify({ data: [{ id: PAGE, access_token: "page-token" }] }),
        }
      }
      if (method === "GET" && url.includes("/comments")) {
        if (opts.replies === "error") return { status: 500, body: "{}" }
        return { status: 200, body: JSON.stringify({ data: opts.replies ?? [] }) }
      }
      if (method === "POST") {
        if (opts.post === "timeout") throw new Error("Fetch timed out after 20000ms")
        const p = opts.post ?? { status: 200, body: { id: OUR_REPLY } }
        return { status: p.status, body: JSON.stringify(p.body) }
      }
      return { status: 200, body: "{}" }
    },
    connections: { getToken: async () => "user-token" },
    config: { get: async () => null },
    approval: opts.approvalRequestId ? { approvalRequestId: opts.approvalRequestId } : undefined,
    async emit() {},
    async approval_recordStarted() {
      rec.protocol.push({ step: "started" })
    },
    async approval_recordEffectLanded(_t: string, ref: string) {
      rec.protocol.push({ step: "landed", ref: JSON.parse(ref) })
    },
    async approval_recordSucceeded(_t: string, ref?: string) {
      rec.protocol.push({ step: "succeeded", ref: ref ? JSON.parse(ref) : undefined })
    },
    async approval_recordFailedNoEffect(_t: string, err: string) {
      rec.protocol.push({ step: "failed_no_effect", ref: JSON.parse(err) })
    },
    ...rec,
  }
  return ctx as unknown as SocialToolCtx & Recorder
}

async function seed(db: MockDb, metadata: Record<string, unknown> = {}): Promise<void> {
  await db.insert("sync_state", {
    id: "ss-fb",
    platform: "facebook",
    account_external_id: "user-9",
    source_type: "discovery",
    active: true,
  })
  await db.insert("finding", {
    id: "f1",
    platform: "facebook",
    external_id: CUSTOMER_COMMENT,
    parent_external_id: POST,
    relation: "comment_on_our_content",
    status: "triaged",
    content_text: "Love this!",
    metadata,
  })
}

/** Meta's feed delivery for a comment the Page wrote in reply to a comment. */
function echo(from = PAGE, message = REPLY) {
  return {
    object: "page",
    entry: [
      {
        id: PAGE,
        time: 1_780_000_000,
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: OUR_REPLY,
              post_id: POST,
              parent_id: CUSTOMER_COMMENT,
              from: { id: from, name: "Our Page" },
              message,
              created_time: 1_780_000_000,
            },
          },
        ],
      },
    ],
  }
}

async function finding(db: MockDb, id = "f1") {
  return (await db.findMany("finding", { where: { id } }))[0] as {
    status: string
    metadata: Record<string, any>
  }
}

describe("own replies are evidence, never findings", () => {
  test("webhook: the Page's echoed reply is not a finding and marks the comment it answers handled", async () => {
    const db = createMockDb()
    await seed(db)
    const res = await parseWebhookJob(ctxFor(db), { platform: "facebook", body: echo() })
    expect(res.ingested).toBe(0)
    expect(await db.count("finding", { where: { external_id: OUR_REPLY } })).toBe(0)
    const f = await finding(db)
    expect(f.status).toBe("handled")
    expect(f.metadata.own_reply).toMatchObject({ external_id: OUR_REPLY })
  })

  test("webhook: a customer's comment is still a finding", async () => {
    const db = createMockDb()
    await seed(db)
    const res = await parseWebhookJob(ctxFor(db), {
      platform: "facebook",
      body: echo("customer-7", "Where can I buy it?"),
    })
    expect(res.ingested).toBe(1)
    expect(await db.count("finding", { where: { external_id: OUR_REPLY } })).toBe(1)
    expect((await finding(db)).status).toBe("triaged")
  })

  test("webhook: the echo of a gated reply marks its intent landed; a stored copy of the echo is dismissed", async () => {
    const db = createMockDb()
    await seed(db, { reply_intent: { approval_request_id: "appr-1", reply_text: REPLY } })
    // A copy stored as a finding before this rule existed.
    await db.insert("finding", {
      id: "self-1",
      platform: "facebook",
      external_id: OUR_REPLY,
      relation: "comment_on_our_content",
      status: "new",
      author_external_id: PAGE,
      metadata: {},
    })
    await parseWebhookJob(ctxFor(db), { platform: "facebook", body: echo() })
    const f = await finding(db)
    expect(f.status).toBe("handled")
    expect(f.metadata.reply_intent).toMatchObject({
      outcome: "landed",
      reply_external_id: OUR_REPLY,
    })
    expect((await finding(db, "self-1")).status).toBe("dismissed")
  })

  test("sync: an own-authored item from a poll goes through the same gate", async () => {
    const db = createMockDb()
    await seed(db)
    const adapter = {
      platform: "facebook",
      async discover(_ctx: AdapterContext): Promise<DiscoverResult> {
        return {
          findings: [
            {
              platform: "facebook",
              externalId: OUR_REPLY,
              relation: "comment_on_our_content",
              parentExternalId: POST,
              authorExternalId: PAGE,
              contentText: REPLY,
              replyToExternalId: CUSTOMER_COMMENT,
            },
          ],
          nextCursor: null,
          unitsConsumed: 0,
        }
      },
      async pollObject(): Promise<DiscoverResult> {
        return { findings: [], nextCursor: null, unitsConsumed: 0 }
      },
    } as unknown as PlatformAdapter
    const out = await runDiscoverySync(ctxFor(db), { adapter, accountExternalId: "user-9" })
    expect(out.ingested).toBe(0)
    expect(await db.count("finding", { where: { external_id: OUR_REPLY } })).toBe(0)
    expect((await finding(db)).status).toBe("handled")
  })

  test("an author matching a connected account id is own, even without the adapter's flag", async () => {
    const db = createMockDb()
    await seed(db)
    const res = await upsertFinding(ctxFor(db), {
      platform: "facebook",
      externalId: "999_1",
      relation: "mention",
      authorExternalId: "user-9",
      contentText: "x",
    })
    expect(res.created).toBe(false)
    expect(await db.count("finding", { where: { external_id: "999_1" } })).toBe(0)
  })
})

describe("reply_to_finding: look before posting, reconcile an unknown outcome", () => {
  test("posts once, with a write deadline, and records started → landed → succeeded", async () => {
    const db = createMockDb()
    await seed(db)
    const ctx = ctxFor(db, { approvalRequestId: "appr-1" })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: REPLY })
    expect(res).toMatchObject({ status: "completed", reply_external_id: OUR_REPLY })
    const posts = ctx.calls.filter((c) => c.method === "POST")
    expect(posts.length).toBe(1)
    expect(posts[0]!.timeoutMs).toBe(20_000)
    expect(ctx.protocol.map((p) => p.step)).toEqual(["started", "landed", "succeeded"])
    const f = await finding(db)
    expect(f.status).toBe("handled")
    expect(f.metadata.reply_intent).toMatchObject({
      approval_request_id: "appr-1",
      outcome: "landed",
    })
  })

  test("a retry whose earlier post went through finds the reply and does not post again", async () => {
    const db = createMockDb()
    await seed(db, { reply_intent: { approval_request_id: "appr-1", reply_text: REPLY } })
    const ctx = ctxFor(db, {
      approvalRequestId: "appr-1",
      replies: [{ id: OUR_REPLY, message: `  ${REPLY} `, from: { id: PAGE } }],
    })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: REPLY })
    expect(res).toMatchObject({ status: "completed", already_posted: true })
    expect(ctx.calls.filter((c) => c.method === "POST").length).toBe(0)
    expect((await finding(db)).status).toBe("handled")
  })

  test("a retry that cannot read the replies does not post and leaves the outcome unknown", async () => {
    const db = createMockDb()
    await seed(db, { reply_intent: { approval_request_id: "appr-1", reply_text: REPLY } })
    const ctx = ctxFor(db, { approvalRequestId: "appr-1", replies: "error" })
    await expect(replyToFinding(ctx, { finding_id: "f1", reply_text: REPLY })).rejects.toThrow(
      /send_outcome_unknown/,
    )
    expect(ctx.calls.filter((c) => c.method === "POST").length).toBe(0)
    expect(ctx.protocol.map((p) => p.step)).toEqual(["started"])
  })

  test("a retry whose earlier post did not land posts", async () => {
    const db = createMockDb()
    await seed(db, { reply_intent: { approval_request_id: "appr-1", reply_text: REPLY } })
    const ctx = ctxFor(db, { approvalRequestId: "appr-1", replies: [] })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: REPLY })
    expect(res).toMatchObject({ status: "completed" })
    expect(ctx.calls.filter((c) => c.method === "POST").length).toBe(1)
  })

  test("a POST that times out leaves `started` behind (the host settles it as unknown)", async () => {
    const db = createMockDb()
    await seed(db)
    const ctx = ctxFor(db, { approvalRequestId: "appr-1", post: "timeout" })
    await expect(replyToFinding(ctx, { finding_id: "f1", reply_text: REPLY })).rejects.toThrow(
      /timed out/,
    )
    expect(ctx.protocol.map((p) => p.step)).toEqual(["started"])
    expect((await finding(db)).metadata.reply_intent).toMatchObject({
      approval_request_id: "appr-1",
      reply_text: REPLY,
    })
  })

  test("a refused POST records failed (no effect)", async () => {
    const db = createMockDb()
    await seed(db)
    const ctx = ctxFor(db, {
      approvalRequestId: "appr-1",
      post: { status: 400, body: { error: { message: "nope" } } },
    })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: REPLY })
    expect(res).toMatchObject({ status: "failed" })
    expect(ctx.protocol.map((p) => p.step)).toEqual(["started", "failed_no_effect"])
    // A refusal the same reply meets again closes the approval instead of re-pending it.
    expect(ctx.protocol[1]?.ref).toMatchObject({ code: "reply_blocked", final: true })
  })

  test("a rate-limited POST records failed (no effect) and leaves the approval to be approved again", async () => {
    const db = createMockDb()
    await seed(db)
    const ctx = ctxFor(db, {
      approvalRequestId: "appr-1",
      post: { status: 429, body: { error: { message: "slow down" } } },
    })
    const res = await replyToFinding(ctx, { finding_id: "f1", reply_text: REPLY })
    expect(res).toMatchObject({ status: "failed", reason: "rate_limited" })
    expect(ctx.protocol[1]?.step).toBe("failed_no_effect")
    expect((ctx.protocol[1]!.ref as Record<string, unknown>).final).toBeUndefined()
  })

  test("reconcile: the echo after a timed-out post settles the approval as executed, without a Graph read", async () => {
    const db = createMockDb()
    await seed(db)
    await expect(
      replyToFinding(ctxFor(db, { approvalRequestId: "appr-1", post: "timeout" }), {
        finding_id: "f1",
        reply_text: REPLY,
      }),
    ).rejects.toThrow()
    // Meta echoes the comment a few seconds later.
    await parseWebhookJob(ctxFor(db), { platform: "facebook", body: echo() })
    const ctx = ctxFor(db)
    const out = await reconcileReplyToFinding(ctx, {
      approval_request_id: "appr-1",
      payload: { finding_id: "f1", reply_text: REPLY },
    })
    expect(out).toMatchObject({
      outcome: "executed",
      ref: { reply_external_id: OUR_REPLY, source: "recorded" },
    })
    expect(ctx.calls.length).toBe(0)
  })

  test("reconcile: with no echo, a read of the replies that shows ours settles it as executed", async () => {
    const db = createMockDb()
    await seed(db, { reply_intent: { approval_request_id: "appr-1", reply_text: REPLY } })
    const out = await reconcileReplyToFinding(
      ctxFor(db, { replies: [{ id: OUR_REPLY, message: REPLY, from: { id: PAGE } }] }),
      { approval_request_id: "appr-1", payload: { finding_id: "f1", reply_text: REPLY } },
    )
    expect(out).toMatchObject({
      outcome: "executed",
      ref: { reply_external_id: OUR_REPLY, source: "platform_read" },
    })
    expect((await finding(db)).status).toBe("handled")
  })

  test("reconcile: replies read and ours absent → not executed, and the intent no longer blocks a later post", async () => {
    const db = createMockDb()
    await seed(db, { reply_intent: { approval_request_id: "appr-1", reply_text: REPLY } })
    const out = await reconcileReplyToFinding(
      ctxFor(db, { replies: [{ id: "x", message: REPLY, from: { id: "someone-else" } }] }),
      { approval_request_id: "appr-1", payload: { finding_id: "f1", reply_text: REPLY } },
    )
    expect(out.outcome).toBe("not_executed")
    expect((await finding(db)).metadata.reply_intent).toBeUndefined()
  })

  test("reconcile: an unreadable target stays unknown", async () => {
    const db = createMockDb()
    await seed(db)
    const out = await reconcileReplyToFinding(ctxFor(db, { replies: "error" }), {
      approval_request_id: "appr-1",
      payload: { finding_id: "f1", reply_text: REPLY },
    })
    expect(out.outcome).toBe("unknown")
  })
})
