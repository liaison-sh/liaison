// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person's own ticket reply under an org two-approver (N-eyes) policy, end to
// end through the real server, the Gmail send fixture and the approvals API.
//
// Approvals are for agents, not persons: a person's own call runs on the tool's
// own permission. The one exception is an org policy demanding two distinct
// approvers: the person's send PARKS, their click counts as one sign-off when
// they could decide it, and a second distinct person must approve before
// anything is sent. The requester can never approve their own request again.
//
//   (a) A (reply + approve scopes) sends: parked at 1 of 2, nothing sent, A sees it pending
//   (b) A approves their own request: refused, still 1 of 2
//   (c) B approves: sent exactly once, status approved
//   (d) B rejects instead: nothing sent, A sees it denied
//   (e) it expires: nothing sent
//   (f) C without the reply scope: 403, no approval row
//   (g) no policy: A's send goes straight out
//   (h) B and D approve at once: sent exactly once
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld } from "@liaison/test-helpers"
import { api, createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import { type GmailHttpFixture, startGmailHttpFixture } from "~/tests/fixtures/email/gmail-http"
import { decide, enqueueKernelJobNow, pollUntil } from "./helpers/approvals"
import { ks, seedConnectedAccount, seedInbox, seedTicket, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

let env: WorkerEnv
let world: TestWorld
let url: string
let gmail: GmailHttpFixture

type Person = { id: string; token: string; email: string; name: string }
let a: Person // sends; holds reply AND approve
let b: Person // approver
let c: Person // approver who may not reply
let d: Person // second approver

const SUPPORT = [
  "tickets:tickets:read",
  "tickets:tickets:write",
  "tickets:inboxes:read",
  "kernel:threads:read",
  "kernel:threads:write",
  // A standard member's approval scopes (the attention feed and the live
  // approval frames read under kernel:approvals:read).
  "kernel:approvals:read",
  "kernel:approvals:write",
]

async function person(name: string, scopes: string[]): Promise<Person> {
  return createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
    name,
    scopes,
    dimensions: { "*": ["*"] },
    schemaPrefix: env.schemaPrefix,
  })
}

beforeAll(async () => {
  gmail = await startGmailHttpFixture()
  const r = await setupScenario({
    seed: 741,
    serverEnv: { TICKETS_E2E_GMAIL_API_BASE_URL: gmail.apiBaseUrl },
  })
  env = r.env
  world = r.world
  url = env.serverUrl
  a = await person("N-A", [...SUPPORT, "tickets:tickets:reply", "tickets:approve"])
  b = await person("N-B", [...SUPPORT, "tickets:approve"])
  c = await person("N-C", [...SUPPORT, "tickets:approve"])
  d = await person("N-D", [...SUPPORT, "tickets:approve"])
}, 120_000)

afterAll(async () => {
  await gmail.close()
  await teardownScenario(env, world)
})

async function setTwoApproverPolicy(on: boolean): Promise<void> {
  await env.db.sql.unsafe(
    `DELETE FROM ${ks(env)}.approval_policies WHERE org_id = $1 AND tool_name = 'tickets:reply'`,
    [world.org.id],
  )
  if (!on) return
  await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.approval_policies
       (org_id, tool_name, enabled, conditions, require_approval, min_approvers, created_by)
     VALUES ($1, 'tickets:reply', true, '[]'::jsonb, true, 2, $2)`,
    [world.org.id, world.admin.id],
  )
}

/** A ticket on a connected inbox whose sends land in the Gmail fixture. */
async function replyableTicket(tag: string): Promise<{ ticketId: string; account: string }> {
  const account = `${tag}-${Date.now()}@org.test`
  const ca = await seedConnectedAccount(env, {
    orgId: world.org.id,
    email: account,
    createdBy: world.admin.id,
    appName: "tickets",
    accessToken: "test-access-token",
  })
  const inbox = await seedInbox(env, {
    orgId: world.org.id,
    connectedAccountId: ca.id,
    emailAddress: account,
    name: `${tag} inbox`,
  })
  const ticket = await seedTicket(env, {
    orgId: world.org.id,
    subject: `${tag} ${Date.now()}`,
    sourceInboxId: inbox.id,
    status: "open",
  })
  await env.db.sql.unsafe(
    `INSERT INTO ${ts(env)}.messages (
      id, org_id, ticket_id, kind, from_email, from_name, to_emails, subject,
      text_body, snippet, external_message_id, sent_at, created_at, updated_at
    ) VALUES (gen_random_uuid(), $1, $2, 'inbound', 'cust@cust.test', 'Cust', '[]'::jsonb,
      'Question', 'hello', 'hello', $3, now() - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute')`,
    [world.org.id, ticket.id, `<in-${ticket.id}@cust.test>`],
  )
  gmail.queueSendResponse(account, { id: `gm-${tag}`, threadId: `gt-${tag}` })
  return { ticketId: ticket.id, account }
}

