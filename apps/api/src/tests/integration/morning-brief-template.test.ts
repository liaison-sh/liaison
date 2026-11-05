// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S28, A37, F1, F5, F7: the kernel "Morning brief" routine template.
//
// The template is registered with every org's kernel tools (so a new org has
// it too), enable_routine_template instantiates it as a personal routine at
// the chosen time in the owner's timezone, and a tick of the PRODUCTION
// `kernel:routine-tick` worker posts the brief into the owner's routine thread
// and calls notify_user, whose agent_notification goes through the outbox, the
// attention translator and the push router to APNs. Only the APNs socket is
// fake (it answers 200), so the proof is a DELIVERED (`accepted`) push row in
// the P1 delivery log for the owner.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db"
import type { PushHttpRequest, PushHttpResponse } from "~/modules/push/types"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Worker = (payload: unknown) => Promise<unknown>
const workers = new Map<string, Worker>()
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
// Snapshotted before the first mock.module call, so it is the real module.
const realTransport = await import("~/modules/push/transport")
const realTransportModule = { ...realTransport }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  registerJobWorker: (app: string, name: string, fn: Worker) => {
    workers.set(`${app}:${name}`, fn)
  },
  registerScheduledJob: async () => undefined,
  upsertJobScheduler: async () => undefined,
  removeScheduledJob: async () => undefined,
  removeAppJob: async () => undefined,
  enqueueAppJob: async () => "job-id",
}))

// mock.module outlives this file: put the real jobs module back so the stubs above
// never reach a later file in the same bun process (a later spyOn(Queue.prototype)
// would otherwise watch a queue the stub never touches).
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

// The APNs socket only: the request builder, the classifier and the delivery
// log are the production ones.
const apnsRequests: PushHttpRequest[] = []
mock.module("~/modules/push/transport", () => ({
  ...realTransportModule,
  FetchPushTransport: class {
    async request(req: PushHttpRequest): Promise<PushHttpResponse> {
      apnsRequests.push(req)
      return { status: 200, body: "" }
    }
  },
}))

const { registerKernelJobs } = await import("~/infra/jobs/kernel-jobs")
const { handleEnableRoutineTemplate, handleResetRoutineToTemplate } = await import(
  "~/modules/agent/tools/skills-routines-tools"
)
const { ensureAppsForOrg } = await import("~/modules/apps/init")
const { routineTemplateRegistry } = await import("~/modules/apps/app-registries")
const { initEventBus, resetEventBus } = await import("~/infra/events/event-bus")
const { DurableConsumersTestAccess } = await import("~/infra/events/durable-consumers")
const { registerEventSubscribers } = await import("~/infra/events/event-subscribers")
const { registerTranslatorConsumer } = await import("~/modules/attention/translator")
const { processOutboxBatch } = await import("~/infra/events/outbox-worker")
const { PushSenderTestAccess } = await import("~/modules/push/sender")
const { PushFanoutTestAccess } = await import("~/modules/push/fanout-consumer")
const { env } = await import("~/lib/env")

const ORG = randomUUID()
const OWNER = randomUUID()
const tag = ORG.slice(0, 8)
const MODEL_ID = "claude-p5t3-morning-brief"
const SUMMARY = "Morning brief: 2 new emails, 1 draft to approve, 1 task due."
const BRIEF = "Good morning. Overnight: 2 emails. Waiting for you: 1 draft. Due today: 1 task."

