// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real Postgres, real sandbox, real kernel, social registered from source.
//
// 1. A signed Meta delivery reaches rows. The kernel route verifies the
//    signature with the app's verifier, hands the PARSED body to `metaWebhook`,
//    which enqueues `parse-webhook`; the job the kernel registered from the
//    manifest then lands a Page DM as dm_conversation + dm_message and a Page
//    feed comment as a finding. The unit tests call the job function directly,
//    which is how an undeclared job (the kernel refuses to enqueue it) and a
//    handler reading a `{ rawBody }` wrapper the router never sends both went
//    unnoticed: every real delivery failed.
// 2. reply_to_finding: an agent's second reply on the same finding is refused
//    while the first is pending (one approval, never two public posts), and a
//    reply the platform rejects records the HTTP status and the provider's
//    error on the finding and in the approval's execution record.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { getJobQueue, JobsTestAccess } from "~/infra/jobs/jobs"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, "bundled-apps", "social", "app.manifest.json"), "utf8"),
) as Record<string, unknown> & { version: string }

const ORG = randomUUID()
const USER = randomUUID()
const APPROVER = randomUUID()
const THREAD = randomUUID()
const APP_SECRET = "meta-app-secret-integration"
const SCOPES = [
  "social:findings:read",
  "social:findings:write",
  "social:dm:read",
  "social:dm:write",
  "social:watched:read",
  "social:terms:read",
]
const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}

// A person who decides social approvals (the deciding scope is `social:approve`).
const approver: UserContext = {
  actorType: "user",
  userId: APPROVER,
  orgId: ORG,
  scopes: [...SCOPES, "social:approve"],
  dimensionGrants: {},
}

const YT_HOST = "www.googleapis.com"
const posts: Array<{ url: string; body: string }> = []
const QUOTA_BODY = JSON.stringify({
  error: {
    code: 403,
    message: "The request cannot be completed because you have exceeded your quota.",
    errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }],
  },
})
const ytFake = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if ((init?.method ?? "GET").toUpperCase() === "POST") {
    posts.push({ url, body: String(init?.body ?? "") })
  }
  return new Response(QUOTA_BODY, { status: 403, headers: { "content-type": "application/json" } })
}) as unknown as typeof fetch

