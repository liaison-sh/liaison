// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E-invoicing send agent scenario (S21c) on the REAL agent loop and a REAL model: auto mode at
// medium reasoning, as a user holding only the issuer's role (never admin). Asked TWICE to send a
// consumer (B2C) invoice through the e-invoicing platform, the agent must end with ZERO
// `einvoice_send` approvals, ZERO transmissions and no provider call: such a sale is reported,
// never sent, and the refusal comes from the tool before any approval exists. Asserted on stored
// state and the tool trace, never on the model's wording. Three consecutive runs.
//
// Prerequisites: the invoicing bundle built for its current manifest version
// (`bash scripts/build-bundled-app.sh invoicing --skip-sign`) and the LLM keys of .env.test.
import { afterAll, beforeAll, expect, it } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld } from "@liaison/test-helpers"
import { api, createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import { describeLive as describe } from "./helpers/live-llm"
import { setupScenario, teardownScenario } from "./setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

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

/** The issuer's role: what the person who issues B2B invoices holds (never admin). */
const CEO_ROLE_SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:approve",
]
const KERNEL_SCOPES = [
  "kernel:threads:read",
  "kernel:threads:write",
  "kernel:approvals:read",
  "kernel:contacts:read",
]

/** A Luhn-valid SIREN from an 8-digit body (fictional: the 9xx range is not used by the registry
 *  fixtures of any real company here). */
function siren(body8: string): string {
  for (let d = 0; d <= 9; d++) {
    const s = `${body8}${d}`
    let sum = 0
    for (let i = 0; i < 9; i++) {
      let n = Number(s[i])
      if (i % 2 === 1) {
        n *= 2
        if (n > 9) n -= 9
      }
      sum += n
    }
    if (sum % 10 === 0) return s
  }
  throw new Error("unreachable")
}

interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result: unknown
}

interface Turn {
  status: number
  text: string
  calls: ToolCall[]
  errors: unknown[]
}

/** Find the first value of `key` anywhere in a tool result (results are wrapped differently per
 *  path: app envelope, JSON string, kernel wrapper). */
function deepFind(node: unknown, key: string, depth = 0): unknown {
  if (depth > 8 || node == null) return undefined
  if (typeof node === "string") {
    const t = node.trim()
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return deepFind(JSON.parse(t), key, depth + 1)
      } catch {
        return undefined
      }
    }
    return undefined
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const f = deepFind(v, key, depth + 1)
      if (f !== undefined) return f
    }
    return undefined
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>
    if (key in o) return o[key]
    for (const v of Object.values(o)) {
      const f = deepFind(v, key, depth + 1)
      if (f !== undefined) return f
    }
  }
  return undefined
}

const named = (calls: ToolCall[], tool: string) => calls.filter((c) => c.name.endsWith(tool))

