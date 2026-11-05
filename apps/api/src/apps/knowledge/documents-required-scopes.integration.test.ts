// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * app_knowledge.documents carries the same requiredScopes provenance a
 * kernel.messages row carries (text[], NOT NULL, empty by default), so the
 * Knowledge read path and the agent context filter can apply the same
 * visibility predicate. The column is migration-owned (like org_access and
 * acl_user_ids): it is not declared in app.manifest.json, so no manifest-driven
 * generic write can set it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import {
  createKnowledgeDocument,
  knowledgeActorFromContext,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import {
  type RunContext,
  runContextStore,
  runWithToolCallScopesBefore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

const SCOPES = ["knowledge:documents:read", "knowledge:documents:create"]

async function readRequiredScopes(id: string): Promise<unknown> {
  const [row] = extractRows<{ required_scopes: unknown }>(
    await db.execute(
      sql`SELECT required_scopes FROM app_knowledge.documents WHERE id = ${id}::uuid`,
    ),
  )
  return row?.required_scopes
}

beforeAll(async () => {
  await acquireTestLock()
  const stamp = Date.now()
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeRequiredScopes', ${`knowledge-rs-${stamp}`})
          RETURNING id`,
    ),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`rs-${stamp}@x.test`}, 'Rs', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  userId = u!.id
})

afterAll(releaseTestLock)

describe("app_knowledge.documents requiredScopes provenance", () => {
  it("knowledge documents persist the requiredScopes the writer supplies", async () => {
    const actor = knowledgeActorFromContext({ orgId, userId, scopes: SCOPES, dimensionGrants: {} })
    const created = await withRlsContext(
      { actorType: "user", orgId, userId, scopes: SCOPES, dimensionGrants: {} },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "personal",
            title: "Untagged provenance",
            body: "created with no requiredScopes",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          } as never,
          actor,
          [],
        ),
    )
    expect(await readRequiredScopes(created.id)).toEqual([])

    // The column accepts an explicit scope set (the T29 write path persists one).
    await db.execute(
      sql`UPDATE app_knowledge.documents
          SET required_scopes = ARRAY['mail:read', 'tickets:*']::text[]
          WHERE id = ${created.id}::uuid`,
    )
    expect(await readRequiredScopes(created.id)).toEqual(["mail:read", "tickets:*"])
  })

  it("requiredScopes is a NOT NULL text[] column, same shape as kernel.messages.required_scopes", async () => {
    const cols = extractRows<{
      table_schema: string
      data_type: string
      udt_name: string
      is_nullable: string
      column_default: string | null
    }>(
      await db.execute(
        sql`SELECT table_schema, data_type, udt_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE column_name = 'required_scopes'
              AND ((table_schema = 'app_knowledge' AND table_name = 'documents')
                OR (table_schema = 'kernel' AND table_name = 'messages'))
            ORDER BY table_schema`,
      ),
    )
    const doc = cols.find((c) => c.table_schema === "app_knowledge")
    const msg = cols.find((c) => c.table_schema === "kernel")
    expect(doc).toBeDefined()
    expect(doc!.data_type).toBe("ARRAY")
    expect(doc!.udt_name).toBe(msg!.udt_name)
    expect(doc!.is_nullable).toBe("NO")
    // P2b-T29 dropped the default: every writer supplies the value, so an
    // untagged insert must fail instead of silently landing as world-readable.
    expect(doc!.column_default).toBeNull()
  })

  it("an untagged insert fails once every writer supplies the value", async () => {
    await expect(
      (async () => {
        await db.execute(
          sql`INSERT INTO app_knowledge.documents
                (org_id, title, document_scope, sensitivity, created_by)
              VALUES (${orgId}::uuid, 'no scopes at all', 'organization', 'internal', ${userId}::uuid)`,
        )
      })(),
    ).rejects.toThrow()
  })

  it("an explicit NULL requiredScopes is rejected", async () => {
    await expect(
      (async () => {
        await db.execute(
          sql`INSERT INTO app_knowledge.documents
                (org_id, title, document_scope, sensitivity, created_by, required_scopes)
              VALUES (${orgId}::uuid, 'null scopes', 'organization', 'internal', ${userId}::uuid, NULL)`,
        )
      })(),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// D5 write inheritance (P2b-T29)
// ---------------------------------------------------------------------------

const WRITE_SCOPES = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
]

function rls() {
  return {
    actorType: "user" as const,
    orgId,
    userId,
    scopes: WRITE_SCOPES,
    dimensionGrants: {},
  }
}

function kActor() {
  return knowledgeActorFromContext({
    orgId,
    userId,
    scopes: WRITE_SCOPES,
    dimensionGrants: {},
  })
}

function personalDoc(title: string) {
  return {
    documentScope: "personal",
    title,
    body: "body",
    collectionIds: [],
    tagNames: [],
    team: [],
    sensitivity: "internal",
    verifyNow: false,
  } as never
}

function frame(opts: { accumulated?: string[]; effectiveScope?: string[] }): RunContext {
  const accumulator = opts.accumulated === undefined ? undefined : createTurnScopeAccumulator()
  if (accumulator && opts.accumulated) accumulator.recordInjected(opts.accumulated)
  return {
    runId: "run-t29-knowledge",
    parentRunId: null,
    rootRunId: "run-t29-knowledge",
    nestingDepth: 0,
    ...(accumulator ? { turnScopeAccumulator: accumulator } : {}),
    ...(opts.effectiveScope ? { effectiveScope: opts.effectiveScope } : {}),
  }
}

/**
 * Build the knowledge app's rpc bridge the way execute-tool does: INSIDE the
 * turn's ALS frame. The sandbox then calls back into it with the frame lost,
 * which is exactly what the returned closure reproduces.
 */
function bridgeBuiltInTurn(
  tx: unknown,
  opts: {
    accumulated?: string[]
    effectiveScope?: string[]
    scopesBefore?: string[]
    callerScopes?: string[]
    noFrame?: boolean
  },
): Record<string, (p: string) => Promise<string>> {
  const build = () =>
    createRpcBridge(
      "knowledge",
      userId,
      orgId,
      tx as never,
      knowledgeManifest as never,
      opts.callerScopes,
      "user",
      undefined,
      {
        // A connector-origin create skips the collection-placement guard; the
        // scope tagging under test is independent of placement.
        callerApp: "calls",
        actor: {
          actorType: "user",
          userId,
          orgId,
          scopes: opts.callerScopes ?? [],
          dimensionGrants: {},
        } as never,
      },
    ) as Record<string, (p: string) => Promise<string>>
  if (opts.noFrame) return build()
  return runContextStore.run(frame(opts), () =>
    opts.scopesBefore ? runWithToolCallScopesBefore(opts.scopesBefore, build) : build(),
  )
}

describe("knowledge document requiredScopes write inheritance (D5)", () => {
  it("a knowledge document captured during a scope-tagged turn persists that turn's requiredScopes", async () => {
    const created = await withRlsContext(rls(), (tx) =>
      createKnowledgeDocument(tx, personalDoc("Tagged by the turn"), kActor(), [
        "mail:read",
        "tickets:read",
      ]),
    )
    expect(await readRequiredScopes(created.id)).toEqual(["mail:read", "tickets:read"])
  })

  it("an update UNIONS the new turn's scopes into the existing tag, never replacing it with less", async () => {
    const created = await withRlsContext(rls(), (tx) =>
      createKnowledgeDocument(tx, personalDoc("Union target"), kActor(), ["mail:read"]),
    )
    const afterSecondTurn = await withRlsContext(rls(), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: created.id, revision: created.revision, body: "second turn" } as never,
        kActor(),
        ["tickets:read"],
      ),
    )
    expect(await readRequiredScopes(created.id)).toEqual(["mail:read", "tickets:read"])

    // A human edit asserts [] and must not strip what earlier turns put there.
    await withRlsContext(rls(), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: created.id, revision: afterSecondTurn.revision, body: "human edit" } as never,
        kActor(),
        [],
      ),
    )
    expect(await readRequiredScopes(created.id)).toEqual(["mail:read", "tickets:read"])
  })

  it("a write with no requiredScopes argument is refused", async () => {
    await expect(
      withRlsContext(rls(), (tx) =>
        (createKnowledgeDocument as (...a: unknown[]) => Promise<unknown>)(
          tx,
          personalDoc("No scopes argument"),
          kActor(),
        ),
      ),
    ).rejects.toThrow(/requiredScopes/)
  })

  it("a sandbox create is tagged from the frame captured when the bridge was built", async () => {
    const created = await withRlsContext(rls(), async (tx) => {
      const bridge = bridgeBuiltInTurn(tx, {
        // The turn read mail; the create tool's own write scope is recorded
        // into the accumulator but is not a data read.
        accumulated: ["mail:read", "knowledge:documents:create"],
        scopesBefore: ["mail:read"],
        callerScopes: WRITE_SCOPES,
      })
      return JSON.parse(
        await bridge.knowledge_create!(JSON.stringify(personalDoc("Sandbox create"))),
      )
    })
    expect(await readRequiredScopes(created.id)).toEqual(["mail:read"])
  })

  it("a sandbox update unions the turn's scopes into the existing tag", async () => {
    const created = await withRlsContext(rls(), (tx) =>
      createKnowledgeDocument(tx, personalDoc("Sandbox union target"), kActor(), ["mail:read"]),
    )
    await withRlsContext(rls(), async (tx) => {
      const bridge = bridgeBuiltInTurn(tx, {
        accumulated: ["tickets:read"],
        scopesBefore: ["tickets:read"],
        callerScopes: WRITE_SCOPES,
      })
      return JSON.parse(
        await bridge.knowledge_update!(
          JSON.stringify({ id: created.id, revision: created.revision, body: "from the sandbox" }),
        ),
      )
    })
    expect(await readRequiredScopes(created.id)).toEqual(["mail:read", "tickets:read"])
  })

  it("a sandbox write from a turn whose scopes are unknown is refused, never written untagged", async () => {
    const before = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM app_knowledge.documents WHERE org_id = ${orgId}::uuid`,
      ),
    )[0]!.count
    await expect(
      withRlsContext(rls(), async (tx) => {
        // A frame with no accumulator, no effective scope and no caller scopes:
        // the turn's taint is unknowable.
        const bridge = bridgeBuiltInTurn(tx, {})
        return bridge.knowledge_create!(JSON.stringify(personalDoc("Unknowable turn")))
      }),
    ).rejects.toThrow(/scope_unknown|scope taint is unknown/)
    const after = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM app_knowledge.documents WHERE org_id = ${orgId}::uuid`,
      ),
    )[0]!.count
    expect(after).toBe(before)
  })

  it("a bridge built outside any turn writes the empty positive assertion", async () => {
    const created = await withRlsContext(rls(), async (tx) => {
      const bridge = bridgeBuiltInTurn(tx, { noFrame: true, callerScopes: WRITE_SCOPES })
      return JSON.parse(await bridge.knowledge_create!(JSON.stringify(personalDoc("No turn"))))
    })
    expect(await readRequiredScopes(created.id)).toEqual([])
  })
})
