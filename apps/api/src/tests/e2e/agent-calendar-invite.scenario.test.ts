// SPDX-License-Identifier: FSL-1.1-ALv2
// Agent + Calendar invitations: a true agent E2E (real model, Auto mode; executeTool, the
// core app runner, the calendar bridge and the approval queue). An agent asked to send an
// invitation, or to delete an event, parks the call behind a human approval: no event row and
// nothing for Google until a person approves; then the write runs with sendUpdates=all.
import { afterAll, beforeAll, expect, it } from "bun:test"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { createUserWithScopes } from "@liaison/test-helpers"
import { describeLive } from "./helpers/live-llm"
import { setupScenario, teardownScenario } from "./setup"

interface SseEvent {
  event: string
  data: unknown
}

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const block of body.split("\n\n").filter((b) => b.trim())) {
    let event = "message"
    let dataStr = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim()
      else if (line.startsWith("data: ")) dataStr = line.slice(6).trim()
    }
    try {
      events.push({ event, data: JSON.parse(dataStr) })
    } catch {
      events.push({ event, data: dataStr })
    }
  }
  return events
}

async function consumeSse(
  url: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: SseEvent[]; rawBody: string }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const rawBody = await res.text()
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return {
      status: res.status,
      events: [{ event: "error", data: { code: "http_error", body: rawBody } }],
      rawBody,
    }
  }
  return { status: res.status, events: parseSseEvents(rawBody), rawBody }
}

async function seedAgentThread(
  sql: WorkerEnv["db"]["sql"],
  ks: string,
  orgId: string,
  userId: string,
): Promise<string> {
  const threadId = crypto.randomUUID()
  await sql.unsafe(
    `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
    [threadId, orgId, `agent-${threadId.slice(0, 8)}`, userId],
  )
  await sql.unsafe(
    `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
    [threadId, userId, orgId],
  )
  return threadId
}

// NOTE: the calendar app's manifest only ever gates TOOLS on `calendar:events:*` (see
// app.manifest.json's `tools` block) — no tool grants `calendar:calendars:*` /
// `calendar:accounts:*`, yet the auto-generated RLS policies on the `calendars` and `accounts`
// TABLES themselves default their scope-check to the entity (table) name, i.e. they require
// `calendar:calendars:read` / `calendar:accounts:read` independently of the tool-level scope
// gate. A "member" role holding only the manifest's own declared scopes therefore cannot
// actually see rows via `list_calendars`/`list_accounts` — this looks like a pre-existing
// product gap (out of scope for this task to fix), so the test grants the broader scope set a
// working calendar member would need to exercise the same read path the agent uses.
const CALENDAR_SCOPES = [
  "calendar:events:read",
  "calendar:events:write",
  "calendar:calendars:read",
  "calendar:accounts:read",
  "kernel:contacts:read",
  "kernel:threads:read",
  "kernel:threads:write",
]

// Auto-mode → cheapest auto-eligible (gemini-flash-lite). Never hardcode
// Anthropic in E2E — project policy + `apps/web/src/tests/e2e/CLAUDE.md`.
const TOOL_MODEL: string | null = null

function isProviderUnavailable(events: SseEvent[]): boolean {
  const err = events.find((e) => e.event === "error")
  if (!err) return false
  const code = (err.data as { code?: string } | null)?.code
  return code === "provider_error" || code === "transport_error" || code === "http_error"
}

/** Next Tuesday 10:00–11:00 UTC relative to `now` — matches how a real user's "next Tuesday"
 * prompt would resolve, giving the agent (and our post-hoc window assertion) a concrete,
 * unambiguous target regardless of what day the suite runs on. */
function nextTuesdayWindow(now: Date): { start: Date; end: Date } {
  const day = now.getUTCDay() // 0=Sun..6=Sat
  const daysUntilTuesday = (2 - day + 7) % 7 || 7 // always strictly in the future
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntilTuesday,
      10,
      0,
      0,
    ),
  )
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  return { start, end }
}