const APNS_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUb0uv3OqGawflNEa
44vN6HM1BtQeigQswWPnFyTwxcOhRANCAARgaihBMqP+jkRZDO9khtNjkb5STk7t
RCt9BYmiMv1q1T/yrylSx0lHCBHES+dGySDgmAV+LhW060oAsKZyvtnX
-----END PRIVATE KEY-----`
const savedApns = {
  APNS_KEY_PATH: env.APNS_KEY_PATH,
  APNS_KEY_ID: env.APNS_KEY_ID,
  APNS_TEAM_ID: env.APNS_TEAM_ID,
  APNS_BUNDLE_ID: env.APNS_BUNDLE_ID,
}

const ctx = {
  orgId: ORG,
  userId: OWNER,
  actorType: "user",
  scopes: ["*"],
  approverUserId: OWNER,
} as never

function sse(events: Array<[string, unknown]>): Response {
  return new Response(
    events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

let n = 0
function step(
  block: { type: "text"; text: string } | { type: "tool"; name: string; input: unknown },
): Response {
  const id = ++n
  const body: Array<[string, unknown]> =
    block.type === "tool"
      ? [
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: `toolu_${id}`, name: block.name, input: {} },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            },
          ],
        ]
      : [
          [
            "content_block_start",
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: block.text },
            },
          ],
        ]
  return sse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${id}`,
          type: "message",
          role: "assistant",
          model: MODEL_ID,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    ],
    ...body,
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: block.type === "tool" ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 20 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ])
}

let firstPrompt = ""
const realFetch = globalThis.fetch
const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function hasToolResult(body: { messages?: Array<{ content?: unknown }> }): boolean {
  return (body.messages ?? []).some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some((c) => c.type === "tool_result"),
  )
}

async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const processed = await processOutboxBatch()
    if (!processed) break
  }
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Brief Org', ${`p5t3-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, timezone)
    VALUES (${OWNER}, ${ORG}, ${`p5t3-${tag}@t.com`}, 'Elodie', 'active', 'hash', 'Europe/Paris')`
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${OWNER}, ${ORG}, '*')`
  await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
    VALUES (${ORG}, '10.00000000', '0', 'EUR')`
  // Auto-eligible: the tick's credit gate and the turn resolve the org's auto model.
  await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
    VALUES ('anthropic', ${MODEL_ID}, 'Brief test', '1.00', '5.00', 200000, true, 'starter') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token, environment)
    VALUES (${ORG}, ${OWNER}, 'ios', ${`p5t3-token-${tag}`}, 'production')`

  const keyPath = join(tmpdir(), `p5t3-apns-${tag}.p8`)
  writeFileSync(keyPath, APNS_P8)
  Object.assign(env, {
    APNS_KEY_PATH: keyPath,
    APNS_KEY_ID: "ABC1234567",
    APNS_TEAM_ID: "TEAM123456",
    APNS_BUNDLE_ID: "com.liaison.app",
  })
  PushSenderTestAccess.resetDisabledNotice()
  PushFanoutTestAccess.resetDedupe()

  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
  } as never)
  registerTranslatorConsumer()

  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-p5t3-stub"
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("api.anthropic.com")) return realFetch(input as never, init)
    const body = JSON.parse(String(init?.body ?? "{}"))
    const system = JSON.stringify(body.system ?? "")
    // The owner's personal agent is named after them ("Elodie's agent").
    if (!Array.isArray(body.tools) || !system.includes("You are Elodie's agent (")) {
      return step({ type: "text", text: "side call" })
    }
    if (!hasToolResult(body)) {
      firstPrompt = JSON.stringify(body.messages ?? [])
      return step({ type: "tool", name: "kernel__notify_user", input: { summary: SUMMARY } })
    }
    return step({ type: "text", text: BRIEF })
  }) as typeof fetch

  await ensureAppsForOrg(ORG)
  await registerKernelJobs()
}, 180_000)