function signedDelivery(body: unknown) {
  const raw = JSON.stringify(body)
  const sig = createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex")
  return app.request(`/webhooks/${ORG}/social/meta`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${sig}` },
    body: raw,
  })
}

/** The parse-webhook jobs this org's deliveries enqueued, in any state. */
async function parseJobsForOrg(): Promise<Array<{ data: Record<string, unknown> }>> {
  const jobs = await getJobQueue("social", "parse-webhook").getJobs([
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
    "prioritized",
  ])
  return jobs
    .filter((j) => j?.name === "parse-webhook" && (j.data as { orgId?: string }).orgId === ORG)
    .map((j) => ({ data: j.data as Record<string, unknown> }))
}

/** Run one enqueued job exactly as the worker would: the handler the kernel registered from the
 *  manifest, under the job actor, in a session. */
async function runParseJob(data: Record<string, unknown>): Promise<void> {
  const handler = JobsTestAccess.getHandler("social", "parse-webhook")
  if (!handler) throw new Error("parse-webhook is not registered")
  await dispatchAppJobWithContext(
    handler,
    data,
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["social:*"] },
    "session",
  )
}

describe("social through the kernel (real Postgres, sandbox, kernel webhook route and approvals)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Social Webhook Org', ${`social-wh-${ORG.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, ${`social-${USER.slice(0, 8)}@test.com`}, 'hash', 'Social Operator', 'active')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, ${`social-thread-${THREAD.slice(0, 8)}`}, 'agent_chat', ${USER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${THREAD}, ${USER}, ${ORG}, 'admin')`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER}, ${THREAD}, ${ORG})`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${APPROVER}, ${ORG}, ${`social-appr-${APPROVER.slice(0, 8)}@test.com`}, 'hash', 'Social Approver', 'active')`
    for (const scope of SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    for (const scope of approver.scopes) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${APPROVER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    // The Meta App Secret the verifier signs with, stored encrypted as the OAuth client secret is.
    const config = {
      socialMetaAppSecret: encryptSecret(
        APP_SECRET,
        env.ENCRYPTION_KEY,
        CryptoContext.appConfigConnectionSecret,
      ),
    }
    await sql`INSERT INTO kernel.apps (id, org_id, name, version, status, config)
      VALUES (gen_random_uuid(), ${ORG}, 'social', ${MANIFEST.version}, 'active', ${JSON.stringify(config)}::jsonb)`
    await initSandboxPool()
    await initWorkerPool()
    await registerApps(
      [
        {
          ...MANIFEST,
          trusted: false,
          _format: "manifest",
          _bundlePath: join(REPO_ROOT, "bundled-apps", "social", MANIFEST.version, "bundle.js"),
        } as never,
      ],
      ORG,
    )
    SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === YT_HOST)
    SandboxBridgeTestAccess.setFetch(ytFake)
  }, 180_000)

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("a signed Meta delivery with a Page DM and a feed comment lands a dm_message and a finding", async () => {
    const psid = `psid-${randomUUID().slice(0, 8)}`
    const mid = `m_${randomUUID()}`
    const commentId = `123_${Date.now()}`
    // Meta's own times, well before arrival: they must be what the rows carry.
    const sentAtMs = Date.UTC(2026, 0, 15, 9, 30, 0)
    const commentedAtSec = Math.floor(Date.UTC(2026, 0, 15, 8, 0, 0) / 1000)
    const body = {
      object: "page",
      entry: [
        {
          id: "page-1",
          time: Date.now(),
          messaging: [
            {
              sender: { id: psid },
              recipient: { id: "page-1" },
              timestamp: sentAtMs,
              message: { mid, text: "Is the Kestrel 6 in stock?" },
            },
          ],
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: commentId,
                post_id: "page-1_post-9",
                message: "Love this demo",
                from: { id: "fan-77", name: "Fan" },
                created_time: commentedAtSec,
              },
            },
          ],
        },
      ],
    }
    const res = await signedDelivery(body)
    expect(res.status, await res.clone().text()).toBe(200)

    // The fast-ack wrote nothing itself: it enqueued the parse, through the kernel's registry.
    const jobs = await parseJobsForOrg()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.data).toMatchObject({ platform: "facebook", body })
    await runParseJob(jobs[0]!.data)

    const findings = await sql<Array<Record<string, unknown>>>`
      SELECT platform, relation, parent_external_id, content_text, author_external_id,
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS occurred_utc
      FROM app_social.finding WHERE org_id = ${ORG} AND external_id = ${commentId}`
    expect([...findings]).toEqual([
      {
        platform: "facebook",
        relation: "comment_on_our_content",
        parent_external_id: "page-1_post-9",
        content_text: "Love this demo",
        author_external_id: "fan-77",
        occurred_utc: "2026-01-15T08:00:00",
      },
    ])
    const convs = await sql<Array<{ id: string; platform: string; last_inbound_at: Date | null }>>`
      SELECT id, platform, last_inbound_at FROM app_social.dm_conversation
      WHERE org_id = ${ORG} AND external_id = ${psid}`
    expect(convs).toHaveLength(1)
    expect(convs[0]!.platform).toBe("facebook")
    expect(convs[0]!.last_inbound_at).not.toBeNull()
    const msgs = await sql<Array<Record<string, unknown>>>`
      SELECT direction, body,
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS occurred_utc
      FROM app_social.dm_message
      WHERE org_id = ${ORG} AND conversation_id = ${convs[0]!.id} AND external_id = ${mid}`
    expect([...msgs]).toEqual([
      {
        direction: "inbound",
        body: "Is the Kestrel 6 in stock?",
        occurred_utc: "2026-01-15T09:30:00",
      },
    ])
  }, 120_000)

  it("a delivery with a bad signature is refused and enqueues nothing", async () => {
    const before = (await parseJobsForOrg()).length
    const res = await app.request(`/webhooks/${ORG}/social/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
      body: JSON.stringify({ object: "page", entry: [] }),
    })
    expect(res.status).toBe(401)
    expect((await parseJobsForOrg()).length).toBe(before)
  }, 60_000)

  it("a second reply on the same finding is refused while one is pending; a rejected reply records why", async () => {
    const findingId = randomUUID()
    await sql`INSERT INTO app_social.finding (id, org_id, platform, external_id, relation, content_text, author_handle, status)
      VALUES (${findingId}, ${ORG}, 'youtube', ${`vid-${findingId.slice(0, 8)}`}, 'keyword_match', 'Great synth', '@fan', 'triaged')`
    const stage = (text: string) =>
      executeToolCore({
        toolName: "social:reply_to_finding",
        orgId: ORG,
        actor,
        params: { finding_id: findingId, reply_text: text },
        threadId: THREAD,
        origin: "in-app-agent",
      })

    const first = await stage("Thanks!")
    expect("blocked" in first, JSON.stringify(first)).toBe(true)
    const second = await stage("Thanks again!")
    const code =
      "error" in second
        ? second.error.code
        : "data" in second
          ? ((second.data as { error?: { code?: string } })?.error?.code ?? "ran")
          : "blocked"
    expect(code).toBe("reply_already_pending")
    const approvals = await sql<Array<{ id: string; status: string }>>`
      SELECT id, status FROM kernel.approval_requests
      WHERE org_id = ${ORG} AND tool_name = 'social:reply_to_finding'
        AND current_payload->>'finding_id' = ${findingId}`
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!.status).toBe("pending")

    await decideApproval({
      orgId: ORG,
      requestId: approvals[0]!.id,
      actor: approver,
      decision: "approve",
    })
    expect(posts.filter((p) => p.url.includes("/commentThreads"))).toHaveLength(1)

    const [row] = await sql<Array<{ status: string; metadata: Record<string, any> }>>`
      SELECT status, metadata FROM app_social.finding WHERE id = ${findingId}`
    expect(row!.status).toBe("failed")
    expect(row!.metadata.last_reply_failure).toMatchObject({
      reason: "blocked",
      http_status: 403,
      approval_request_id: approvals[0]!.id,
    })
    expect(row!.metadata.last_reply_failure.provider_error).toContain("quotaExceeded")
    const exec = await sql<Array<{ result: Record<string, unknown> | null }>>`
      SELECT result FROM kernel.approved_handler_executions WHERE approval_request_id = ${approvals[0]!.id}`
    expect(JSON.stringify(exec.map((e) => e.result))).toContain("quotaExceeded")

    // Decided, the finding is free again: a deliberate retry can be staged (one at a time).
    const retry = await stage("Thanks, retry")
    expect("blocked" in retry, JSON.stringify(retry)).toBe(true)
  }, 180_000)
})