// Drives a real model provider: live only (LIAISON_E2E_LIVE_LLM=1, helpers/live-llm.ts).
describeLive("Agent + Calendar invitations (gated) Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let cs: string
  let agentUser: { id: string; email: string; token: string; name: string }
  let orgCalendarId: string

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 21,
      org: { name: "Agent Calendar Invitations E2E Org" },
      populate: { users: { count: 3 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    cs = env.schemaPrefix ? `"${env.schemaPrefix}app_calendar"` : "app_calendar"

    // Model pricing + credit balance (agent runtime needs both).
    for (const model of MODEL_PRICING_SEED) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (provider, model_id) DO NOTHING`,
        [
          model.provider,
          model.modelId,
          model.displayName,
          model.inputCostPerM,
          model.outputCostPerM,
          model.contextWindow,
          model.autoEligible,
          model.tierMinimum,
          model.source,
        ],
      )
    }
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.credit_balances (org_id, included_balance, purchased_balance, currency)
       VALUES ($1, '50.00000000', '50.00000000', 'EUR')
       ON CONFLICT (org_id) DO UPDATE SET included_balance = '50.00000000', purchased_balance = '50.00000000'`,
      [world.org.id],
    )

    // Grant the union of calendar:* scopes PLUS the wildcard membership dimension, mirroring
    // every other scenario test's pattern (dimensions: { "*": ["*"] } satisfies calendar's
    // `calendar:calaccess` RLS dimension the same generic way it satisfies tickets/mail's).
    agentUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: CALENDAR_SCOPES,
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // --- Seed an org-wide connected Google Calendar account + one selected calendar. ---
    // Google is mocked only at the fetch seam boundary: we never call the real Google API in
    // this test, we seed the rows directly at the shape `onAccountConnected` +
    // `runCalendarImport` + `applyInitialSyncPages` would have produced (same seam
    // apps/api/src/apps/calendar/calendar-e2e.test.ts documents), since the scenario spawns the
    // server as a separate process against schema-prefixed worker schemas that this test file's
    // own in-process DB imports cannot reach.
    const accountId = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${cs}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, email_address, display_name, sync_status)
       VALUES ($1, $2, $3, 'org', NULL, $4, 'Org Calendar', 'active')`,
      [accountId, world.org.id, crypto.randomUUID(), "org-calendar@agentqa.test"],
    )
    orgCalendarId = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${cs}.calendars
        (id, org_id, account_id, google_calendar_id, name, selected, calaccess)
       VALUES ($1, $2, $3, 'gcal-org-primary', 'Org Calendar', true, $4)`,
      [orgCalendarId, world.org.id, accountId, accountId],
    )

    // --- C-level contacts (identifiable by title) the "whole C-level team" prompt resolves against. ---
    const cLevel = [
      { name: "Priya Shah", email: "priya.shah@agentqa.test", title: "CEO" },
      { name: "Marcus Webb", email: "marcus.webb@agentqa.test", title: "CTO" },
      { name: "Elena Ruiz", email: "elena.ruiz@agentqa.test", title: "CFO" },
    ]
    for (const person of cLevel) {
      const id = crypto.randomUUID()
      // `contacts` has no dedicated title column — the seed encodes the C-level identity in
      // `name` (as a real directory entry would show it) and `metadata.title`/`tags` so the
      // agent can resolve "the whole C-level team" from what `contacts` tools surface.
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.contacts (id, org_id, handle, name, email, company, metadata, tags, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, now(), now())`,
        [
          id,
          world.org.id,
          `c-${id.slice(0, 8)}`,
          `${person.name} (${person.title})`,
          person.email,
          "Agent QA Org — Executive Team",
          JSON.stringify({ title: person.title, level: "c-level" }),
          ["c-level", person.title.toLowerCase()],
          agentUser.id,
        ],
      )
    }

    // Poll the calendar__list_calendars tool endpoint (the same read path the agent will use)
    // until the seeded org calendar is visible. Raw-SQL seeding lands in the same Postgres
    // instance the server's pool reads from, so this is not expected to lag — but a shared,
    // heavily-loaded dev box (per project memory: DB pool / RLS materialization) can make the
    // very first read after a fresh org's app registration flaky. Poll rather than assume.
    const deadline = Date.now() + 3_000
    let visible = false
    while (Date.now() < deadline) {
      const res = await fetch(`${url}/api/apps/calendar/tools/list_calendars`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentUser.token}` },
        body: JSON.stringify({ params: {} }),
      })
      const body = (await res.json()) as { data?: Array<{ id: string }>; error?: unknown }
      if (res.ok && (body.data ?? []).some((cal) => cal.id === orgCalendarId)) {
        visible = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!visible) {
      throw new Error(
        `calendar__list_calendars never surfaced the seeded org calendar ${orgCalendarId} within 20s`,
      )
    }
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${world.admin.token}`,
        ...(init.headers ?? {}),
      },
    })
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as { data?: { payloadHash?: string } },
    }
  }

  async function pendingApprovals(toolPattern: string): Promise<Array<{ id: string }>> {
    return (await env.db.sql.unsafe(
      `SELECT id FROM ${ks}.approval_requests
       WHERE org_id = $1 AND status = 'pending' AND tool_name LIKE $2
       ORDER BY created_at DESC`,
      [world.org.id, toolPattern],
    )) as unknown as Array<{ id: string }>
  }

  async function approve(approvalId: string) {
    const shown = await api(`/api/approvals/${approvalId}`)
    const payloadHash = shown.body.data?.payloadHash
    const decided = await api(`/api/approvals/${approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", payloadHash }),
    })
    expect(decided.status).toBe(200)
  }

  async function eventRows(titlePattern: string) {
    return (await env.db.sql.unsafe(
      `SELECT id, title, attendees, send_updates, deleted_at, pending_push
       FROM ${cs}.events WHERE org_id = $1 AND calendar_id = $2 AND title ILIKE $3`,
      [world.org.id, orgCalendarId, titlePattern],
    )) as unknown as Array<{
      id: string
      title: string
      attendees: unknown
      send_updates: string | null
      deleted_at: string | null
      pending_push: string
    }>
  }

  it("S2: an agent's invitation waits for approval, then goes out with sendUpdates=all", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
    const { start } = nextTuesdayWindow(new Date())
    const day = start.toISOString().slice(0, 10)
    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: [
        `Invite Priya Shah (priya.shah@agentqa.test) to a meeting "Partner kickoff" on ${day} from 15:00 to 16:00 UTC on the org calendar, with a Google Meet, and send her the invitation.`,
        `Today is ${new Date().toISOString().slice(0, 10)}.`,
      ].join("\n"),
      modelId: TOOL_MODEL,
    })
    if (isProviderUnavailable(events)) {
      console.log("agent-calendar-invite: provider unavailable, skipping")
      return
    }
    expect(status).toBe(200)
    const calls = events.filter(
      (e) =>
        e.event === "tool-call" &&
        /calendar__create_event/.test((e.data as { toolName?: string }).toolName ?? ""),
    )
    expect(calls.length).toBeGreaterThanOrEqual(1)

    // Parked: an approval waits and no event exists yet, so nothing can reach Google.
    const pending = await pendingApprovals("%create_event")
    expect(pending.length).toBe(1)
    expect(await eventRows("%Partner kickoff%")).toEqual([])

    await approve(pending[0]!.id)
    let rows: Awaited<ReturnType<typeof eventRows>> = []
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      rows = await eventRows("%Partner kickoff%")
      if (rows.length === 0) await Bun.sleep(250)
    }
    expect(rows).toHaveLength(1)
    // The push to Google carries the notify choice until Google answers (no Google here).
    expect(rows[0]!.send_updates).toBe("all")
    const emails = ((Array.isArray(rows[0]!.attendees) ? rows[0]!.attendees : []) as unknown[]).map(
      (a) => String(typeof a === "string" ? a : (a as { email?: string }).email).toLowerCase(),
    )
    expect(emails).toContain("priya.shah@agentqa.test")
  }, 240_000)

  it("S3: an agent's delete waits for approval", async () => {
    const created = await fetch(`${url}/api/apps/calendar/tools/create_event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentUser.token}` },
      body: JSON.stringify({
        params: {
          calendarId: orgCalendarId,
          title: "Old standup",
          start: "2027-01-05T09:00:00.000Z",
          end: "2027-01-05T09:15:00.000Z",
        },
      }),
    })
    expect(created.ok).toBe(true)
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content:
        'Delete the event "Old standup" on 2027-01-05 from the org calendar. Find it with calendar__search_events first.',
      modelId: TOOL_MODEL,
    })
    if (isProviderUnavailable(events)) return
    const pending = await pendingApprovals("%delete_event")
    expect(pending.length).toBe(1)
    const before = await eventRows("Old standup")
    expect(before).toHaveLength(1)
    expect(before[0]!.deleted_at).toBeNull()

    await approve(pending[0]!.id)
    let gone = false
    for (let i = 0; i < 40 && !gone; i++) {
      const rows = await eventRows("Old standup")
      gone = rows.length === 0 || rows[0]!.deleted_at !== null
      if (!gone) await Bun.sleep(250)
    }
    expect(gone).toBe(true)
  }, 240_000)
})
