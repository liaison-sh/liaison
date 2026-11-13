// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An org with a CRM connected through the API connector must look like one to
// the agent, on every surface: a dogfood run asked "add a note to <company>"
// in fresh chats and the agent wrote a Liaison ticket note instead (and said it
// was done), or gave up because tool_search never surfaced connector_write.
//
// - tool_search: the phrasings people use for a CRM write find connector_write
//   and load it, ahead of the ticket note tool, when a connection has a write
//   operation the turn may run.
// - The prompt names each connection in one line (reads, writes, approval),
//   outside any ticket view, and the deferred catalog's api-connector line
//   names the write operations.
// - The two note tools' descriptions say which side each writes to.
// Real database and registry; no model.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { validateAdapter } from "@liaison/api-connector-core"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import {
  type ConnectedSystem,
  connectedSystemLine,
} from "~/modules/agent/context/connected-systems"
import { assembleContext } from "~/modules/agent/context/context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import {
  registerApiConnectorApp,
  testApiConn,
} from "~/modules/apps/connections/api/app.test-helpers"
import { upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const WRITE = "api-connector__connector_write"
const ADD_NOTE = "tickets__addNote"

const CRM = (() => {
  const r = validateAdapter({
    id: "crm",
    name: "Fixture CRM",
    version: "1",
    baseUrl: "https://crm.example.com",
    auth: { type: "bearer" },
    operations: [
      {
        name: "find_companies",
        description: "Find companies by web domain.",
        kind: "read",
        method: "GET",
        path: "/companies",
        params: { type: "object", properties: { domain: { type: "string" } } },
        query: { domain: "{domain}" },
        items: "/data",
        fields: ["id", "name"],
      },
      {
        name: "add_company_note",
        description: "Add a note to a company's timeline.",
        kind: "write",
        method: "POST",
        path: "/companies/{customerId}/notes",
        params: {
          type: "object",
          properties: { customerId: { type: "string" }, text: { type: "string" } },
          required: ["customerId", "text"],
        },
        body: { text: "{text}" },
        fields: ["id"],
      },
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
})()

let ORG = ""
let USER = ""
let THREAD = ""

const FULL = ["kernel", "tickets", "api-connector"]
const READ_ONLY = ["kernel", "tickets", "api-connector:read"]

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Connected Systems', ${`connected-systems-${Date.now()}`}) RETURNING id`,
    ),
  )
  ORG = org?.id ?? ""
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      drizzleSql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${ORG}::uuid, ${`connected-${Date.now()}@api-connector.test`},
                'Member', 'active', 'h', 1, 1)
        RETURNING id`,
    ),
  )
  USER = u?.id ?? ""
  await ensureAppsForOrg(ORG)
  await registerApiConnectorApp(ORG)
  THREAD = randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${THREAD}::uuid, ${ORG}::uuid, ${`connected-${THREAD.slice(0, 8)}`}, 'agent_chat', ${USER}::uuid)`)
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${THREAD}::uuid, ${USER}::uuid, ${ORG}::uuid)`)
  await upsertAdapterRow(testApiConn(ORG), "crm", CRM, USER)
}, 180_000)

afterAll(async () => {
  resetAppRegistries()
  await releaseTestLock()
})

async function search(query: string, scopes: string[]) {
  const frame = {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    discoveredTools: new Set<string>(),
  }
  const res = await runContextStore.run(frame, () =>
    handleToolSearch({ query }, { orgId: ORG, userId: USER, scopes }),
  )
  return { res, loaded: [...frame.discoveredTools] }
}

describe("tool_search routes a CRM write to connector_write", () => {
  for (const query of [
    "add a note to a company in the CRM",
    "add note company",
    "update CRM",
    "add note to company record",
  ]) {
    it(`"${query}" ranks and loads connector_write first, not the ticket note`, async () => {
      const { res, loaded } = await search(query, FULL)
      expect(res.matches[0]?.name).toBe(WRITE)
      expect(loaded).toContain(WRITE)
      expect(loaded).not.toContain(ADD_NOTE)
    })
  }

  it("the synopsis names the connection's write operations", async () => {
    const { res } = await search("add note company", FULL)
    const hit = res.matches.find((m) => m.name === WRITE)
    expect(hit?.description).toContain('Fixture CRM ("crm"): add_company_note')
    expect(hit?.description).toContain("Approval required")
  })

  it("without the write scope connector_write gains nothing from the connection", async () => {
    const { loaded } = await search("add note company", READ_ONLY)
    expect(loaded).not.toContain(WRITE)
  })
})

async function prompt(effectiveScope: string[]) {
  const result = await assembleContext({
    threadId: THREAD,
    orgId: ORG,
    actor: {
      actorType: "user",
      userId: USER,
      orgId: ORG,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    } satisfies UserContext,
    discoveredTools: new Set<string>(),
    effectiveScope,
  })
  return JSON.stringify(result)
}

describe("the prompt names the connected systems outside a ticket view", () => {
  it("one line per connection: reads, writes and approval", async () => {
    const text = await prompt(FULL)
    expect(text).toContain("## Connected business systems")
    expect(text).toContain(
      '- Fixture CRM (connection \\"crm\\", read with api-connector__connector_read) is connected: reads find_companies; writes add_company_note (api-connector__connector_write, approval required).',
    )
    // The deferred catalog's api-connector line names the write operations.
    expect(text).toMatch(
      /- api-connector: [^\\]*connector_write[^\\]*\(connector_write writes to Fixture CRM: add_company_note\)/,
    )
  })

  it("read-only scopes name the reads and no write", async () => {
    const text = await prompt(READ_ONLY)
    expect(text).toContain(
      '- Fixture CRM (connection \\"crm\\", read with api-connector__connector_read) is connected: reads find_companies.',
    )
    expect(text).not.toContain("writes add_company_note")
  })

  it("without the connector's read scope nothing is said", async () => {
    const text = await prompt(["kernel", "tickets"])
    expect(text).not.toContain("## Connected business systems")
  })
})

describe("the note tools say which side they write to", () => {
  const description = (app: string, tool: string) =>
    (toolRegistry.get([ORG, app, tool]) as { description: string } | undefined)?.description ?? ""

  it("tickets addNote is an internal Liaison ticket note, not an external record", () => {
    expect(description("tickets", "addNote").split(". ")[0]).toMatchInlineSnapshot(
      `"Append an INTERNAL note to a Liaison ticket (seen by teammates on that ticket), never a note on a record in an external system such as a CRM company, contact or deal: that is api-connector connector_write"`,
    )
  })

  it("connector_write writes to the external system", () => {
    expect(description("api-connector", "connector_write").split(". ")[0]).toMatchInlineSnapshot(
      `"Run one WRITE operation of an API connection: writes to the EXTERNAL system, a record in the org's CRM, ERP or other business system (add a note to a company, contact or deal there, create or update a record)"`,
    )
  })
})

describe("connectedSystemLine", () => {
  it("lists at most six operations, then a count", () => {
    const s: ConnectedSystem = {
      app: "erp-app",
      readTool: "erp-app__read",
      writeTool: "erp-app__write",
      connection: "erp",
      system: "ERP",
      reads: ["a", "b", "c", "d", "e", "f", "g", "h"],
      writes: [],
    }
    expect(connectedSystemLine(s)).toBe(
      '- ERP (connection "erp", read with erp-app__read) is connected: reads a, b, c, d, e, f and 2 more.',
    )
  })
})