afterAll(async () => {
  globalThis.fetch = realFetch
  if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  Object.assign(env, savedApns)
  PushSenderTestAccess.resetDisabledNotice()
  for (const t of [
    "kernel.notification_deliveries",
    "kernel.attention_items",
    "kernel.routine_runs",
    "kernel.messages",
    "kernel.thread_participants",
    "kernel.user_thread_state",
    "kernel.credit_transactions",
    "kernel.pending_events",
    "kernel.audit_log",
    "kernel.push_tokens",
  ]) {
    await sql.unsafe(`DELETE FROM ${t} WHERE org_id = '${ORG}'`).catch(() => undefined)
  }
  await sql`UPDATE kernel.routines SET output_thread_id = NULL WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
  resetEventBus()
  await releaseTestLock()
})

describe("the kernel Morning brief template (S28)", () => {
  let routineId = ""

  test("a new org has the template, and enabling it creates a personal routine at the chosen time", async () => {
    expect(routineTemplateRegistry.get([ORG, "kernel", "morning-brief"])).toBeDefined()
    const res = (await handleEnableRoutineTemplate(
      { appName: "kernel", templateKey: "morning-brief", time: "07:30" },
      ctx,
    )) as { routine?: Record<string, unknown>; error?: unknown }
    expect(res.error).toBeUndefined()
    const r = res.routine!
    routineId = r.id as string
    expect(r).toMatchObject({
      kind: "recurring",
      cron: "30 7 * * 1-5",
      timezone: "Europe/Paris",
      visibility: "personal",
      sourceKind: "kernel",
      appName: null,
      templateKey: "morning-brief",
      ownerUserId: OWNER,
    })
    expect(String(r.prompt)).toContain("kernel__notify_user")
    expect(r.scopes).toEqual(expect.arrayContaining(["kernel:agent:memory"]))

    // Enabling twice is refused, and a reset keeps the chosen time.
    const again = (await handleEnableRoutineTemplate(
      { appName: "kernel", templateKey: "morning-brief" },
      ctx,
    )) as { error?: { code: string } }
    expect(again.error?.code).toBe("already_enabled")
    await sql`UPDATE kernel.routines SET prompt = 'edited' WHERE id = ${routineId}`
    const reset = (await handleResetRoutineToTemplate({ id: routineId }, ctx)) as {
      routine?: Record<string, unknown>
      error?: unknown
    }
    expect(reset.error).toBeUndefined()
    expect(reset.routine).toMatchObject({ cron: "30 7 * * 1-5", timezone: "Europe/Paris" })
    expect(String(reset.routine!.prompt)).toContain("kernel__notify_user")
  })

  test("a tick posts the brief into the owner's thread and the owner gets a delivered push", async () => {
    const tick = workers.get("kernel:routine-tick")
    expect(tick).toBeDefined()
    await tick!({ routineId, orgId: ORG, scheduledAt: new Date().toISOString() })

    const [run] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.routine_runs WHERE routine_id = ${routineId}
      ORDER BY ran_at DESC LIMIT 1`
    expect(run?.status).toBe("succeeded")
    expect(firstPrompt).toContain("notify_user")

    const [r] = await sql<{ output_thread_id: string }[]>`
      SELECT output_thread_id FROM kernel.routines WHERE id = ${routineId}`
    const seats = await sql<{ user_id: string | null }[]>`
      SELECT user_id FROM kernel.thread_participants
       WHERE thread_id = ${r.output_thread_id} AND user_id IS NOT NULL`
    expect(seats.map((s) => s.user_id)).toEqual([OWNER])
    const [post] = await sql<{ content: string }[]>`
      SELECT content FROM kernel.messages
       WHERE thread_id = ${r.output_thread_id} AND author_type = 'agent'
       ORDER BY created_at DESC LIMIT 1`
    expect(post?.content).toContain(BRIEF)

    await drainOutbox()
    const pushes = await sql<{ result: string; provider_status: number | null }[]>`
      SELECT result, provider_status FROM kernel.notification_deliveries
       WHERE org_id = ${ORG} AND user_id = ${OWNER} AND channel = 'push'`
    expect(pushes).toContainEqual({ result: "accepted", provider_status: 200 })
    // The tick's turn is tainted by the routine's whole scope (scope-taint.ts rule 6d), so
    // the push is the D14 redacted one: delivered, with no text derived from the brief.
    expect(apnsRequests.length).toBeGreaterThan(0)
    for (const q of apnsRequests) {
      const wire = String(q.body ?? "")
      expect(wire).not.toContain("Morning brief")
      expect(wire).not.toContain("emails")
      expect(wire).not.toContain(BRIEF)
    }
    expect(apnsRequests.some((q) => String(q.body ?? "").includes("New notification"))).toBe(true)
    // In-app display is unchanged: the owner's attention row keeps the summary.
    const [item] = await sql<{ summary: string }[]>`
      SELECT summary FROM kernel.attention_events
       WHERE org_id = ${ORG} AND user_id = ${OWNER} AND kind = 'agent_notification'`
    expect(item?.summary).toBe(SUMMARY)
  }, 120_000)
})