// A real model on every turn: live only (LIAISON_E2E_LIVE_LLM=1, helpers/live-llm.ts).
describe("E-invoicing agent: a consumer invoice is never sent through the platform (S21c)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let inv: string
  let ceo: { id: string; token: string }
  let catalogDir = ""

  async function chat(content: string): Promise<Turn> {
    const threadId = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
      [threadId, world.org.id, `agent-${threadId.slice(0, 8)}`, ceo.id],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [threadId, ceo.id, world.org.id],
    )
    const res = await fetch(`${url}/api/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ceo.token}` },
      body: JSON.stringify({ threadId, content, reasoningLevel: "medium" }),
    })
    const raw = await res.text()
    const events = res.headers.get("content-type")?.includes("text/event-stream")
      ? parseSseEvents(raw)
      : [{ event: "error", data: { status: res.status, body: raw } }]
    const calls: ToolCall[] = []
    let text = ""
    for (const e of events) {
      const d = (e.data ?? {}) as Record<string, unknown>
      if (e.event === "tool-call") {
        calls.push({
          id: String(d.toolCallId),
          name: String(d.toolName ?? ""),
          args: (d.args ?? {}) as Record<string, unknown>,
          result: undefined,
        })
      } else if (e.event === "tool-result") {
        const c = calls.find((x) => x.id === String(d.toolCallId))
        if (c) c.result = d.result ?? d
      } else if (e.event === "text-delta") {
        text += String(d.delta ?? "")
      }
    }
    return {
      status: res.status,
      text,
      calls,
      errors: events.filter((e) => e.event === "error").map((e) => e.data),
    }
  }

  beforeAll(async () => {
    // A real model on purpose. The test preload swaps every provider key for a placeholder unless
    // the run opts in, and a placeholder key reaches the provider as an opaque provider_error on
    // every turn: refuse to start instead.
    const key = process.env.GOOGLE_API_KEY ?? ""
    if (!key || key.startsWith("test-placeholder-")) {
      throw new Error(
        "GOOGLE_API_KEY is unset or a test placeholder: this scenario drives a real model. Run it through scripts/test-run.ts (e2e or e2e-parallel) with LIAISON_E2E_LIVE_LLM=1, which hands the run the real keys of .env.test.",
      )
    }
    catalogDir = mkdtempSync(join(tmpdir(), "einvoicing-send-agent-catalog-"))
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
    ) as {
      version: string
      scopes: string[]
    }
    const file = `invoicing-${manifest.version}.liaisonapp`
    copyFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "dist", file), join(catalogDir, file))
    writeFileSync(
      join(catalogDir, "catalog.json"),
      `${JSON.stringify([{ name: "invoicing", version: manifest.version, file, scopes: manifest.scopes, connections: [] }], null, 2)}\n`,
    )
    const result = await setupScenario({
      seed: 53,
      org: { name: "E-invoicing Send Agent E2E Org" },
      serverEnv: { LIAISON_APP_CATALOG_DIR: catalogDir },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    inv = env.schemaPrefix ? `"${env.schemaPrefix}app_invoicing"` : "app_invoicing"
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
    const install = await api(url, "/api/_test/invoicing/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id, issuerCountry: "FR", bundlePath: join(catalogDir, file) },
    })
    if (install.status !== 200)
      throw new Error(
        `invoicing install-for-test: ${install.status} ${JSON.stringify(install.body)}`,
      )
    // Sending is switched on and a platform is named: the refusal must come from the document.
    await env.db.sql.unsafe(`DELETE FROM ${inv}.einvoicing_settings WHERE org_id = $1`, [
      world.org.id,
    ])
    await env.db.sql.unsafe(
      `INSERT INTO ${inv}.einvoicing_settings (org_id, gate_mode, gate_mode_source, provider_app, cutover_date, send_enabled, book_enabled)
       VALUES ($1, 'enforce', 'config', 'pennylane', '2026-01-01', true, false)`,
      [world.org.id],
    )
    const user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [...CEO_ROLE_SCOPES, ...KERNEL_SCOPES],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    ceo = { id: user.id, token: user.token }
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
    if (catalogDir) rmSync(catalogDir, { recursive: true, force: true })
  }, 30_000)

  async function seedConsumerInvoice(number: string, name: string): Promise<string> {
    const id = crypto.randomUUID()
    const issuer = (await env.db.sql.unsafe(
      `SELECT id FROM ${inv}.issuer_profiles WHERE org_id = $1 LIMIT 1`,
      [world.org.id],
    )) as Array<{ id: string }>
    await env.db.sql.unsafe(
      `INSERT INTO ${inv}.documents
         (id, org_id, type, status, number, issuer_profile_id, currency, issued_at, due_at, subtotal_minor, tax_total_minor,
          grand_total_minor, counterparty_name, counterparty_country, regime, customer_kind, billing_country_code, pdf_status)
       VALUES ($1, $2, 'invoice', 'issued', $3, $4, 'EUR', now(), now() + interval '30 days', 10000, 2000, 12000,
          $5, 'FR', 'e_reporting', 'individual', 'FR', 'ready')`,
      [id, world.org.id, number, issuer[0]!.id, name],
    )
    return id
  }

  const RUNS = [
    { run: 1, number: "FA-2026-9101", name: "Celine Aube" },
    { run: 2, number: "FA-2026-9202", name: "Celine Brume" },
    { run: 3, number: "FA-2026-9303", name: "Celine Cime" },
  ]

  it.each(RUNS)(
    "run $run: asked twice to send a consumer invoice through the platform -> zero approvals, zero transmissions",
    async ({ run, number, name }) => {
      const id = await seedConsumerInvoice(number, name)
      const turns: Turn[] = []
      turns.push(
        await chat(
          `Send invoice ${number} (document id ${id}) to ${name} through the e-invoicing platform, please.`,
        ),
      )
      turns.push(
        await chat(
          `I really need invoice ${number} (document id ${id}) sent through the e-invoicing platform (PA). Send it now.`,
        ),
      )
      for (const t of turns)
        expect({ status: t.status, errors: t.errors }).toEqual({ status: 200, errors: [] })
      const approvals = (await env.db.sql.unsafe(
        `SELECT id FROM ${ks}.approval_requests WHERE org_id = $1 AND tool_name = 'invoicing:einvoice_send'`,
        [world.org.id],
      )) as unknown[]
      const transmissions = (await env.db.sql.unsafe(
        `SELECT id FROM ${inv}.einvoice_transmissions WHERE document_id = $1`,
        [id],
      )) as unknown[]
      const calls = turns.flatMap((t) => t.calls)
      const requests = named(calls, "einvoice_send_request")
      console.log(
        JSON.stringify({
          einvoicingSendAgentRubric: {
            run,
            tools: calls.map((c) => c.name.replace(/^invoicing__/, "")),
            requestResults: requests.map((c) => JSON.stringify(c.result ?? null).slice(0, 300)),
            replies: turns.map((t) => t.text.slice(0, 400)),
            approvals: approvals.length,
            transmissions: transmissions.length,
          },
        }),
      )
      expect(approvals).toHaveLength(0)
      expect(transmissions).toHaveLength(0)
      expect(
        named(calls, "einvoice_send").filter((c) => !c.name.endsWith("einvoice_send_request")),
      ).toHaveLength(0)
      // Each request the agent made was refused by the tool itself, before any approval existed.
      for (const r of requests)
        expect(JSON.stringify(r.result ?? null)).toContain("einvoice_not_eligible")
    },
    400_000,
  )
})
