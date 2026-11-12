// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Live Auto-model turns through the API connector in a FULL demo world (S17).
 *
 * `api-connector-auto.live.test.ts` proves the connector answers in an org
 * that has nothing else installed. A real deployment has competing apps:
 * Shopify orders, the invoicing app's documents, the kernel's own contacts.
 * Here the org is the demo world itself (`seedDemoWorld`, the seeder the demo
 * box runs: Shopify fixtures, invoicing, contacts, tickets and the fixture CRM
 * as its API connection), and every turn runs with the user looking at the
 * ticket of a customer the CRM knows, so the customer auto-context is present.
 *
 * Asserted per turn:
 *  - an order and invoice question reads the CRM (`connector_read`), names the
 *    CRM's own order numbers and its overdue invoice, and never claims there
 *    is nothing overdue;
 *  - "add a note in the CRM" stages a `connector_write` (its approval names
 *    the method, host and path), never a write to Liaison's own contacts;
 *  - after the person denies that approval, the next turn says the note was
 *    not added.
 *
 * The CRM is the demo responder (in process, no socket), so demo mode is on
 * for the run. Paid (cents): runs only with LIAISON_E2E_LIVE_LLM=1, through
 * the `live` suite (`scripts/test-run.ts live --file <this file>`).
 */
import { afterAll, beforeAll, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { loadCustomerContextBlock } from "~/modules/agent/context/customer-context"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { buildFixtureCrmData } from "~/modules/apps/connections/api/__fixtures__/fixture-crm/data"
import { ensureAppsForOrg, reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { signAccessToken } from "~/modules/auth/jwt"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { describeLive, itLive } from "~/tests/e2e/helpers/live-llm"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const AUTO_UPSTREAM_ID = "google/gemini-3.1-flash-lite"
const CUSTOMER_EMAIL = "jane.doe@acme-instruments.example"
const ACME = "cmp_001"
/** The demo's catalog apps (seed/tiers/demo/demo-apps.ts) that compete with the CRM. */
const CATALOG_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]
const ROOT = path.resolve(import.meta.dir, "../../../../..")
const RUNS = Number(process.env.API_CONNECTOR_WORLD_RUNS ?? "3")
const OTHER_PROVIDER_KEYS = [
  "GOOGLE_API_KEY",
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MISTRAL_API_KEY",
]
const savedEnv: Record<string, string | undefined> = {}

let appsDir = ""
let ORG_ID = ""
let USER_ID = ""
let TICKET_ID = ""
let adminToken = ""
/** The owner's real grants: the tickets RLS reads its dimension grants. */
let PERMS: { roles: string[]; scopes: string[]; dimensionGrants: Record<string, string[]> } = {
  roles: [],
  scopes: [],
  dimensionGrants: {},
}

interface ToolCall {
  toolName: string
  args?: unknown
  result?: unknown
}

/** Install an app from the tarball its current source builds to (scripts/build-bundled-app.sh). */
async function installFromDist(name: string, installedBy: string): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as { version: string; scopes?: string[]; connections?: Record<string, unknown> }
  await installAppFromTarball({
    // Baked into the test catalog: a bundled app installs as the first-party app it is.
    tarballPath: bakeIntoTestCatalog(
      path.join(ROOT, "bundled-apps", name, "dist", `${name}-${manifest.version}.liaisonapp`),
    ),
    installedBy,
    grantedScopes: manifest.scopes ?? [],
    grantedConnections: Object.keys(manifest.connections ?? {}),
    requireSignature: false,
    sourceUrl: `dist:${name}@${manifest.version}`,
  })
}

/** The slice of `seedDemoWorld`'s result this test reads. */
interface SeededWorld {
  orgId: string
  failures: { layer: string; message: string }[]
  org: {
    ownerUserId: string | null
    adminUserId: string
    apps: { name: string; enabled: boolean }[]
  }
}

/**
 * The demo box's own seeder (seed/tiers/demo/seed-demo.ts), imported at run time:
 * scripts/ resolves its dependencies from the repo root, outside this
 * package's type program.
 */
async function loadSeedDemoWorld() {
  const mod = (await import(path.join(ROOT, "apps/api/src/seed/tiers/demo/seed-demo.ts"))) as {
    seedDemoWorld: (opts: {
      orgSlug: string
      variant: "visitor" | "reserved"
      owner: { email: string; name: string; password: string }
    }) => Promise<SeededWorld>
  }
  return mod.seedDemoWorld
}

async function call(method: string, urlPath: string, body?: unknown) {
  const res = await app.request(urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null }
}

