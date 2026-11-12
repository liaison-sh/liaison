// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The customer block's tool preload (assembleContext): when a ticket's
// customer is found, the turn loads the connector tools its scopes allow, and
// only those; a caller that keeps no discovery set (the REST composition
// preview) loads none, so the block names none. Real database and registry;
// the outbound fetch seam is the fake.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import * as dnsPromises from "node:dns/promises"
import { validateAdapter } from "@liaison/api-connector-core"
import { sql as drizzleSql } from "drizzle-orm"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import { upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { assembleContext } from "~/modules/agent/context/context"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { registerApiConnectorApp } from "~/modules/apps/connections/api/app.test-helpers"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const READ = "api-connector__connector_read"
const LIST = "api-connector__connector_list_operations"
const WRITE = "api-connector__connector_write"

const CRM = (() => {
  const op = (name: string, role: string | undefined, kind: "read" | "write") => ({
    name,
    description: `${name}.`,
    kind,
    method: kind === "read" ? "GET" : "POST",
    path: `/companies/{customerId}/${name}`,
    params: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        ...(kind === "write" ? { text: { type: "string" } } : {}),
      },
      required: ["customerId"],
    },
    fields: ["id", "name"],
    ...(kind === "read" ? { items: "/data" } : { body: { text: "{text}" } }),
    ...(role ? { role } : {}),
  })
  const r = validateAdapter({
    id: "crm",
    name: "Fixture CRM",
    version: "1",
    baseUrl: "https://crm.example.com",
    auth: { type: "bearer" },
    operations: [
      {
        name: "find",
        description: "Find.",
        kind: "read",
        method: "GET",
        path: "/companies",
        params: { type: "object", properties: { email: { type: "string" } } },
        query: { email: "{email}" },
        items: "/data",
        fields: ["id", "name"],
        role: "customer.lookup",
      },
      op("list_orders", "customer.orders", "read"),
      op("create_note", undefined, "write"),
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
})()

let ORG = ""
let USER = ""
let TICKET = ""
let THREAD = ""
let lookupSpy: ReturnType<typeof spyOn>

const actor = (): UserContext => ({
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
})

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Customer Preload', ${`customer-preload-${Date.now()}`}) RETURNING id`,
    ),
  )
  ORG = org?.id ?? ""
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${ORG}::uuid, ${`preload-${Date.now()}@api-connector.test`},
                'Member', 'active', 'h', 1, 1)
        RETURNING id`,
    ),
  )
  USER = u?.id ?? ""
  await ensureAppsForOrg(ORG)
  await registerApiConnectorApp(ORG)
  const [t] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, last_message_at, message_count, requester_email
      ) VALUES (
        gen_random_uuid(), ${ORG}::uuid, ${`CP-${randomUUID().slice(0, 8)}`}, 'Order question',
        'open', 'normal', 'api', 'internal', ${randomUUID()}, 3600, now(), 1, 'jane@acme.test'
      ) RETURNING id`),
  )
  TICKET = t?.id ?? ""
  THREAD = randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}::uuid, ${ORG}::uuid, ${`preload-${THREAD.slice(0, 8)}`}, 'agent_chat', ${USER}::uuid)`)
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${THREAD}::uuid, ${USER}::uuid, ${ORG}::uuid)`)
  await upsertAdapterRow(ORG, "crm", CRM, USER)
  await withPrivilegedDb(ORG, "customer-preload-test", (tx) =>
    createCredentialConnection(tx, ORG, USER, "api-connector", "api", {
      identifier: "crm",
      credentials: { token: "tok-crm-secret" },
      ownerType: "org",
    }),
  )
}, 180_000)

afterAll(async () => {
  await invalidateConnectionCaches(ORG, "crm")
  resetAppRegistries()
  await releaseTestLock()
})

beforeEach(async () => {
  await invalidateConnectionCaches(ORG, "crm")
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request): Promise<Response> => {
    const email = new URL(String(input)).searchParams.get("email")
    const data = email === "jane@acme.test" ? [{ id: "c1", name: "Acme Instruments" }] : []
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch)
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
})

async function assemble(effectiveScope: string[], discoveredTools: Set<string> | undefined) {
  const result = await assembleContext({
    threadId: THREAD,
    orgId: ORG,
    actor: actor(),
    currentView: { tabType: "tickets:ticket", entityId: TICKET },
    discoveredTools,
    effectiveScope,
  })
  return JSON.stringify(result)
}

describe("customer block: the connector tools it loads", () => {
  it("read-only scopes load connector_read and connector_list_operations, not connector_write", async () => {
    const discovered = new Set<string>()
    const text = await assemble(["api-connector:read", "tickets"], discovered)
    expect(text).toContain("Customer record from Fixture CRM")
    expect(discovered.has(READ)).toBe(true)
    expect(discovered.has(LIST)).toBe(true)
    expect(discovered.has(WRITE)).toBe(false)
  })

  it("read and write scopes load connector_write too", async () => {
    const discovered = new Set<string>()
    const text = await assemble(["api-connector", "tickets"], discovered)
    expect(text).toContain(`${WRITE} with connection`)
    expect([...discovered].sort()).toEqual([LIST, READ, WRITE])
  })

  it("without the read scope there is no block and no connector tool", async () => {
    const discovered = new Set<string>()
    const text = await assemble(["tickets"], discovered)
    expect(text).not.toContain("Customer record from")
    expect([...discovered].filter((n) => n.startsWith("api-connector__"))).toEqual([])
  })

  it("a caller without a discovery set gets the record but no tool the turn does not load", async () => {
    const text = await assemble(["api-connector", "tickets"], undefined)
    expect(text).toContain("Customer record from Fixture CRM")
    // The guide's own phrasing: the block names no tool when none is loaded.
    expect(text).not.toContain(`${READ} with connection`)
    expect(text).not.toContain(`${WRITE} with connection`)
  })
})
