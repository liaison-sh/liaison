// SPDX-License-Identifier: FSL-1.1-ALv2
// S35: the agent imports two sources it has no reference transform for, with
// a REAL model, end to end: a Trello board's JSON export into projects and a
// Help Scout conversations CSV into tickets (fictional fixtures). For each, a
// person uploads the export through the import upload routes and asks the
// agent; the agent reads the skill and the kinds, writes a transform, previews
// it, fixes it until the preview is right and proposes the import; the person
// approves; the run imports in the background. A checker then compares the
// records with the fixtures (counts and fields) and expects 0 mismatches.
//
// Live only (LIAISON_E2E_LIVE_LLM=1): it calls the org's model provider.

import { afterAll, beforeAll, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { describeLive } from "./helpers/live-llm"
import { setupScenario, teardownScenario } from "./setup"

const FIXTURES = join(import.meta.dir, "fixtures", "import-sources")
const MAX_TURNS = 6

interface SseEvent {
  event: string
  data: unknown
}

function parseSse(body: string): SseEvent[] {
  const out: SseEvent[] = []
  for (const block of body.split("\n\n").filter((b) => b.trim())) {
    let event = "message"
    let data = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim()
      else if (line.startsWith("data: ")) data = line.slice(6).trim()
    }
    try {
      out.push({ event, data: JSON.parse(data) })
    } catch {
      out.push({ event, data })
    }
  }
  return out
}

/** The CSV rows of the fixture (quoted fields with commas). */
function csvRows(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += c
  }
  if (field || row.length) rows.push([...row, field])
  const [head, ...body] = rows
  return body.map((r) => Object.fromEntries((head ?? []).map((h, i) => [h, r[i] ?? ""])))
}