async function newThread(label: string): Promise<string> {
  const threadId = crypto.randomUUID()
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}, ${ORG_ID}, ${`${label}-${threadId.slice(0, 8)}`}, 'agent_chat', ${USER_ID})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${threadId}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
  return threadId
}

/** One user turn on the thread, with the customer's ticket in view. */
async function ask(threadId: string, text: string) {
  const messageId = crypto.randomUUID()
  await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${messageId}, ${threadId}, ${ORG_ID}, ${USER_ID}, 'user', ${text}, '{}')`
  const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
  const result = await invokeAgentForThread(
    threadId,
    messageId,
    {
      userId: USER_ID,
      orgId: ORG_ID,
      roles: PERMS.roles,
      scopes: PERMS.scopes,
      dimensionGrants: PERMS.dimensionGrants,
    },
    ORG_ID,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { currentView: { tabType: "tickets:ticket", entityId: TICKET_ID } },
  )
  expect(result.finishReason).not.toBe("error")
  const [reply] = await sql`
    SELECT content, metadata FROM kernel.messages
    WHERE thread_id = ${threadId} AND author_type = 'agent'
    ORDER BY created_at DESC LIMIT 1`
  const content = String(reply?.content ?? "").replace(/[\u00a0\u202f]/g, " ")
  const meta = (reply?.metadata ?? {}) as { toolCalls?: ToolCall[] }
  const toolCalls = meta.toolCalls ?? []
  console.log(
    JSON.stringify(
      {
        question: text,
        toolCalls: toolCalls.map((tc) => ({
          tool: tc.toolName,
          args: JSON.stringify(tc.args ?? {}).slice(0, 200),
        })),
        reply: content.slice(0, 800),
      },
      null,
      2,
    ),
  )
  return { content, toolCalls, toolNames: toolCalls.map((tc) => tc.toolName) }
}

describeLive("api-connector live Auto turns in a full demo world", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of [...OTHER_PROVIDER_KEYS, "LIAISON_APPS_DIR"]) savedEnv[k] = process.env[k]
    for (const k of OTHER_PROVIDER_KEYS) delete process.env[k]
    expect(process.env.OPENROUTER_API_KEY ?? "").toMatch(/^sk-or-/)
    appsDir = mkdtempSync(path.join(tmpdir(), "connector-world-"))
    process.env.LIAISON_APPS_DIR = path.join(appsDir, "apps")
    // The fixture CRM and the Shopify fixtures answer a demo org in process.
    DemoModeTestAccess.set(true)

    // The catalog apps the demo box installs from its baked catalog are
    // installed here from the tarballs the current source builds (the
    // `pretest` bootstrap keeps them fresh), then the world is seeded twice:
    // once for the org and its admin, once more to enable and fill them.
    const seedDemoWorld = await loadSeedDemoWorld()
    const stamp = Date.now()
    const seed = () =>
      seedDemoWorld({
        orgSlug: `connector-world-${stamp}`,
        variant: "visitor",
        owner: {
          email: `connector-world-${stamp}@test.example`,
          name: "World Owner",
          password: "WorldOwner1!Seed",
        },
      })
    const first = await seed()
    await ensureAppsForOrg(first.orgId)
    for (const name of CATALOG_APPS) await installFromDist(name, first.org.adminUserId)
    await reloadInstalledApps(first.orgId)
    const world = await seed()
    expect(world.failures.filter((f) => f.layer !== "warehouse")).toEqual([])
    ORG_ID = world.orgId
    USER_ID = world.org.ownerUserId ?? world.org.adminUserId
    await ensureAppsForOrg(ORG_ID)
    await initSandboxPool()
    PERMS = await withPrivilegedDb(ORG_ID, "connector-world-perms", (tx) =>
      loadEffectivePermissions(tx, USER_ID, ORG_ID),
    )

    adminToken = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "World Owner",
        authVersion: 1,
        permissionVersion: 1,
        roles: PERMS.roles,
        scopes: PERMS.scopes,
        dimensionGrants: PERMS.dimensionGrants,
      },
      env.JWT_SECRET,
    )
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${ORG_ID}, '10.00000000', '0', 'EUR') ON CONFLICT DO NOTHING`
    // A demo org brings its own key (BYOK), as the demo visitor does.
    const key = await call("POST", "/api/settings/ai/keys", {
      provider: "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY,
    })
    expect(key.status).toBe(200)
    const added = await call("POST", "/api/settings/ai/openrouter/models", {
      upstreamId: AUTO_UPSTREAM_ID,
    })
    expect([201, 409]).toContain(added.status)
    const auto = await call("PATCH", "/api/settings/ai/models", {
      autoModelKey: `openrouter/${AUTO_UPSTREAM_ID}`,
    })
    expect(auto.status).toBe(200)

    // The competing apps a real deployment has are all there.
    const names = world.org.apps.filter((a) => a.enabled).map((a) => a.name)
    for (const name of ["api-connector", "shopify", "invoicing", "tickets"])
      expect(names).toContain(name)

    const [ticket] = await sql`
      SELECT t.id FROM app_tickets.tickets t
      LEFT JOIN kernel.contacts c ON c.id = t.contact_id AND c.org_id = t.org_id
      WHERE t.org_id = ${ORG_ID}
        AND (lower(t.requester_email) = ${CUSTOMER_EMAIL} OR lower(c.email) = ${CUSTOMER_EMAIL})
      LIMIT 1`
    TICKET_ID = String(ticket?.id ?? "")
    expect(TICKET_ID).not.toBe("")

    // The customer auto-context is there for this ticket (a precondition, not
    // the behaviour under test).
    const block = await loadCustomerContextBlock({
      currentView: { tabType: "tickets:ticket", entityId: TICKET_ID },
      orgId: ORG_ID,
      actor: {
        actorType: "user",
        userId: USER_ID,
        orgId: ORG_ID,
        roles: PERMS.roles,
        scopes: PERMS.scopes,
        dimensionGrants: PERMS.dimensionGrants,
      },
      effectiveScopes: PERMS.scopes,
      callableTools: () =>
        new Set(["api-connector__connector_read", "api-connector__connector_list_operations"]),
    })
    console.log(`customer context block:\n${block}`, JSON.stringify(world.failures).slice(0, 3000))
    expect(block ?? "").toContain("crm")
  }, 1_200_000)

  afterAll(async () => {
    DemoModeTestAccess.set(false)
    if (appsDir) rmSync(appsDir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetAppRegistries()
    await releaseTestLock()
  })

  const crm = buildFixtureCrmData(new Date())
  const acmeOrders = crm.orders.filter((o) => o.company_id === ACME).map((o) => o.number)
  const acmeOverdue = crm.invoices
    .filter((i) => i.company_id === ACME && i.status === "overdue")
    .map((i) => i.number)

  for (let run = 1; run <= RUNS; run++) {
    itLive(
      `run ${run}: answers orders and overdue invoices from the CRM, not the other apps`,
      async () => {
        expect(acmeOverdue.length).toBeGreaterThan(0)
        const thread = await newThread(`connector-world-q1-${run}`)
        const turn = await ask(
          thread,
          "What did this customer order recently, and is any of their invoices overdue?",
        )
        expect(turn.toolNames.some((n) => n.endsWith("connector_read"))).toBe(true)
        expect(acmeOrders.some((n) => turn.content.includes(n))).toBe(true)
        expect(acmeOverdue.some((n) => turn.content.includes(n))).toBe(true)
        expect(turn.content).not.toMatch(
          /\bno (overdue|unpaid|outstanding)\b|\bnone (of them )?(is|are) overdue\b|\bnot overdue\b/i,
        )
      },
      300_000,
    )
  }

  itLive(
    "a note 'in the CRM' is a connector write, and a denied write is reported as not done",
    async () => {
      const thread = await newThread("connector-world-note")
      const startedAt = new Date()
      const turn = await ask(
        thread,
        "Add a note to Acme Instruments in the CRM: we called them today about the purchase order.",
      )
      expect(turn.toolNames.some((n) => n.endsWith("contacts_write"))).toBe(false)
      expect(turn.toolNames.some((n) => n.endsWith("connector_write"))).toBe(true)

      const [approval] = await sql`
        SELECT id FROM kernel.approval_requests
        WHERE org_id = ${ORG_ID} AND status = 'pending' AND tool_name LIKE '%connector_write'
          AND created_at >= ${startedAt.toISOString()}::timestamptz
        ORDER BY created_at DESC LIMIT 1`
      expect(approval).toBeDefined()
      const shown = await call("GET", `/api/approvals/${String(approval?.id)}`)
      expect(shown.status).toBe(200)
      const summary = JSON.stringify(shown.json)
      expect(summary).toMatch(/POST/)
      expect(summary).toContain("fixture-crm.example")
      expect(summary).toMatch(/\/companies\/cmp_001\/notes|\/notes/)

      const denied = await call("POST", `/api/approvals/${String(approval?.id)}/decide`, {
        decision: "deny",
        reason: "Not now",
      })
      expect(denied.status).toBe(200)

      const after = await ask(thread, "Is the note in the CRM now?")
      expect(after.content).toMatch(/\b(not|wasn't|was not|hasn't|has not|denied|rejected)\b/i)
      expect(after.toolNames.some((n) => n.endsWith("connector_write"))).toBe(false)
    },
    400_000,
  )
})