/** The person's own composer send (REST, origin human-ui). */
function personReply(who: Person, ticketId: string, text: string) {
  return api(url, "/api/apps/run-tool", {
    method: "POST",
    token: who.token,
    body: { toolName: "tickets:reply", params: { ticketId, textBody: text } },
  })
}

const sends = () => gmail.requests().filter((r) => r.route === "messages.send").length

async function outboundCount(ticketId: string): Promise<number> {
  const rows = (await env.db.sql.unsafe(
    `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE ticket_id = $1 AND kind = 'outbound'`,
    [ticketId],
  )) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

async function approvalRow(id: string) {
  const [row] = (await env.db.sql.unsafe(
    `SELECT status, requested_by, metadata, notify_user_ids FROM ${ks(env)}.approval_requests WHERE id = $1`,
    [id],
  )) as Array<{
    status: string
    requested_by: string
    metadata: { minApprovers?: number; approvedBy?: string[] }
    notify_user_ids: string[]
  }>
  return row
}

async function parkedReply(tag: string): Promise<{ ticketId: string; requestId: string }> {
  const { ticketId } = await replyableTicket(tag)
  const res = await personReply(a, ticketId, `Reply ${tag}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const requestId = res.body?.data?.blocked?.approvalRequestId as string
  expect(requestId, JSON.stringify(res.body)).toBeTruthy()
  return { ticketId, requestId }
}

describe("a person's own reply under a two-approver policy", () => {
  beforeAll(async () => {
    await setTwoApproverPolicy(true)
  })

  it("(a) parks at 1 of 2 with the sender's own sign-off; nothing is sent; the sender sees it pending", async () => {
    gmail.reset()
    const { ticketId, requestId } = await parkedReply("na")
    const row = await approvalRow(requestId)
    expect(row.status).toBe("pending")
    expect(row.requested_by).toBe(a.id)
    expect(row.metadata.minApprovers).toBe(2)
    expect(row.metadata.approvedBy).toEqual([a.id])
    // Fanned out to the other eligible approvers.
    expect(row.notify_user_ids).toEqual(expect.arrayContaining([b.id, c.id, d.id]))
    const decidable = await api(url, "/api/approvals?status=pending&decidableByMe=true", {
      token: b.token,
    })
    const decidableIds = ((decidable.body?.data ?? []) as Array<{ id: string }>).map((x) => x.id)
    expect(decidableIds).toContain(requestId)
    // Their attention feed carries it as a decision; the sender's does not
    // (their sign-off is already counted, decide.ts refuses a second one).
    const feedIds = async (token: string) =>
      (
        ((await api(url, "/api/attention-items", { token })).body?.data?.items ?? []) as Array<{
          kind: string
          entityId: string
        }>
      )
        .filter((i) => i.kind === "approval_pending")
        .map((i) => i.entityId)
    expect(
      await pollUntil(
        async () => ((await feedIds(b.token)).includes(requestId) ? true : null),
        10_000,
      ),
    ).toBe(true)
    expect(await feedIds(a.token)).not.toContain(requestId)
    // ...and as a decision to make, not peer noise the feed hides by default:
    // the sender can never finish it alone.
    const bFeed = (await api(url, "/api/attention-items", { token: b.token })).body?.data
      ?.items as Array<{ entityId: string; metadata?: { peerSelfApprovable?: boolean } }>
    expect(bFeed.find((i) => i.entityId === requestId)?.metadata?.peerSelfApprovable).not.toBe(true)
    // The sender reads it as pending.
    const mine = await api(url, `/api/approvals/${requestId}`, { token: a.token })
    expect(mine.status).toBe(200)
    expect(mine.body?.data?.status).toBe("pending")
    expect(sends()).toBe(0)
    expect(await outboundCount(ticketId)).toBe(0)
  })

  it("(b) the sender cannot approve their own request: refused, still 1 of 2, nothing sent", async () => {
    gmail.reset()
    const { ticketId, requestId } = await parkedReply("nb")
    const own = await decide(url, a.token, requestId, { decision: "approve" })
    expect(own.status, JSON.stringify(own.body)).toBe(409)
    const row = await approvalRow(requestId)
    expect(row.status).toBe("pending")
    expect(row.metadata.approvedBy).toEqual([a.id])
    expect(sends()).toBe(0)
    expect(await outboundCount(ticketId)).toBe(0)
  })

  it("(c) a second, distinct approver sends it exactly once", async () => {
    gmail.reset()
    const { ticketId, requestId } = await parkedReply("nc")
    const ok = await decide(url, b.token, requestId, { decision: "approve" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const row = await pollUntil(async () => {
      const r = await approvalRow(requestId)
      return r.status === "approved" ? r : null
    }, 15_000)
    expect(row.metadata.approvedBy).toEqual([a.id, b.id])
    expect(sends()).toBe(1)
    expect(await outboundCount(ticketId)).toBe(1)
    const mine = await api(url, `/api/approvals/${requestId}`, { token: a.token })
    expect(mine.body?.data?.status).toBe("approved")
  })

  it("(d) rejected by the approver: nothing is sent and the sender sees it rejected", async () => {
    gmail.reset()
    const { ticketId, requestId } = await parkedReply("nd")
    const no = await decide(url, b.token, requestId, { decision: "deny", reason: "Not this" })
    expect(no.status, JSON.stringify(no.body)).toBe(200)
    expect((await approvalRow(requestId)).status).toBe("denied")
    const mine = await api(url, `/api/approvals/${requestId}`, { token: a.token })
    expect(mine.body?.data?.status).toBe("denied")
    expect(sends()).toBe(0)
    expect(await outboundCount(ticketId)).toBe(0)
  })

  it("(e) expired: nothing is sent", async () => {
    gmail.reset()
    const { ticketId, requestId } = await parkedReply("ne")
    await enqueueKernelJobNow(
      env,
      "approval-expiry",
      { orgId: world.org.id, requestId },
      `approval-expiry:${requestId}:neyes`,
    )
    const row = await pollUntil(async () => {
      const r = await approvalRow(requestId)
      return r.status === "expired" ? r : null
    }, 10_000)
    expect(row.status).toBe("expired")
    expect(sends()).toBe(0)
    expect(await outboundCount(ticketId)).toBe(0)
  })

  it("(h) two approvers clicking at once send it exactly once", async () => {
    gmail.reset()
    const { ticketId, requestId } = await parkedReply("nh")
    const [r1, r2] = await Promise.all([
      decide(url, b.token, requestId, { decision: "approve" }),
      decide(url, d.token, requestId, { decision: "approve" }),
    ])
    expect([r1.status, r2.status]).toContain(200)
    await pollUntil(async () => {
      const r = await approvalRow(requestId)
      return r.status === "approved" ? r : null
    }, 15_000)
    // Let any second execution that would race in land before counting.
    await Bun.sleep(500)
    expect(sends()).toBe(1)
    expect(await outboundCount(ticketId)).toBe(1)
  })

  it("(i) a stalled execution stays in the feeds of the people who signed it", async () => {
    gmail.reset()
    const { requestId } = await parkedReply("ni")
    // The final approver is recorded before execution; the execution then
    // dies (a container recreate mid-handler): the row sits at `approving`.
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.approval_requests
          SET status = 'approving', approving_started_at = now() - interval '1 hour',
              metadata = jsonb_set(metadata, '{approvedBy}', $2::jsonb, true)
        WHERE id = $1`,
      [requestId, JSON.stringify([a.id, b.id])],
    )
    const ids = async (token: string) =>
      (
        ((await api(url, "/api/attention-items", { token })).body?.data?.items ?? []) as Array<{
          kind: string
          entityId: string
        }>
      )
        .filter((i) => i.kind === "approval_pending")
        .map((i) => i.entityId)
    expect(await ids(a.token)).toContain(requestId)
    expect(await ids(b.token)).toContain(requestId)
    // Put it out of the way of the remaining cases.
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.approval_requests SET status = 'denied' WHERE id = $1`,
      [requestId],
    )
  })

  it("(f) a person without the reply scope is refused 403 and nothing parks", async () => {
    gmail.reset()
    const { ticketId } = await replyableTicket("nf")
    const before = (await env.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${ks(env)}.approval_requests WHERE org_id = $1 AND requested_by = $2`,
      [world.org.id, c.id],
    )) as Array<{ n: number }>
    const res = await personReply(c, ticketId, "Not my job")
    expect(res.status).toBe(403)
    expect(String(res.body?.error?.message)).toContain("tickets:tickets:reply")
    const after = (await env.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${ks(env)}.approval_requests WHERE org_id = $1 AND requested_by = $2`,
      [world.org.id, c.id],
    )) as Array<{ n: number }>
    expect(after[0]?.n).toBe(before[0]?.n)
    expect(sends()).toBe(0)
  })

  it("(g) with no policy the sender's reply goes straight out", async () => {
    await setTwoApproverPolicy(false)
    gmail.reset()
    const { ticketId } = await replyableTicket("ng")
    const res = await personReply(a, ticketId, "Straight out")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body?.data?.blocked).toBeUndefined()
    expect(sends()).toBe(1)
    expect(await outboundCount(ticketId)).toBe(1)
  })
})
