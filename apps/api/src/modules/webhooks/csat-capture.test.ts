// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-194: tokenized CSAT rating-CAPTURE ingest. A customer who received a
// post-resolution satisfaction survey follows a link carrying the opaque
// `survey_token` and submits a 1-5 rating (+ optional comment) — or declines.
// This is the customer-facing INGEST counterpart to the agent-side
// `csatRequest` dispatch (admin.ts). It runs UNAUTHENTICATED (the customer is
// not a logged-in user), keyed solely by the unguessable per-survey token,
// and is idempotent: a survey can be captured exactly once.
//
// Proves (reproduce-first — the route does not exist before the fix, so the
// happy-path capture 404s):
//   * a valid token + score flips the pending survey to `responded`, persists
//     score/comment/responded_at, and the csatSummary aggregate then reflects it;
//   * `declined: true` records a declined response (no score);
//   * an unknown token is 404 (no oracle for valid tokens / org membership);
//   * an out-of-range score is 400 validation_failed and writes nothing;
//   * a second capture on an already-responded survey is 409 (no double-count).

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { runAdminOp } from "~/apps/tickets/admin"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { base32Token } from "~/lib/random-token"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ticketsPublicRoutes } from "./tickets-public"

const app = new Hono().route("/webhooks", ticketsPublicRoutes)

let orgId: string
let userId: string
let pendingToken: string
let pendingSurveyId: string
let declineToken: string
let secondToken: string

function postCapture(
  org: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://x/webhooks/${org}/tickets/csat/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  )
}

async function insertSurvey(token: string): Promise<{ surveyId: string; ticketId: string }> {
  return withSystemDb("csat-capture-fixture", async (tx) => {
    const tk = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity, reply_token,
        sla_target_seconds, sla_deadline, sla_elapsed_seconds, message_count,
        closed_reason, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${`csat-cap-${token.slice(0, 6)}`}, 'Closed case', 'closed', 'normal', 'email', 'internal', ${token.slice(0, 6)},
        28800, now(), 0, 1,
        'resolved', now() - interval '3 days', now() - interval '1 day'
      ) RETURNING id
    `)) as { rows?: Array<{ id: string }> }
    const ticketId = extractRows<{ id: string }>(tk)[0]!.id
    const cs = (await tx.execute(drizzleSql`
      INSERT INTO app_tickets.ticket_csat (
        id, org_id, ticket_id, contact_id, status, survey_token, sent_at, created_by, created_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${ticketId}::uuid, null, 'pending', ${token}, now(), ${userId}::uuid, now()
      ) RETURNING id
    `)) as { rows?: Array<{ id: string }> }
    const surveyId = extractRows<{ id: string }>(cs)[0]!.id
    return { surveyId, ticketId }
  })
}

beforeAll(async () => {
  const slug = `csat-cap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("csat-capture-org", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Csat Capture Test', ${slug}) RETURNING id
    `)) as { rows?: Array<{ id: string }> }
    orgId = extractRows<{ id: string }>(orgRows)[0]!.id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `)) as { rows?: Array<{ id: string }> }
    userId = extractRows<{ id: string }>(u)[0]!.id
  })
  await ensureAppsForOrg(orgId, {})
  pendingToken = base32Token(16)
  declineToken = base32Token(16)
  secondToken = base32Token(16)
  pendingSurveyId = (await insertSurvey(pendingToken)).surveyId
  await insertSurvey(declineToken)
  await insertSurvey(secondToken)
})

function reader() {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: { "tickets:team": ["*"], "tickets:sensitivity": ["restricted"] },
  }
}

describe("csat capture-ingest (BL-194)", () => {
  it("records a 1-5 rating against a valid token and flips the survey to responded", async () => {
    const res = await postCapture(orgId, pendingToken, { score: 5, comment: "Great help!" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { recorded: boolean; status: string } }
    expect(body.data.recorded).toBe(true)
    expect(body.data.status).toBe("responded")

    const row = await withSystemDb("csat-capture-verify", async (tx) => {
      const r = (await tx.execute(drizzleSql`
        SELECT status, score, comment, responded_at FROM app_tickets.ticket_csat
        WHERE id = ${pendingSurveyId}::uuid
      `)) as { rows?: Array<Record<string, unknown>> }
      return extractRows<{
        status: string
        score: number
        comment: string | null
        responded_at: Date | null
      }>(r)[0]!
    })
    expect(row.status).toBe("responded")
    expect(row.score).toBe(5)
    expect(row.comment).toBe("Great help!")
    expect(row.responded_at).not.toBeNull()

    // The agent-side aggregate now sees the recorded response (no longer null).
    const summary = (await withRlsContext(reader(), (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "csatSummary",
        {},
        { actorType: "user", userId, scopes: reader().scopes },
      ),
    )) as { responded: number; averageScore: number | null }
    expect(summary.responded).toBeGreaterThanOrEqual(1)
    expect(summary.averageScore).not.toBeNull()
  })

  it("records a declined response without a score", async () => {
    const res = await postCapture(orgId, declineToken, { declined: true })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { status: string } }
    expect(body.data.status).toBe("declined")
  })

  it("returns 404 for an unknown token (no valid-token oracle)", async () => {
    const res = await postCapture(orgId, base32Token(16), { score: 4 })
    expect(res.status).toBe(404)
  })

  it("rejects an out-of-range score with 400 and writes nothing", async () => {
    const before = await withSystemDb("csat-capture-second-before", async (tx) => {
      const r = (await tx.execute(drizzleSql`
        SELECT status FROM app_tickets.ticket_csat WHERE survey_token = ${secondToken}
      `)) as { rows?: Array<{ status: string }> }
      return extractRows<{ status: string }>(r)[0]!.status
    })
    expect(before).toBe("pending")

    const res = await postCapture(orgId, secondToken, { score: 9 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation_failed")

    const after = await withSystemDb("csat-capture-second-after", async (tx) => {
      const r = (await tx.execute(drizzleSql`
        SELECT status FROM app_tickets.ticket_csat WHERE survey_token = ${secondToken}
      `)) as { rows?: Array<{ status: string }> }
      return extractRows<{ status: string }>(r)[0]!.status
    })
    expect(after).toBe("pending")
  })

  it("is capture-once: a second submission on a responded survey is 409", async () => {
    const res = await postCapture(orgId, pendingToken, { score: 1 })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("already_captured")

    // The original score is untouched (no double-count, no overwrite).
    const row = await withSystemDb("csat-capture-recheck", async (tx) => {
      const r = (await tx.execute(drizzleSql`
        SELECT score FROM app_tickets.ticket_csat WHERE id = ${pendingSurveyId}::uuid
      `)) as { rows?: Array<{ score: number }> }
      return extractRows<{ score: number }>(r)[0]!
    })
    expect(row.score).toBe(5)
  })
})
