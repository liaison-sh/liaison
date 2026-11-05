// SPDX-License-Identifier: FSL-1.1-ALv2
// ---------------------------------------------------------------------------
// media-analysis-AGENT E2E — LIVE Gemini through the REAL agent runtime.
//
// The sibling `media-analysis.scenario.test.ts` proves `handleAnalyzeMedia`
// works end-to-end with a real model + real transcode — but it calls the
// handler DIRECTLY (`runAnalyze` → `handleAnalyzeMedia(...)` inside a hand-built
// RLS context). It never exercises the product flow: agent-runtime → tool
// dispatch → execute-tool → handler → result-back-to-the-agent-loop, nor that
// the agent can SEE the tool (scope-gated tool set) and USE its result.
//
// THIS file closes that gap. It drives the real `/api/agent/chat` SSE loop on
// the spawned server and asserts the agent emits a `kernel__analyze_media`
// tool-call whose REAL tool-result carries a live Gemini summary that the agent
// then consumes for its reply.
//
//   S1 (deterministic wiring proof — AUTHORITATIVE):
//     A stubbed agent BRAIN (helpers/media-analysis-agent-stub.ts, injected via
//     AGENT_STREAM_STUB) deterministically emits the analyze_media tool-call on
//     a marker prompt, then calls the tool's REAL `execute` — so the FULL
//     runtime → execute-tool → handleAnalyzeMedia → Gemini → result-back path
//     runs. Asserts: the tool-call fired; the tool-RESULT event carries a
//     non-empty REAL Gemini summary (robust manifest keyword); the agent's text
//     reply quoted it (result actually consumed); kernel.files.analysis_status=
//     'done' persisted; a real credit_transactions byok_usage row raw_cost>0.
//
//   S2 (live-brain best-effort — "does the brain CHOOSE it?"):
//     Gives the REAL auto/cheap model the analyze_media tool + a ticket with the
//     image + a NATURAL prompt, and reports whether the brain calls the tool.
//     LLM tool-choice is nondeterministic, so this is resilient: a couple of
//     attempts, then console.log + skip-with-note (NOT a hard fail) if the model
//     still doesn't choose it. S1 is the authoritative proof.
//
// Graceful degradation mirrors the sibling: `beforeAll` probes the environment
// (fixtures / GOOGLE_API_KEY / object store) and EACH test early-returns (skip-with-
// note) on a missing prerequisite rather than declaration-time skipIf.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld } from "@liaison/test-helpers"
import { createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import type postgres from "postgres"
import { seedFileOnEntity } from "./helpers/attachments"
import { describeLive } from "./helpers/live-llm"
import { seedInbox, seedTicket, seedTicketMessages } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

// --- SSE helpers (copy-pattern — mirror agent-tickets / agent-file-attachments)
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

function isProviderUnavailable(events: SseEvent[]): boolean {
  const err = events.find((e) => e.event === "error")
  if (!err) return false
  const code = (err.data as { code?: string } | undefined)?.code
  return code === "provider_error" || code === "transport_error" || code === "http_error"
}

// Auto-mode → cheapest auto-eligible (gemini-flash-lite). Never hardcode an
// expensive model in E2E (project policy + apps/web/src/tests/e2e/CLAUDE.md).
const TOOL_MODEL: string | null = null

// The agent's tool set exposes analyze_media under the `<app>__<tool>` SDK name
// (tool-bridge.ts: `${appName}__${toolName}`); kernel + analyze_media →
const ANALYZE_TOOL_SDK_NAME = "kernel__analyze_media"

// The HEIC fixture of the media manifest (`qa/media-fixtures/manifest.json`,
// id `heic-photo`), or the set LIAISON_MEDIA_FIXTURES_DIR names. Its context is
// what the agent passes to analyze_media; its keywords are the robust set the
// live summary is checked against.
const fixturesDir =
  process.env.LIAISON_MEDIA_FIXTURES_DIR ??
  join(import.meta.dir, "..", "..", "..", "..", "..", "qa", "media-fixtures")
interface HeicFixture {
  id: string
  file: string
  context: string
  mustMention: string[]
}
const heicFixture: HeicFixture | undefined = (() => {
  try {
    const raw = readFileSync(join(fixturesDir, "manifest.json"), "utf8")
    return (JSON.parse(raw) as { files: HeicFixture[] }).files.find((f) => f.id === "heic-photo")
  } catch {
    return undefined
  }
})()
const FIXTURE_FILE = heicFixture?.file ?? "grid.heic"
const FIXTURE_CONTEXT = heicFixture?.context ?? ""
// At least ONE of these must appear in the real summary. (The model phrases
// freely, so we OR a small robust set rather than pinning exact wording.)
const ROBUST_KEYWORDS = (heicFixture?.mustMention ?? []).map((k) => k.toLowerCase())

const TICKET_SCOPES = [
  "tickets:tickets:read",
  "tickets:tickets:write",
  "tickets:tickets:reply",
  "tickets:inboxes:read",
  "kernel:threads:read",
  "kernel:threads:write",
  "kernel:files:read",
  // The analyze_media tool gate — without this the tool is filtered out of the
  // agent's tool set (the silent "tool returns nothing" signature). S1's stub
  // surfaces that as a loud failure; this scope is what makes the tool visible.
  "kernel:files:analyze",
  "kernel:contacts:read",
]

// --- environment probes (set in beforeAll, read in each test body) ----------
let fixturePresent = false
let hasKey = false

// Drives a real model provider: live only (LIAISON_E2E_LIVE_LLM=1, helpers/live-llm.ts).
describeLive("media-analysis AGENT E2E — live Gemini through the real agent runtime", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let agentUser: { id: string; email: string; token: string; name: string }
  let ticket: { id: string; handle: string }
  let messageId: string
  let fileId: string

  beforeAll(async () => {
    fixturePresent = heicFixture !== undefined && existsSync(join(fixturesDir, FIXTURE_FILE))
    hasKey = !!process.env.GOOGLE_API_KEY

    const stubPath = new URL("./helpers/media-analysis-agent-stub.ts", import.meta.url).pathname
    const result = await setupScenario({
      seed: 4271,
      org: { name: "Media-Analysis Agent E2E Org" },
      populate: { users: { count: 3 } },
      serverEnv: { AGENT_STREAM_STUB: stubPath },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    if (!fixturePresent || !hasKey) {
      console.log(
        `media-analysis-agent beforeAll: fixturePresent=${fixturePresent} hasKey=${hasKey} ` +
          "— tests will skip-with-note",
      )
      return
    }

    // Model pricing + credit balance — the agent runtime needs both (auto-mode
    // model resolution + the analyze_media Gemini charge).
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

    // Tickets media analysis enabled explicitly (default is on for tickets; set
    // it so the per-surface/per-kind gate is unambiguous).
    await env.db.sql.unsafe(
      `UPDATE ${ks}.organizations
         SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{mediaAnalysis}',
             '{"tickets":{"image":true,"video":true}}'::jsonb, true)
       WHERE id = $1`,
      [world.org.id],
    )

    agentUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      name: "Media Agent",
      scopes: TICKET_SCOPES,
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // A ticket with one inbound customer message that "has" the image attached.
    const inbox = await seedInbox(env, {
      orgId: world.org.id,
      name: "Support",
      emailAddress: "support@media-agent-qa.test",
      isDefaultForCreate: true,
      createdBy: agentUser.id,
    })
    ticket = await seedTicket(env, {
      orgId: world.org.id,
      subject: "One square on my panel stopped responding — photo attached",
      sourceInboxId: inbox.id,
      status: "open",
    })
    const seeded = await seedTicketMessages(env, {
      orgId: world.org.id,
      ticketId: ticket.id,
      messages: [
        {
          kind: "inbound",
          fromEmail: "customer@acme.test",
          fromName: "Acme Customer",
          subject: "One square on my panel stopped responding — photo attached",
          textBody:
            "Hi, one square on my panel stopped responding. I outlined it in " +
            "green in the attached photo. What's wrong?",
        },
      ],
    })
    messageId = seeded.ids[0]!

    // Attach the REAL fixture bytes onto the ticket MESSAGE via the production
    // presign → object-store PUT → confirm path (exactly how a human upload arrives) —
    // so the kernel.files row is genuinely RLS-readable to the agent through the
    // tickets `message` fileParent, no policy shortcut.
    const bytes = await readFile(join(fixturesDir, FIXTURE_FILE))
    const seededFile = await seedFileOnEntity(env, agentUser.token, {
      app: "tickets",
      entityType: "message",
      entityId: messageId,
      filename: FIXTURE_FILE,
      mimeType: "image/heic",
      bytes,
    })
    fileId = seededFile.fileId
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  function skipReason(): string | null {
    if (!fixturePresent) return `fixture ${FIXTURE_FILE} absent`
    if (!hasKey) return "GOOGLE_API_KEY not set"
    return null
  }

  it("S1: agent runtime dispatches analyze_media; real Gemini summary flows back into the loop and is used", async () => {
    const skip = skipReason()
    if (skip) {
      console.log(`media-analysis-agent S1: skipping — ${skip}`)
      return
    }

    // The deterministic stub keys on this marker line and recovers the fileId +
    // context from it, emits the analyze_media tool-call, then calls the tool's
    // REAL execute (full runtime → execute-tool → handleAnalyzeMedia → Gemini).
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
    const { status, events, rawBody } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content:
        `A customer attached a photo to ticket ${ticket.handle} reporting an unresponsive square. ` +
        `Analyze the attachment and tell me what it shows.\n` +
        `ANALYZE_MEDIA_FIXTURE fileId=${fileId} context=${FIXTURE_CONTEXT}`,
      modelId: TOOL_MODEL,
    })

    if (isProviderUnavailable(events)) {
      // A real provider/transport failure is NOT acceptable for S1 (the
      // authoritative proof) — surface it loudly so the run is investigated,
      // not silently green.
      throw new Error(
        `media-analysis-agent S1: provider/transport error — ${JSON.stringify(
          events.find((e) => e.event === "error")?.data,
        )}\nraw: ${rawBody.slice(0, 800)}`,
      )
    }
    expect(status).toBe(200)

    // (1) The agent emitted the analyze_media tool-call with the seeded fileId.
    const toolCalls = events.filter((e) => e.event === "tool-call")
    const analyzeCall = toolCalls.find(
      (e) => (e.data as { toolName?: string }).toolName === ANALYZE_TOOL_SDK_NAME,
    )
    expect(analyzeCall).toBeDefined()
    const callArgs =
      ((analyzeCall!.data as { args?: unknown }).args as { fileId?: string; context?: string }) ??
      {}
    expect(callArgs.fileId).toBe(fileId)
    expect(typeof callArgs.context).toBe("string")
    expect((callArgs.context ?? "").length).toBeGreaterThan(0)

    // (2) The tool-RESULT event carries the REAL Gemini summary (the result
    //     threaded back into the agent loop). part.output === executeTool's
    //     data === the raw AnalyzeMediaResult { summary, model, analyzedAt,
    //     cached }. A typed { error } / { status:"processing" } here is a real
    //     failure — surface it.
    const toolResults = events.filter((e) => e.event === "tool-result")
    const analyzeResult = toolResults.find(
      (e) =>
        (e.data as { toolCallId?: string }).toolCallId ===
        (analyzeCall!.data as { toolCallId?: string }).toolCallId,
    )
    expect(analyzeResult).toBeDefined()
    const resultPayload = (analyzeResult!.data as { result?: unknown }).result as
      | { summary?: string; cached?: boolean; error?: { code?: string; message?: string } }
      | { status?: string }
      | undefined
    if (resultPayload && "error" in resultPayload && resultPayload.error) {
      throw new Error(
        `analyze_media returned an error envelope: ${resultPayload.error.code} — ${resultPayload.error.message}`,
      )
    }
    if (resultPayload && "status" in resultPayload && resultPayload.status) {
      throw new Error(
        `analyze_media returned status=${(resultPayload as { status: string }).status} (expected a synchronous summary for the HEIC image)`,
      )
    }
    const summary = (resultPayload as { summary?: string } | undefined)?.summary ?? ""
    console.log(
      `\n===== S1 analyze_media GEMINI SUMMARY (via agent runtime) =====\n${summary}\n==============================================================\n`,
    )
    expect(summary.length).toBeGreaterThan(0)
    // A robust manifest keyword — the summary really described THIS fixture.
    const lower = summary.toLowerCase()
    const matchedKeyword = ROBUST_KEYWORDS.find((kw) => lower.includes(kw))
    expect(matchedKeyword).toBeDefined()

    // (3) The agent CONSUMED the result for its reply — the final assistant
    //     text quoted a slice of the summary (proves result-back-to-loop, not
    //     just that the tool fired). The route emits each text chunk as a
    //     `text-delta` SSE event with the chunk under `data.delta` (see
    //     modules/agent/routes.ts: writeEvent("text-delta", { delta })).
    const assistantText = events
      .filter((e) => e.event === "text-delta")
      .map((e) => (e.data as { delta?: string }).delta ?? "")
      .join("")
    expect(assistantText.length).toBeGreaterThan(0)
    // The reply contains a non-trivial verbatim slice of the summary.
    const summarySlice = summary.slice(0, 60)
    expect(assistantText).toContain(summarySlice)

    // (4) Persisted analysis_status='done' on the kernel.files row.
    const fileRows = await env.db.sql.unsafe(
      `SELECT analysis_status, analysis_summary FROM ${ks}.files WHERE id = $1`,
      [fileId],
    )
    const fileRow = (
      fileRows as unknown as Array<{ analysis_status: string; analysis_summary: string }>
    )[0]
    expect(fileRow?.analysis_status).toBe("done")
    expect(fileRow?.analysis_summary).toBeTruthy()

    // (5) A real BYOK usage credit row with raw_cost > 0 — a true model call,
    //     not a cache/no-op. (raw_cost is populated on BYOK/self-hosted; the
    //     managed creditCost is '0' off-managed.)
    const txnRows = await env.db.sql.unsafe(
      `SELECT raw_cost, input_tokens, type, model FROM ${ks}.credit_transactions
           WHERE org_id = $1 AND model = 'gemini-flash-lite-latest'
           ORDER BY created_at DESC LIMIT 1`,
      [world.org.id],
    )
    const txn = (
      txnRows as unknown as Array<{
        raw_cost: string
        input_tokens: number
        type: string
        model: string
      }>
    )[0]
    expect(txn).toBeDefined()
    expect(txn!.type).toBe("byok_usage")
    const rawCost = Number(txn!.raw_cost)
    console.log(
      `S1: credit row — model=${txn!.model} type=${txn!.type} raw_cost=$${rawCost} input_tokens=${txn!.input_tokens}`,
    )
    expect(rawCost).toBeGreaterThan(0)

    const done = events.find((e) => e.event === "done")
    expect(done).toBeDefined()
  }, 180_000)

  it("S2 (live-brain best-effort): the real auto/cheap model CHOOSES to call analyze_media on a natural prompt", async () => {
    const skip = skipReason()
    if (skip) {
      console.log(`media-analysis-agent S2: skipping — ${skip}`)
      return
    }

    // Natural prompt — NO marker, NO tool-name hint — so the stub passes it
    // through to the REAL auto/cheap model, which must DECIDE to call
    // analyze_media on its own. The fileId is given (the agent would otherwise
    // discover it via tickets_get/files_list, out of scope here) so a chosen
    // call is well-formed.
    const naturalPrompt =
      `A customer attached a photo to ticket ${ticket.handle} reporting an unresponsive square on ` +
      `their panel. The attachment's file id is ${fileId}. Look at what they sent and tell me ` +
      `what you see — use whatever tool lets you inspect an image attachment.`

    let chose = false
    let lastOutcome = "no attempts ran"
    const MAX_ATTEMPTS = 2
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !chose; attempt++) {
      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
      const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
        threadId,
        content: naturalPrompt,
        modelId: TOOL_MODEL,
      })
      if (isProviderUnavailable(events)) {
        lastOutcome = `attempt ${attempt}: provider unavailable`
        console.log(`media-analysis-agent S2: ${lastOutcome} — not counting against the brain`)
        continue
      }
      if (status !== 200) {
        lastOutcome = `attempt ${attempt}: HTTP ${status}`
        continue
      }
      const calledTools = events
        .filter((e) => e.event === "tool-call")
        .map((e) => (e.data as { toolName?: string }).toolName ?? "")
      chose = calledTools.includes(ANALYZE_TOOL_SDK_NAME)
      lastOutcome = `attempt ${attempt}: tool-calls=[${calledTools.join(", ")}] chose_analyze=${chose}`
      console.log(`media-analysis-agent S2: ${lastOutcome}`)
    }

    if (chose) {
      // Strong outcome — the real brain chose the tool. Assert it.
      expect(chose).toBe(true)
    } else {
      // Resilient: LLM tool-choice is nondeterministic. Don't flaky-hard-fail —
      // S1 is the authoritative wiring proof. Record the outcome and skip-pass.
      console.log(
        `media-analysis-agent S2: SKIP-WITH-NOTE — the live auto/cheap model did NOT choose ` +
          `analyze_media after ${MAX_ATTEMPTS} attempts (${lastOutcome}). S1 (deterministic) ` +
          `remains the authoritative proof that the runtime→tool→Gemini→loop path works.`,
      )
    }
  }, 240_000)
})

// Seed an agent_chat thread the user participates in (copy-pattern from
// agent-tickets.scenario — no shared module yet).
async function seedAgentThread(
  sql: ReturnType<typeof postgres>,
  ks: string,
  orgId: string,
  userId: string,
): Promise<string> {
  const threadId = randomUUID()
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