describeLive("S35: the agent imports sources it has no reference for (real model)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let ps: string
  let ts: string

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${world.admin.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    const json = (await res.json().catch(() => ({}))) as { data?: unknown }
    return { status: res.status, data: json.data as Record<string, unknown> }
  }

  /** Upload a fixture through the import upload routes; returns its file id. */
  async function upload(name: string, mime: string): Promise<string> {
    const bytes = readFileSync(join(FIXTURES, name))
    const created = await api("/api/imports/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: name, mimeType: mime, size: bytes.byteLength }),
    })
    expect(created.status).toBe(200)
    const up = created.data as {
      id: string
      mode: string
      parts?: Array<{ url: string }>
      uploadUrl?: string
    }
    const relay = String(up.uploadUrl ?? "")
    const target =
      up.mode === "multipart"
        ? up.parts?.[0]?.url
        : relay.startsWith("http")
          ? relay
          : `${url}${relay.startsWith("/api") ? "" : "/api"}${relay}`
    if (!target) throw new Error(`no upload target in ${JSON.stringify(created.data)}`)
    const put = await fetch(String(target), {
      method: "PUT",
      body: bytes,
      headers:
        up.mode === "multipart"
          ? {}
          : { Authorization: `Bearer ${world.admin.token}`, "Content-Type": mime },
    })
    expect(put.status).toBeLessThan(300)
    const done = await api(`/api/imports/uploads/${up.id}/complete`, { method: "POST" })
    expect(done.status).toBe(200)
    return String((done.data as { fileId: string }).fileId)
  }

  async function chat(threadId: string, content: string): Promise<SseEvent[]> {
    const res = await fetch(`${url}/api/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${world.admin.token}` },
      body: JSON.stringify({ threadId, content, modelId: null }),
    })
    const body = await res.text()
    if (res.status !== 200)
      throw new Error(`agent chat answered ${res.status}: ${body.slice(0, 500)}`)
    return parseSse(body)
  }

  /** One line per turn: the tools the agent called (with an error, if any) and how it ended. */
  function describeTurn(turn: number, events: SseEvent[]): void {
    const calls = events
      .filter((e) => e.event === "tool-call")
      .map((e) => e.data as { toolName?: string; toolCallId?: string })
    const results = new Map(
      events
        .filter((e) => e.event === "tool-result")
        .map((e) => {
          const d = e.data as { toolCallId?: string; result?: { error?: unknown } }
          return [d.toolCallId, d.result?.error] as const
        }),
    )
    const tools = calls.map((c) => {
      const err = results.get(c.toolCallId)
      return `${c.toolName}${err ? ` [error: ${JSON.stringify(err).slice(0, 160)}]` : ""}`
    })
    const text = events
      .filter((e) => e.event === "text-delta" || e.event === "text")
      .map((e) =>
        String(
          (e.data as { text?: string; delta?: string })?.text ??
            (e.data as { delta?: string })?.delta ??
            "",
        ),
      )
      .join("")
    console.log(
      `S35 turn ${turn}: ${tools.join(", ") || "(no tool)"} | ${text.replace(/\s+/g, " ").slice(-300)}`,
    )
  }

  async function newThread(): Promise<string> {
    const id = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
      [id, world.org.id, `agent-${id.slice(0, 8)}`, world.admin.id],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [id, world.admin.id, world.org.id],
    )
    return id
  }

  /** Talk until the agent proposes the import; approve it; wait for the run. */
  async function importThroughAgent(ask: string): Promise<{ runId: string; turns: number }> {
    const threadId = await newThread()
    let content = ask
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const events = await chat(threadId, content)
      describeTurn(turn, events)
      const err = events.find((e) => e.event === "error")
      if (err) throw new Error(`agent turn ${turn} failed: ${JSON.stringify(err.data)}`)
      const pending = await env.db.sql.unsafe(
        `SELECT id FROM ${ks}.approval_requests
         WHERE org_id = $1 AND status = 'pending' AND tool_name LIKE '%import_start'
         ORDER BY created_at DESC LIMIT 1`,
        [world.org.id],
      )
      if (pending.length > 0) {
        const approvalId = String(pending[0]!.id)
        // A person approves what they were shown: the card's payload hash.
        const shown = await api(`/api/approvals/${approvalId}`)
        const payloadHash = (shown.data as { payloadHash?: string }).payloadHash
        const card = (shown.data as { summary?: { lines?: string[] } }).summary?.lines ?? []
        console.log(`S35 card: ${JSON.stringify(card).slice(0, 800)}`)
        const decided = await api(`/api/approvals/${approvalId}/decide`, {
          method: "POST",
          body: JSON.stringify({ decision: "approve", payloadHash }),
        })
        expect(decided.status).toBe(200)
        for (let i = 0; i < 240; i++) {
          const rows = await env.db.sql.unsafe(
            `SELECT id, status, errors FROM ${ks}.import_runs WHERE approval_request_id = $1`,
            [approvalId],
          )
          const run = rows[0]
          if (run && ["done", "failed", "cancelled"].includes(String(run.status))) {
            if (run.status !== "done")
              throw new Error(`the import ${run.status}: ${JSON.stringify(run.errors)}`)
            return { runId: String(run.id), turns: turn }
          }
          await Bun.sleep(500)
        }
        throw new Error("the approved import did not finish in 2 minutes")
      }
      content =
        "Keep going: read the preview, fix the transform if records were refused or fields are missing, preview again, and propose the import with kernel__import_start when it is right."
    }
    throw new Error(`the agent proposed no import in ${MAX_TURNS} turns`)
  }

  beforeAll(async () => {
    const result = await setupScenario({ seed: 35, org: { name: "S35 Import Org" } })
    env = result.env
    world = result.world
    url = env.serverUrl
    const q = (s: string) => (env.schemaPrefix ? `"${env.schemaPrefix}${s}"` : s)
    ks = q("kernel")
    ps = q("app_projects")
    ts = q("app_tickets")
    for (const m of MODEL_PRICING_SEED) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (provider, model_id) DO NOTHING`,
        [
          m.provider,
          m.modelId,
          m.displayName,
          m.inputCostPerM,
          m.outputCostPerM,
          m.contextWindow,
          m.autoEligible,
          m.tierMinimum,
          m.source,
        ],
      )
    }
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.credit_balances (org_id, included_balance, purchased_balance, currency)
       VALUES ($1, '50.00000000', '50.00000000', 'EUR')
       ON CONFLICT (org_id) DO UPDATE SET included_balance = '50.00000000', purchased_balance = '50.00000000'`,
      [world.org.id],
    )
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  it("a Trello board export into projects: one project, a task per card in its list's status, comments kept", async () => {
    const board = JSON.parse(readFileSync(join(FIXTURES, "trello-board.json"), "utf8")) as {
      name: string
      lists: Array<{ id: string; name: string }>
      cards: Array<{ id: string; name: string; idList: string }>
      actions: Array<{ type: string; data: { text?: string; card?: { id: string } } }>
    }
    const fileId = await upload("trello-board.json", "application/json")
    const { runId, turns } = await importThroughAgent(
      `I uploaded our Trello board export (file id ${fileId}, trello-board.json). Import it into Projects: the board is one project, each list is a status, each card a task in its list's status with its description, due date and comments. There is no shipped example for Trello: read the import-transforms skill, look at the import kinds, write the transform, preview it, and propose the import.`,
    )
    console.log(`S35 Trello: imported in ${turns} turn(s), run ${runId}`)

    const mismatches: string[] = []
    const tasks = await env.db.sql.unsafe(
      `SELECT t.id, t.title, t.description, s.label AS status, t.thread_id
       FROM ${ps}.tasks t JOIN ${ps}.projects p ON p.id = t.project_id
       LEFT JOIN ${ps}.project_statuses s ON s.id = t.status_id
       WHERE t.org_id = $1 AND p.name = $2`,
      [world.org.id, board.name],
    )
    if (tasks.length !== board.cards.length) {
      mismatches.push(`tasks: ${tasks.length}, cards: ${board.cards.length}`)
    }
    const listName = new Map(board.lists.map((l) => [l.id, l.name]))
    for (const card of board.cards) {
      const task = tasks.find((t) => t.title === card.name)
      if (!task) {
        mismatches.push(`no task for card "${card.name}"`)
        continue
      }
      // A status joins the project's existing one of the same name, any case.
      if (String(task.status).toLowerCase() !== String(listName.get(card.idList)).toLowerCase()) {
        mismatches.push(`"${card.name}": status ${task.status}, list ${listName.get(card.idList)}`)
      }
      for (const a of board.actions) {
        if (a.type !== "commentCard" || a.data.card?.id !== card.id || !a.data.text) continue
        const inThread = await env.db.sql.unsafe(
          `SELECT 1 FROM ${ks}.messages WHERE thread_id = $1 AND content LIKE $2 LIMIT 1`,
          [task.thread_id, `%${a.data.text}%`],
        )
        if (inThread.length === 0 && !String(task.description ?? "").includes(a.data.text)) {
          mismatches.push(`"${card.name}": comment "${a.data.text}" missing`)
        }
      }
    }
    expect(mismatches).toEqual([])
  }, 900_000)

  it("a Help Scout conversations CSV into tickets: a ticket per conversation, its threads in order, notes internal", async () => {
    const rows = csvRows(readFileSync(join(FIXTURES, "helpscout-conversations.csv"), "utf8"))
    const fileId = await upload("helpscout-conversations.csv", "text/csv")
    const { runId, turns } = await importThroughAgent(
      `I uploaded our Help Scout conversations export (file id ${fileId}, helpscout-conversations.csv): one row per thread of a conversation. Import it into Tickets: a ticket per conversation with its subject, status and customer, and every thread as a message in order (customer threads are from the customer, message threads are our replies, note threads are internal notes). There is no shipped example for Help Scout: read the import-transforms skill, look at the import kinds, write the transform, preview it, and propose the import.`,
    )
    console.log(`S35 Help Scout: imported in ${turns} turn(s), run ${runId}`)

    const kindOf: Record<string, string> = {
      customer: "inbound",
      message: "outbound",
      note: "note",
    }
    const bySubject = new Map<string, Array<Record<string, string>>>()
    for (const r of rows) bySubject.set(r.Subject!, [...(bySubject.get(r.Subject!) ?? []), r])
    const mismatches: string[] = []
    const ledgerTickets = await env.db.sql.unsafe(
      `SELECT t.id, t.subject FROM ${ts}.tickets t
       JOIN ${ks}.import_ledger l ON l.row_id = t.id AND l.table_name = 'app_tickets.tickets'
       WHERE l.run_id = $1`,
      [runId],
    )
    if (ledgerTickets.length !== bySubject.size) {
      mismatches.push(`tickets: ${ledgerTickets.length}, conversations: ${bySubject.size}`)
    }
    for (const [subject, threads] of bySubject) {
      const ticket = ledgerTickets.find((t) => t.subject === subject)
      if (!ticket) {
        mismatches.push(`no ticket "${subject}"`)
        continue
      }
      const msgs = await env.db.sql.unsafe(
        `SELECT kind, from_email, text_body FROM ${ts}.messages WHERE ticket_id = $1 ORDER BY sent_at, created_at`,
        [ticket.id],
      )
      const want = threads.map((t) => kindOf[t["Thread Type"]!])
      const got = msgs.map((m) => m.kind)
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        mismatches.push(`"${subject}": kinds ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
      }
      threads.forEach((t, i) => {
        if (!String(msgs[i]?.text_body ?? "").includes(t.Body!.slice(0, 20))) {
          mismatches.push(`"${subject}": message ${i + 1} body differs`)
        }
      })
      const firstInbound = msgs.find((m) => m.kind === "inbound")
      if (firstInbound?.from_email !== threads[0]!["Customer Email"]) {
        mismatches.push(`"${subject}": customer ${firstInbound?.from_email}`)
      }
    }
    expect(mismatches).toEqual([])
  }, 900_000)
})
