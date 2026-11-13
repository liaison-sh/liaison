// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Live Auto-model turn through the API connector (S17): "What did Acme
 * Instruments order last month?" is answered from the fixture CRM, naming a
 * real order, in at most 3 connector tool calls.
 *
 * Real everything except the system behind the connector: the fixture CRM runs
 * as a Bun.serve HTTP server on loopback (reachable because this test sets
 * LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true, as a development deployment
 * would), the org is OpenRouter-only (the only provider key this run carries)
 * and its Auto model is an OpenRouter chat model added through the AI models
 * API. Paid (well under a cent): runs only with LIAISON_E2E_LIVE_LLM=1, through
 * the `live` suite (`scripts/test-run.ts live --file <this file>`).
 */
import { afterAll, beforeAll, expect } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { loadFixtureCrmAdapter } from "~/modules/apps/connections/api/__fixtures__/fixture-crm/adapter"
import {
  type FixtureCrm,
  startFixtureCrm,
} from "~/modules/apps/connections/api/__fixtures__/fixture-crm/server"
import { testApiConn } from "~/modules/apps/connections/api/app.test-helpers"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import { upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { signAccessToken } from "~/modules/auth/jwt"
import { describeLive, itLive } from "~/tests/e2e/helpers/live-llm"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-00000000ac01"
const USER_ID = "00000000-0000-4000-8000-00000000ac02"
const THREAD_ID = "00000000-0000-4000-8000-00000000ac03"
const MESSAGE_ID = "00000000-0000-4000-8000-00000000ac04"
/** The cheapest tool-capable OpenRouter chat model the live tests use. */
const AUTO_UPSTREAM_ID = "google/gemini-3.1-flash-lite"
const API_KEY = "fixture-crm-live-key"
const ACME = "cmp_001"

let crm: FixtureCrm
let adminToken = ""
const OTHER_PROVIDER_KEYS = [
  "GOOGLE_API_KEY",
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MISTRAL_API_KEY",
]
const savedEnv: Record<string, string | undefined> = {}

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
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

describeLive("api-connector live Auto turn (OpenRouter-only org, fixture CRM)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of [...OTHER_PROVIDER_KEYS, "LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS"])
      savedEnv[k] = process.env[k]
    for (const k of OTHER_PROVIDER_KEYS) delete process.env[k]
    process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS = "true"
    expect(process.env.OPENROUTER_API_KEY ?? "").toMatch(/^sk-or-/)

    crm = startFixtureCrm({ apiKey: API_KEY })

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'Connector Live Org', ${`connector-live-${Date.now()}`})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${USER_ID}, ${ORG_ID}, ${`connector-live-${Date.now()}@test.com`}, 'Live Admin')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'connector-live-chat', 'agent_chat', ${USER_ID})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${ORG_ID}, '10.00000000', '0', 'EUR') ON CONFLICT DO NOTHING`
    adminToken = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Live Admin",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )

    await ensureAppsForOrg(ORG_ID)
    await initSandboxPool()

    // Auto runs an OpenRouter chat model, added the way the AI models page does.
    const added = await call("POST", "/api/settings/ai/openrouter/models", {
      upstreamId: AUTO_UPSTREAM_ID,
    })
    expect([201, 409]).toContain(added.status)
    const auto = await call("PATCH", "/api/settings/ai/models", {
      autoModelKey: `openrouter/${AUTO_UPSTREAM_ID}`,
    })
    expect(auto.status).toBe(200)

    // The connection: the fixture adapter at the server's loopback address.
    await upsertAdapterRow(
      testApiConn(ORG_ID),
      "crm",
      loadFixtureCrmAdapter({ baseUrl: crm.baseUrl }),
      USER_ID,
    )
    await withPrivilegedDb(ORG_ID, "connector-live-credentials", (tx) =>
      createCredentialConnection(tx, ORG_ID, USER_ID, "api-connector", "api", {
        identifier: "crm",
        credentials: { apiKey: API_KEY },
        ownerType: "org",
      }),
    )
  }, 120_000)

  afterAll(async () => {
    await invalidateConnectionCaches(testApiConn(ORG_ID), "crm")
    await crm?.stop()
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetAppRegistries()
    await releaseTestLock()
  })

  itLive(
    "answers an order question from the fixture CRM in at most 3 connector calls",
    async () => {
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${MESSAGE_ID}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user',
                'What did Acme Instruments order last month?', '{}')`
      const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
      const result = await invokeAgentForThread(
        THREAD_ID,
        MESSAGE_ID,
        { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
        ORG_ID,
      )
      expect(result.finishReason).not.toBe("error")

      const [reply] = await sql`
        SELECT content, metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1`
      const content = String(reply?.content ?? "")
      const meta = (reply?.metadata ?? {}) as {
        model?: string
        toolCalls?: { toolName: string }[]
      }
      const toolNames = (meta.toolCalls ?? []).map((tc) => tc.toolName)
      const connectorCalls = toolNames.filter((n) =>
        /connector_(list_operations|read|write)$/.test(n),
      )
      console.log(
        JSON.stringify({ model: meta.model, toolNames, reply: content.slice(0, 600) }, null, 2),
      )

      // The answer came from the connector, in at most 3 connector calls.
      expect(connectorCalls.some((n) => n.endsWith("connector_read"))).toBe(true)
      expect(connectorCalls.length).toBeLessThanOrEqual(3)
      // The fixture server was actually asked for Acme's orders.
      expect(
        crm.handler.requests.some((r) => r.startsWith(`GET /v1/companies/${ACME}/orders`)),
      ).toBe(true)

      // It names at least one real Acme order: its number, id or total.
      const acmeOrders = crm.handler.data.orders.filter((o) => o.company_id === ACME)
      const tokens = acmeOrders.flatMap((o) => [
        o.number,
        o.id,
        o.total.toLocaleString("en-US"),
        String(o.total),
      ])
      const normalized = content.replace(/[  ]/g, " ")
      expect(tokens.some((t) => normalized.includes(t))).toBe(true)
    },
    180_000,
  )
})
