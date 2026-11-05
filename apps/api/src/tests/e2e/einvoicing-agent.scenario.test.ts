// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E-invoicing agent scenarios (S21 / S22) on the REAL agent loop and a REAL model: auto mode
// (no model id, so the cheapest auto-eligible model) at medium reasoning, as a user holding only
// the issuer's role (never admin), with no hint about how to fix anything. Every assertion reads
// STORED STATE and the TOOL TRACE, never the model's wording.
//
//  (a) "can I e-invoice this customer / this order, and why?" -> an einvoicing_classify call with
//      the right subject, whose result carries the expected regime;
//  (b) issue to a French business customer whose SIREN is unknown -> the agent finds it in the
//      business registry (fake) and records it with its provenance, the issue goes to approval,
//      the test approves it, and the document is issued as an e-invoice carrying the SIREN;
//  (b') same with a company neither the registry nor the web knows -> no SIREN recorded, no
//      document issued, the registry was consulted;
//
// A SIREN proposed from the web that belongs to ANOTHER company (writes nothing, asks a person)
// is proven on the real tool path in tests/integration/invoicing-identity-tools.test.ts: inside
// an agent turn the web tools are refused by scope taint once the turn has read invoicing data
// (the company name would leave for an external search engine), so the agent's way there is the
// registry, and a refused web search ends in "tell the user", which (b') checks.
//
// External boundaries are fakes loaded per scenario through /api/_test/einvoicing (registry,
// ECB, web search + fetch). A provider error FAILS the test: nothing here is skipped. Every run
// seeds its own contacts and its own Shopify order, so no run inherits another run's fix.
//
// Prerequisites: the invoicing and shopify bundles built for their current manifest versions
// (`bash scripts/build-bundled-app.sh invoicing --skip-sign`, same for shopify), and the LLM and
// EXA keys of .env.test in the environment (web_search is advertised only with an Exa key).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld } from "@liaison/test-helpers"
import { api, createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import { describeLive } from "./helpers/live-llm"
import { setupScenario, teardownScenario } from "./setup"

// apps/api/src/tests/e2e -> liaison root
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
  // The agent's web tools (web_search / web_fetch): the fix loop's pointer to a SIREN.
  "kernel:agent:web",
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
describeLive("E-invoicing agent: regime, SIREN fix loop, never stuck (S21)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let ks: string
  let inv: string
  let ceo: { id: string; token: string }
  let catalogDir = ""
  let bundles: Record<string, string> = {}

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
      // Auto mode: no model id. Medium reasoning, stated explicitly.
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

  /** One rubric line per case and run: what the agent called and what came out. */
  function rubric(run: number, label: string, turn: Turn, outcome: Record<string, unknown>) {
    console.log(
      JSON.stringify({
        einvoicingAgentRubric: {
          run,
          case: label,
          tools: turn.calls.map((c) => c.name.replace(/^invoicing__/, "")),
          trace: turn.calls.map((c) => ({
            tool: c.name.replace(/^invoicing__/, ""),
            args: JSON.stringify(c.args).slice(0, 400),
            result: JSON.stringify(c.result ?? null).slice(0, 700),
          })),
          reply: turn.text.slice(0, 600),
          errors: turn.errors,
          ...outcome,
        },
      }),
    )
  }

  /** A turn that reached the model and finished: a provider error fails the case (never a skip). */
  function expectTurnRan(turn: Turn) {
    expect({ status: turn.status, errors: turn.errors }).toEqual({ status: 200, errors: [] })
  }

  async function seedContact(company: string, email: string): Promise<string> {
    const id = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.contacts (id, org_id, handle, name, email, company, external_ids, created_by)
       VALUES ($1, $2, $3, $4, $5, $4, '{"country":"FR"}'::jsonb, $6)`,
      [id, world.org.id, `e2e-${id.slice(0, 8)}`, company, email, world.admin.id],
    )
    return id
  }

  async function seedConfirmedIdentity(contactId: string, sirenValue: string, name: string) {
    await env.db.sql.unsafe(
      `INSERT INTO ${inv}.counterparty_identities
         (id, org_id, contact_id, customer_kind, siren, registry_name, registry_postcode, registry_city,
          registry_country_code, registry_status, source, confirmed_via, changed_at)
       VALUES ($1, $2, $3, 'business', $4, $5, '69002', 'LYON', 'FR', 'A', 'registry', 'auto', now())`,
      [crypto.randomUUID(), world.org.id, contactId, sirenValue, name],
    )
  }

  async function identityOf(contactId: string) {
    const rows = (await env.db.sql.unsafe(
      `SELECT siren, source, source_url, confirmed_via, customer_kind FROM ${inv}.counterparty_identities WHERE contact_id = $1`,
      [contactId],
    )) as Array<Record<string, unknown>>
    return rows[0] ?? null
  }

  async function documentsOf(contactId: string) {
    return (await env.db.sql.unsafe(
      `SELECT id, type, status, regime, buyer_siren, number FROM ${inv}.documents WHERE counterparty_contact_id = $1`,
      [contactId],
    )) as Array<Record<string, unknown>>
  }

  async function pendingApprovals(tool: string) {
    return (await env.db.sql.unsafe(
      `SELECT id, current_payload, status FROM ${ks}.approval_requests
        WHERE org_id = $1 AND tool_name = $2 AND status = 'pending'`,
      [world.org.id, tool],
    )) as Array<{ id: string; current_payload: Record<string, unknown>; status: string }>
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
    // Install the apps the way production does: from the image's first-party catalog. A catalog
    // install is what the platform vouches for, so the apps' read-only tools are honoured as
    // reads (a sideloaded tarball's readOnly claim is ignored and every read would be refused on
    // a turn that already read scoped data).
    catalogDir = mkdtempSync(join(tmpdir(), "einvoicing-agent-catalog-"))
    const entries = ["invoicing", "shopify"].map((name) => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
      ) as {
        version: string
        scopes: string[]
      }
      const file = `${name}-${manifest.version}.liaisonapp`
      copyFileSync(join(REPO_ROOT, "bundled-apps", name, "dist", file), join(catalogDir, file))
      return {
        name,
        version: manifest.version,
        file,
        scopes: manifest.scopes,
        connections: name === "shopify" ? ["shop"] : [],
      }
    })
    writeFileSync(join(catalogDir, "catalog.json"), `${JSON.stringify(entries, null, 2)}\n`)
    bundles = Object.fromEntries(entries.map((e) => [e.name, join(catalogDir, e.file)]))

    const result = await setupScenario({
      seed: 47,
      org: { name: "E-invoicing Agent E2E Org" },
      serverEnv: {
        // The Shopify Admin API is the mock here, whatever the environment's live-store flag
        // says: each run seeds its own order in it.
        SHOPIFY_E2E_LIVE: "0",
        LIAISON_APP_CATALOG_DIR: catalogDir,
      },
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

    const shop = await api(url, "/api/_test/shopify/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: {
        orgId: world.org.id,
        realOfflineToken: "mock-offline-token",
        realWebhookSecret: "mock-webhook-secret-einvoicing-agent",
        shopDomain: "einvoicing-agent.myshopify.com",
        bundlePath: bundles.shopify,
      },
    })
    if (shop.status !== 200)
      throw new Error(`shopify install-for-test: ${shop.status} ${JSON.stringify(shop.body)}`)
    const install = await api(url, "/api/_test/invoicing/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id, issuerCountry: "FR", bundlePath: bundles.invoicing },
    })
    if (install.status !== 200)
      throw new Error(
        `invoicing install-for-test: ${install.status} ${JSON.stringify(install.body)}`,
      )

    const reset = await api(url, "/api/_test/einvoicing/reset", {
      method: "POST",
      token: world.admin.token,
    })
    expect(reset.status).toBe(200)
    // The web seams are installed from the start, with no page: a search the scenario did not
    // prepare finds nothing (never the live web).
    const web = await api(url, "/api/_test/einvoicing/web", {
      method: "POST",
      token: world.admin.token,
      body: { pages: [] },
    })
    expect(web.status).toBe(200)

    const user = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [...CEO_ROLE_SCOPES, ...KERNEL_SCOPES],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    ceo = { id: user.id, token: user.token }
  }, 180_000)

  afterAll(async () => {
    if (world)
      await api(url, "/api/_test/einvoicing/reset", {
        method: "POST",
        token: world.admin.token,
      }).catch(() => {})
    await teardownScenario(env, world)
    if (catalogDir) rmSync(catalogDir, { recursive: true, force: true })
  }, 30_000)

  // Each run: its own word in every company name, its own SIRENs, its own order number.
  const RUNS = [
    { run: 1, word: "AUBE", body: "91100001", order: 7401001 },
    { run: 2, word: "BRUME", body: "91200002", order: 7402002 },
    { run: 3, word: "CIME", body: "91300003", order: 7403003 },
  ]

  describe.each(RUNS)("run $run", ({ run, word, body, order }) => {
    const classifiedSiren = siren(`${body.slice(0, 7)}1`)
    const fixSiren = siren(`${body.slice(0, 7)}2`)

    it("(a) customer: 'can I e-invoice this customer?' -> einvoicing_classify by contact, regime e_invoice", async () => {
      const company = `EXEMPLE FONDERIE ${word}`
      const contactId = await seedContact(company, `fonderie-${word.toLowerCase()}@exemple.test`)
      await seedConfirmedIdentity(contactId, classifiedSiren, company)

      const turn = await chat(
        `Can I e-invoice our customer ${company} (contact id ${contactId})? Tell me why.`,
      )
      expectTurnRan(turn)
      const classify = named(turn.calls, "einvoicing_classify").filter(
        (c) => c.args.contact_id === contactId,
      )
      rubric(run, "a-customer", turn, {
        classifyCalls: classify.length,
        regime: deepFind(classify[0]?.result, "regime") ?? null,
      })
      expect(classify.length).toBeGreaterThan(0)
      expect(deepFind(classify[0]!.result, "regime")).toBe("e_invoice")
    }, 240_000)

    it("(a) order: 'can I e-invoice order #N?' -> einvoicing_classify by order, regime e_reporting", async () => {
      // A consumer order shipped to Germany: reported, never e-invoiced.
      const seeded = await api(url, "/api/_test/shopify/mock/orders", {
        method: "POST",
        token: world.admin.token,
        body: {
          orders: [
            {
              id: `gid://shopify/Order/${order}`,
              name: `#${order}`,
              email: `kunde-${word.toLowerCase()}@exemple.test`,
              customerName: `Kunde ${word}`,
              amount: "249.00",
              currencyCode: "EUR",
              financialStatus: "PAID",
              shippingAddress: {
                name: `Kunde ${word}`,
                address1: "Beispielstrasse 1",
                city: "Berlin",
                zip: "10115",
                country: "Germany",
                countryCode: "DE",
              },
              lineItems: [{ title: "Controller", quantity: 1, unitAmount: "249.00" }],
            },
          ],
        },
      })
      expect(seeded.status).toBe(200)

      const turn = await chat(`Can I e-invoice Shopify order #${order}? Why or why not?`)
      expectTurnRan(turn)
      const classify = named(turn.calls, "einvoicing_classify").filter((c) =>
        String(c.args.shopify_order_id ?? "").endsWith(String(order)),
      )
      rubric(run, "a-order", turn, {
        classifyCalls: classify.length,
        regime: deepFind(classify[0]?.result, "regime") ?? null,
      })
      expect(classify.length).toBeGreaterThan(0)
      expect(deepFind(classify[0]!.result, "regime")).toBe("e_reporting")
    }, 240_000)

    it("(b) business-FR customer without SIREN -> registry lookup, identity recorded with provenance, issued as e-invoice", async () => {
      const company = `EXEMPLE MENUISERIE ${word}`
      const contactId = await seedContact(company, `menuiserie-${word.toLowerCase()}@exemple.test`)
      const fx = await api(url, "/api/_test/einvoicing/fixtures", {
        method: "POST",
        token: world.admin.token,
        body: { registry: [{ siren: fixSiren, name: company, postcode: "69002", city: "LYON" }] },
      })
      expect(fx.status).toBe(200)

      const turn = await chat(
        `Please invoice our customer ${company} (contact id ${contactId}, email menuiserie-${word.toLowerCase()}@exemple.test), ` +
          "billing address 4 rue des Tilleuls, 69002 Lyon, France, for 2 days of on-site consulting at 600 EUR per day " +
          "excluding VAT, and issue it.",
      )
      expectTurnRan(turn)

      const identity = await identityOf(contactId)
      const approvals = (await pendingApprovals("invoicing:invoice_create_and_issue")).filter((a) =>
        JSON.stringify(a.current_payload).includes(contactId),
      )
      rubric(run, "b-fix", turn, {
        identity,
        issueApprovals: approvals.length,
        lookupCalls: named(turn.calls, "counterparty_identity_lookup").length,
        setCalls: named(turn.calls, "counterparty_identity_set").length,
      })
      expect(identity).not.toBeNull()
      expect(identity!.siren).toBe(fixSiren)
      expect(["registry", "agent_web"]).toContain(String(identity!.source))
      expect(identity!.source_url).toBeTruthy()
      expect(identity!.confirmed_via).toBe("auto")
      expect(approvals.length).toBe(1)

      // A person (the issuer) signs the invoice off.
      const decided = await api(url, `/api/approvals/${approvals[0]!.id}/decide`, {
        method: "POST",
        token: ceo.token,
        body: { decision: "approve" },
      })
      expect(decided.status).toBe(200)
      const docs = (await documentsOf(contactId)).filter(
        (d) => d.type === "invoice" && d.status !== "draft",
      )
      expect(docs.length).toBe(1)
      expect(docs[0]).toMatchObject({ regime: "e_invoice", buyer_siren: fixSiren })
    }, 300_000)

    it("(b') a company neither the registry nor the web knows -> no SIREN recorded, nothing issued", async () => {
      const company = `EXEMPLE TONNELLERIE ${word}`
      const contactId = await seedContact(company, `tonnellerie-${word.toLowerCase()}@exemple.test`)

      const turn = await chat(
        `Please invoice our customer ${company} (contact id ${contactId}, email tonnellerie-${word.toLowerCase()}@exemple.test), ` +
          "billing address 9 chemin des Vignes, 33000 Bordeaux, France, for one oak barrel at 900 EUR excluding VAT, and issue it.",
      )
      expectTurnRan(turn)
      const identity = await identityOf(contactId)
      const docs = (await documentsOf(contactId)).filter((d) => d.status !== "draft")
      const approvals = (await pendingApprovals("invoicing:invoice_create_and_issue")).filter((a) =>
        JSON.stringify(a.current_payload).includes(contactId),
      )
      rubric(run, "b-none", turn, {
        identity,
        issued: docs.length,
        issueApprovals: approvals.length,
      })
      expect(named(turn.calls, "counterparty_identity_lookup").length).toBeGreaterThan(0)
      expect(identity?.siren ?? null).toBeNull()
      expect(docs.length).toBe(0)
      expect(approvals.length).toBe(0)
    }, 240_000)
  })
})
