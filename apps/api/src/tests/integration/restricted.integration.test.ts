// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who can see an agreement, at the data layer. The agreements app declares `sharedRows` on
// every table: with `org_access = 'none'` only the people on the agreement's list read its
// rows, whatever scope or grant a reader holds (`*` included), and the list itself is closed
// the same way. Registered through the real runtime, read under `liaison_rls`.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as dsql } from "drizzle-orm"
import { unzipSync } from "fflate"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { type EmailMessage, setSystemEmailProvider } from "~/infra/email"
import { ownerCanSeeEventEntity } from "~/infra/jobs/event-routine-gate"
import { deleteObject, getObjectBuffer } from "~/infra/storage/object-storage"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import {
  computeApprovalAttentionItems,
  RESTRICTED_DECISION_TITLE,
} from "~/modules/approvals/attention"
import { listApprovals } from "~/modules/approvals/list"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { keepRestrictedReaders } from "~/modules/attention/restricted-recipients"
import { followRestrictedAccess } from "~/modules/client-actions/restricted-follow"
import { buildOrgArchive } from "~/modules/export/org-archive/writer"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { restrictedScope } from "~/modules/permissions/restricted-scope"
import { sendMessage } from "~/modules/threads/message"
import { type AppCell, insertAppRow } from "~/seed/factories/app-tables"
import { seedAuditEntry, seedOrgRow } from "~/seed/factories/org/rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { insertClientAction } from "~/tests/security/portal-doors/fixture"
import agreementsManifest from "../../../../../bundled-apps/agreements/app.manifest.json"

const orgId = crypto.randomUUID()
const listed = crypto.randomUUID()
const member = crypto.randomUUID()
const admin = crypto.randomUUID()

const TABLES = [
  "agreements",
  "agreement_shares",
  "agreement_drafts",
  "agreement_versions",
  "signature_events",
  "evidence_packages",
] as const

function agreements() {
  return {
    ...agreementsManifest,
    _format: "manifest" as const,
    _firstParty: true,
    _bundlePath: new URL(
      `../../../../../bundled-apps/.source/agreements/${agreementsManifest.version}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Parameters<typeof registerApps>[0][number]
}

const reader = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: {},
})

/** Rows of each table this reader sees. */
async function seen(ctx: UserContext): Promise<Record<string, number>> {
  return withRlsContext(ctx, async (tx) => {
    const out: Record<string, number> = {}
    for (const t of TABLES) {
      const rows = (await tx.execute(
        dsql.raw(`SELECT count(*)::int AS n FROM app_agreements.${t}`),
      )) as unknown as Array<{ n: number }>
      out[t] = Number((rows as Array<{ n: number }>)[0]?.n ?? 0)
    }
    return out
  })
}

const READ = ["agreements:agreements:read", "agreements:evidence:read"]
let agreementId = ""
const packageId = crypto.randomUUID()

async function setOrgAccess(access: "none" | "viewer" | "editor") {
  await withPrivilegedDb(orgId, "test:agreement-access", async (tx) => {
    await tx.execute(
      dsql`UPDATE app_agreements.agreements SET org_access = ${access} WHERE id = ${agreementId}` as never,
    )
  })
}

beforeAll(async () => {
  await acquireTestLock()
  await seedOrgRow({ id: orgId, name: "Maison Accords", slug: `restricted-${orgId.slice(0, 8)}` })
  const { failedApps } = await registerApps([agreements()], orgId, { skipOrgRows: true })
  expect(failedApps).toEqual([])
  agreementId = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  await withPrivilegedDb(orgId, "test:agreement-rows", async (tx) => {
    const now = new Date().toISOString()
    const put = (table: string, row: Record<string, AppCell>) =>
      insertAppRow(tx, "agreements", table, { org_id: orgId, ...row })
    await put("agreements", {
      id: agreementId,
      number: "AG-2026-001",
      kind: "nda",
      title: "Closed agreement",
      org_access: "none",
    })
    await put("agreement_shares", { agreement_id: agreementId, user_id: listed, role: "editor" })
    await put("agreement_drafts", { agreement_id: agreementId })
    await put("agreement_versions", {
      id: versionId,
      agreement_id: agreementId,
      number: 1,
      frozen_at: now,
    })
    await put("signature_events", {
      version_id: versionId,
      client_action_id: crypto.randomUUID(),
      invited_email: "a@b.example",
      invited_by: "x",
      typed_name: "A B",
      capacity: "self",
      consent_words: "I sign",
      consent_lang: "en",
      level: "ses",
      document_sha256: "ab",
      signed_at: now,
    })
    await put("evidence_packages", {
      id: packageId,
      version_id: versionId,
      level: "ses",
      hash_alg: "sha-256",
      seal_version: 1,
      document_sha256: "ab",
      sealed_at: now,
    })
  })
}, 180_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`.catch(() => {})
  await releaseTestLock()
})

describe("who can see an agreement", () => {
  it("with org access none a member with the read scope, an admin holding every scope and an agent acting for them read zero rows from every table", async () => {
    await setOrgAccess("none")
    const zero = Object.fromEntries(TABLES.map((t) => [t, 0]))
    expect(await seen(reader(member, READ))).toEqual(zero)
    expect(await seen(reader(admin, ["*"]))).toEqual(zero)
    // An agent acting for a person reads with that person's id and the agent's own ceiling.
    expect(await seen(reader(admin, ["agreements:*"]))).toEqual(zero)
    const one = Object.fromEntries(TABLES.map((t) => [t, 1]))
    expect(await seen(reader(listed, READ))).toEqual(one)
  })

  it("a person removed from the list reads nothing; an open agreement reads normally", async () => {
    await withPrivilegedDb(orgId, "test:agreement-access", async (tx) => {
      await tx.execute(
        dsql`UPDATE app_agreements.agreement_shares SET removed_at = now() WHERE user_id = ${listed}` as never,
      )
    })
    expect((await seen(reader(listed, READ))).agreements).toBe(0)
    await setOrgAccess("viewer")
    const one = Object.fromEntries(TABLES.map((t) => [t, 1]))
    expect(await seen(reader(member, READ))).toEqual(one)
    // The scope still decides for an open agreement: no read scope, no rows.
    expect((await seen(reader(member, []))).agreements).toBe(0)
  })

  it("the evidence file holding every signer's device is read only with the device scope; the colleague copy with the evidence scope", async () => {
    await setOrgAccess("viewer")
    const fileOn = async (entityType: string) => {
      const id = crypto.randomUUID()
      await withSystemDb("test:evidence-file", (tx) =>
        tx.execute(dsql`
          INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                    size_bytes, storage_key)
          VALUES (${id}::uuid, ${orgId}::uuid, 'agreements', ${entityType}, ${packageId},
                  'evidence.zip', 'application/zip', 12, ${`${orgId}/evidence/${id}`})` as never),
      )
      return id
    }
    // Production builds the files row policy from the installed catalog; this app is
    // registered from its manifest, so the policy is built from the registry's parents.
    await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
    const colleague = await fileOn("evidence_package")
    const devices = await fileOn("evidence_devices")
    const visible = (ctx: UserContext) =>
      withRlsContext(ctx, async (tx) => {
        const rows = (await tx.execute(
          dsql`SELECT id::text AS id FROM kernel.files WHERE id IN (${colleague}::uuid, ${devices}::uuid)`,
        )) as unknown as Array<{ id: string }>
        return rows.map((r) => r.id).sort()
      })
    // Every file door reads kernel.files under the caller's context, so this is each door's answer.
    expect(await visible(reader(member, READ))).toEqual([colleague])
    expect(await visible(reader(member, [...READ, "agreements:evidence:devices"]))).toEqual(
      [colleague, devices].sort(),
    )
    expect(await visible(reader(member, ["agreements:evidence:devices"]))).toEqual([])
    expect(await visible(reader(admin, ["*"]))).toEqual([colleague, devices].sort())
    await rebuildFilesSelectPolicy()
  })
})

// Part 2. A person off the list finds no title, signer or count on any surface. The surfaces
// follow from three mechanisms, not from a filter each: RLS on the rows, the turn's restricted
// taint, and copies that follow the list. Each surface below names the mechanism that holds it
// and probes it; a new surface that shows an agreement is added to this list.
describe("every surface honours the list", () => {
  const world = {
    orgId: "",
    listed: "",
    admin: "",
    member: "",
    closed: "",
    room: "",
    action: "",
    discussion: "",
  }
  const NUMBER = "AG-2026-301"

  const held = async (userId: string): Promise<UserContext> => {
    const perms = await withSystemDb("restricted-surfaces-perms", (tx) =>
      loadEffectivePermissions(tx as never, userId, world.orgId),
    )
    return {
      actorType: "user",
      userId,
      orgId: world.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants ?? {},
      roles: perms.roles,
    }
  }
  const tool = async (userId: string, toolName: string, params: unknown, threadId?: string) => {
    const actor = await held(userId)
    const accumulator = createTurnScopeAccumulator({ orgId: world.orgId })
    const runId = crypto.randomUUID()
    const ctx = {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      effectiveScope: actor.scopes,
      turnScopeAccumulator: accumulator,
      humanTurn: true,
    } as unknown as RunContext
    return runContextStore.run(ctx, () =>
      executeToolCore({
        toolName,
        orgId: world.orgId,
        actor,
        params,
        ...(threadId ? { threadId } : {}),
        origin: "in-app-agent",
      } as never),
    ) as Promise<Record<string, unknown>>
  }
  const rlsCount = async (userId: string, query: string) => {
    const actor = await held(userId)
    return withRlsContext(actor, async (tx) => {
      const rows = (await tx.execute(dsql.raw(query))) as unknown as Array<{ n: number }>
      return Number(rows[0]?.n ?? 0)
    })
  }

  /** What `userId` sees of the closed agreement on each surface: a count, 0 meaning nothing. */
  const SURFACES: Array<{
    surface: string
    mechanism: string
    seen?: (u: string) => Promise<number>
  }> = [
    {
      surface: "search (the agreements search tool; the entity is never indexed)",
      mechanism: "row-level security",
      seen: async (u) =>
        JSON.stringify(await tool(u, "agreements:agreements_search", {})).includes(NUMBER) ? 1 : 0,
    },
    {
      surface: "A-03 counts (the Home load of the app)",
      mechanism: "row-level security",
      seen: async (u) => {
        const out = (await tool(u, "agreements:home_load", {})) as { data?: { total?: number } }
        return Number(out.data?.total ?? 0)
      },
    },
    {
      surface: "Home, notifications and attention",
      mechanism: "recipients follow the list",
      seen: async (u) =>
        (
          await keepRestrictedReaders(
            world.orgId,
            { app: "agreements", entity: "agreement", entityId: world.closed },
            [u],
          )
        ).length,
    },
    {
      surface: "routine runs",
      mechanism: "the routine owner gate reads the row under the owner's access",
      seen: async (u) =>
        (await ownerCanSeeEventEntity(await held(u), {
          app: "agreements",
          entity: "agreement",
          action: "signed",
          orgId: world.orgId,
          entityId: world.closed,
        }))
          ? 1
          : 0,
    },
    {
      surface: "threads, thread search and mentions",
      mechanism: "the restricted taint: a message stamped with the record is read by the list",
      seen: (u) =>
        rlsCount(
          u,
          `SELECT count(*)::int AS n FROM kernel.messages WHERE thread_id = '${world.room}' AND content LIKE '%${NUMBER}%'`,
        ),
    },
    {
      surface: "approvals list and feed",
      mechanism: "the restricted taint parks owner-routed to the person who asked",
      seen: async (u) => {
        const actor = await held(u)
        const rows = await withRlsContext(actor, (tx) =>
          listApprovals(tx as never, { orgId: world.orgId, userId: u, scopes: actor.scopes }),
        )
        return rows.filter((r) => JSON.stringify(r).includes(`(${NUMBER})`)).length
      },
    },
    {
      surface: "files parented to the agreement, versions, signature events and evidence",
      mechanism: "row-level security through the parent",
      seen: (u) =>
        rlsCount(
          u,
          `SELECT count(*)::int AS n FROM app_agreements.agreements WHERE id = '${world.closed}'`,
        ),
    },
    { surface: "activity", mechanism: "owed to the change-request task (the activity read)" },
    {
      surface: "audit search",
      mechanism:
        "a restrictive policy: what the audit log records about the record is read by its list",
      seen: (u) =>
        rlsCount(
          u,
          `SELECT count(*)::int AS n FROM kernel.audit_log WHERE entity_id = '${world.closed}'`,
        ),
    },
    {
      surface: "client_actions_list",
      mechanism: "client actions carry the list as visible_to, followed on every change",
      seen: (u) =>
        rlsCount(
          u,
          `SELECT count(*)::int AS n FROM kernel.client_actions WHERE id = '${world.action}'`,
        ),
    },
    {
      surface: "Knowledge",
      mechanism:
        "owed to the change-request task (the signed text's Knowledge copy, shared with the list)",
    },
    {
      surface: "entity discussions",
      mechanism: "an access change drops everyone but the changer from the discussion",
      seen: async (u) => {
        const rows = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.thread_participants
           WHERE thread_id = ${world.discussion}::uuid AND user_id = ${u}::uuid`
        return Number(rows[0]?.n ?? 0)
      },
    },
    { surface: "agent and user memory", mechanism: "owed: a memory write after a restricted read" },
    {
      surface: "MCP results",
      mechanism: "row-level security: an MCP call runs the same tool as the person",
      seen: async (u) => {
        const out = await executeToolCore({
          toolName: "agreements:agreements_search",
          orgId: world.orgId,
          actor: await held(u),
          params: {},
          origin: "mcp",
        } as never)
        return JSON.stringify(out).includes(NUMBER) ? 1 : 0
      },
    },
    {
      surface: "monitoring",
      mechanism: "owed to the evidence task: no incident is opened for a seal mismatch yet",
    },
    {
      surface: "org export",
      mechanism: "number and status only (its own test below: the archive is an admin's)",
    },
    {
      surface: "data subject export",
      mechanism:
        "owed: no section reads the agreements app yet; one that does names number and status only",
    },
    {
      surface: "portal",
      mechanism:
        "owed to the portal share and portal web tasks: no automatic share, open shares narrowed",
    },
    {
      surface: "mail previews",
      mechanism: "a request about the record carries a title naming nothing, to the asker only",
      seen: async (u) => {
        const items = await withRlsContext(await held(u), (tx) =>
          computeApprovalAttentionItems(tx as never, world.orgId, u),
        )
        return items.filter(
          (i) =>
            i.metadata?.toolName === "kernel:threads_reply" &&
            i.summary === RESTRICTED_DECISION_TITLE,
        ).length
      },
    },
    {
      surface: "While you were away",
      mechanism: "the request is owner-routed to the asker, so it passes on to nobody's away row",
      seen: async (u) => {
        const rows = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.approval_requests
           WHERE org_id = ${world.orgId}::uuid AND tool_name = 'kernel:threads_reply'
             AND status = 'pending' AND resource_owner_id = ${u}::uuid`
        return Number(rows[0]?.n ?? 0)
      },
    },
  ]

  beforeAll(async () => {
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    world.orgId = (await createTestOrg()).id
    world.listed = (await minimal.adminSession(world.orgId)).userId
    world.admin = (await minimal.session(world.orgId, { role: "admin" })).userId
    world.member = (await minimal.session(world.orgId, { role: "member" })).userId
    await ensureAppsForOrg(world.orgId)
    await initSandboxPool()
    await initWorkerPool()
    const m = {
      ...agreementsManifest,
      trusted: false,
      _format: "manifest" as const,
      _bundlePath: new URL(
        `../../../../../bundled-apps/agreements/${agreementsManifest.version}/bundle.js`,
        import.meta.url,
      ).pathname,
    } as unknown as Parameters<typeof registerApps>[0][number]
    const { failedApps } = await registerApps([m], world.orgId)
    expect(failedApps).toEqual([])
    await primeOrgApps(world.orgId, 0)
    await registerKernelAgentTools(world.orgId)
    world.closed = crypto.randomUUID()
    await withPrivilegedDb(world.orgId, "test:restricted-surfaces", async (tx) => {
      await insertAppRow(tx, "agreements", "agreements", {
        org_id: world.orgId,
        id: world.closed,
        number: NUMBER,
        kind: "nda",
        title: "Closed surface terms",
        org_access: "none",
      })
      await insertAppRow(tx, "agreements", "agreement_shares", {
        org_id: world.orgId,
        agreement_id: world.closed,
        user_id: world.listed,
        role: "editor",
      })
    })
    world.room = await minimal.thread(world.orgId, world.listed, {
      title: "Surfaces",
      participantIds: [world.admin, world.member],
    })
    // The list changed once the agreement had a link out and a discussion.
    const versionId = crypto.randomUUID()
    await withPrivilegedDb(world.orgId, "test:restricted-surfaces-version", (tx) =>
      insertAppRow(tx, "agreements", "agreement_versions", {
        org_id: world.orgId,
        id: versionId,
        agreement_id: world.closed,
        number: 1,
        frozen_at: new Date().toISOString(),
      }),
    )
    world.action = await insertClientAction(
      {
        orgId: world.orgId,
        clientA: { email: "signer@maison-roux.example", name: "Signer" },
      } as never,
      { company_id: null, target_id: versionId },
    )
    world.discussion = await minimal.thread(world.orgId, world.listed, {
      title: "Agreement discussion",
      participantIds: [world.admin, world.member],
    })
    await sql`UPDATE kernel.threads SET handle = ${`entity:agreements:agreement:${world.closed}`}
               WHERE id = ${world.discussion}::uuid`
    await followRestrictedAccess({
      app: "agreements",
      entity: "agreement",
      action: "access_changed",
      orgId: world.orgId,
      entityId: world.closed,
      actorId: world.listed,
      data: { org_access: "none", visible_to: [world.listed], version_ids: [versionId] },
    })
    // What the audit log recorded about it.
    await seedAuditEntry({
      orgId: world.orgId,
      actorId: world.listed,
      actorType: "user",
      app: "agreements",
      entityType: "agreement",
      entityId: world.closed,
      action: "agreement.update",
      changes: { number: NUMBER, title: "Closed surface terms" },
    })
    // What a turn of the person on the list leaves behind: a stamped message and a parked post.
    const scope = restrictedScope("agreements", "agreement", world.closed)
    const actor = await held(world.listed)
    await withRlsContext(actor, (tx) =>
      sendMessage(
        tx as never,
        {
          orgId: world.orgId,
          userId: world.listed,
          threadId: world.room,
          content: `Note on ${NUMBER}`,
          authorType: "user",
          requiredScopes: [scope],
        } as never,
      ),
    )
    const dm = await minimal.agentDm(world.orgId, world.listed)
    const accumulator = createTurnScopeAccumulator({ orgId: world.orgId })
    const runId = crypto.randomUUID()
    await runContextStore.run(
      {
        runId,
        parentRunId: null,
        rootRunId: runId,
        nestingDepth: 0,
        effectiveScope: actor.scopes,
        turnScopeAccumulator: accumulator,
        humanTurn: true,
      } as unknown as RunContext,
      async () => {
        const call = (toolName: string, params: unknown) =>
          executeToolCore({
            toolName,
            orgId: world.orgId,
            actor,
            params,
            threadId: dm,
            origin: "in-app-agent",
          } as never)
        await call("agreements:agreements_search", {})
        const parked = (await call("kernel:threads_reply", {
          threadId: world.room,
          content: `Summary (${NUMBER})`,
        })) as Record<string, unknown>
        expect(parked.blocked).toBeDefined()
      },
    )
  }, 300_000)

  afterAll(async () => {
    forgetOrgApps(world.orgId)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    await sql`DELETE FROM kernel.apps WHERE org_id = ${world.orgId}`.catch(() => {})
  })

  for (const s of SURFACES) {
    if (!s.seen) {
      it.todo(`${s.surface}: ${s.mechanism}`, () => {})
      continue
    }
    const seen = s.seen
    it(`${s.surface}: nothing for a member or an admin off the list, the record for the list (${s.mechanism})`, async () => {
      expect(await seen(world.member)).toBe(0)
      expect(await seen(world.admin)).toBe(0)
      expect(await seen(world.listed)).toBeGreaterThan(0)
    })
  }

  it("a person no longer on the list reads none of the messages or memory a turn stamped with the record, though they were on the list when it was written", async () => {
    const scope = restrictedScope("agreements", "agreement", world.closed)
    // Written while the member was on the list: the stamp's disclosure list names them.
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
      VALUES (${world.room}::uuid, ${world.orgId}::uuid, ${world.listed}::uuid,
              ${`Earlier note on ${NUMBER}`}, ARRAY[${scope}]::text[],
              ARRAY[${world.listed}, ${world.member}]::uuid[])
      RETURNING id`
    await minimal.agentDm(world.orgId, world.member)
    const [agent] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.agents WHERE org_id = ${world.orgId}::uuid AND kind = 'personal'
         AND owner_user_id = ${world.member}::uuid AND archived_at IS NULL LIMIT 1`
    const memoryId = crypto.randomUUID()
    await sql`
      INSERT INTO kernel.agent_memory (id, org_id, user_id, owner_agent_id, type, name, description,
                                       content, required_scopes, path)
      VALUES (${memoryId}::uuid, ${world.orgId}::uuid, ${world.member}::uuid, ${agent?.id ?? null}::uuid,
              'project', 'closed-terms', 'terms', ${`Prices of ${NUMBER}`}, ARRAY[${scope}]::text[],
              ${`project/closed-terms-${memoryId}.md`})`
    const count = (u: string, q: string) => rlsCount(u, q)
    expect(
      await count(world.member, `SELECT count(*)::int AS n FROM kernel.messages WHERE id = '${message?.id}'`),
    ).toBe(0)
    expect(
      await count(world.listed, `SELECT count(*)::int AS n FROM kernel.messages WHERE id = '${message?.id}'`),
    ).toBe(1)
    expect(
      await count(world.member, `SELECT count(*)::int AS n FROM kernel.agent_memory WHERE id = '${memoryId}'`),
    ).toBe(0)
    // Once the record is open to the organization again, the stamp hides nothing more.
    await withPrivilegedDb(world.orgId, "test:reopen", (tx) =>
      tx.execute(
        dsql`UPDATE app_agreements.agreements SET org_access = 'viewer' WHERE id = ${world.closed}::uuid` as never,
      ),
    )
    try {
      expect(
        await count(world.member, `SELECT count(*)::int AS n FROM kernel.agent_memory WHERE id = '${memoryId}'`),
      ).toBe(1)
    } finally {
      await withPrivilegedDb(world.orgId, "test:reclose", (tx) =>
        tx.execute(
          dsql`UPDATE app_agreements.agreements SET org_access = 'none' WHERE id = ${world.closed}::uuid` as never,
        ),
      )
      await sql`DELETE FROM kernel.messages WHERE id = ${message?.id ?? null}::uuid`
      await sql`DELETE FROM kernel.agent_memory WHERE id = ${memoryId}::uuid`
    }
  })

  it("a parked request about the restricted agreement reaches the person who asked under a title that names nothing of it", async () => {
    const actor = await held(world.listed)
    const items = await withRlsContext(actor, (tx) =>
      computeApprovalAttentionItems(tx as never, world.orgId, world.listed),
    )
    const mine = items.filter((i) => i.metadata?.toolName === "kernel:threads_reply")
    expect(mine.length).toBe(1)
    // The summary is what the push and the notification mail carry.
    expect(mine.map((i) => i.summary)).toEqual([RESTRICTED_DECISION_TITLE])
    expect(JSON.stringify(mine.map((i) => [i.summary, i.metadata?.baseTitle]))).not.toContain(
      NUMBER,
    )
    // Nobody else is asked.
    for (const other of [world.admin, world.member]) {
      const theirs = await withRlsContext(await held(other), (tx) =>
        computeApprovalAttentionItems(tx as never, world.orgId, other),
      )
      expect(theirs.filter((i) => i.metadata?.toolName === "kernel:threads_reply")).toEqual([])
    }
  })

  it("the org archive names the restricted agreement by number and status only, and holds none of its versions or list", async () => {
    const versionId = crypto.randomUUID()
    await withPrivilegedDb(world.orgId, "test:restricted-export", async (tx) => {
      await insertAppRow(tx, "agreements", "agreement_versions", {
        org_id: world.orgId,
        id: versionId,
        agreement_id: world.closed,
        number: 1,
        frozen_at: new Date().toISOString(),
      })
    })
    const res = await buildOrgArchive({ orgId: world.orgId, exportId: crypto.randomUUID() })
    try {
      const files = unzipSync(new Uint8Array(await getObjectBuffer(res.objectKey)))
      const rows = (name: string) =>
        new TextDecoder()
          .decode(files[`data/app_agreements.${name}.ndjson`] ?? new Uint8Array())
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      const [closed] = rows("agreements").filter((r) => r.id === world.closed)
      expect(closed?.number).toBe(NUMBER)
      expect(closed?.status).toBeDefined()
      expect(closed?.title).toBeNull()
      expect(closed?.acl_user_ids).toBeNull()
      expect(rows("agreement_versions").filter((r) => r.agreement_id === world.closed)).toEqual([])
      expect(rows("agreement_shares").filter((r) => r.agreement_id === world.closed)).toEqual([])
    } finally {
      await deleteObject(res.objectKey).catch(() => undefined)
    }
  })

  // An admin's one way in: only once every person on the list has been deactivated for 7 days.
  describe("claiming a restricted agreement", () => {
    const claimable = crypto.randomUUID()
    const claimableVersion = crypto.randomUUID()
    let claimableAction = ""
    let gone = ""
    let boss = { bearer: "", userId: "" }
    let plain = { bearer: "", userId: "" }
    const sent: EmailMessage[] = []
    const claim = (bearer: string) =>
      app.request(`/api/apps/agreements/agreements/${claimable}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      })
    const goneSince = async (interval: string) => {
      await sql`DELETE FROM kernel.audit_log WHERE org_id = ${world.orgId}::uuid
                 AND action = 'user.deactivate' AND entity_id = ${gone}`
      // The instant comes from the database's own clock.
      const [at] = await sql<{ ms: string }[]>`
        SELECT (extract(epoch FROM now() - ${interval}::interval) * 1000)::bigint::text AS ms`
      await seedAuditEntry({
        orgId: world.orgId,
        actorType: "user",
        action: "user.deactivate",
        entityType: "user",
        entityId: gone,
        timestamp: new Date(Number(at?.ms)),
      })
    }
    const bossSees = () =>
      rlsCount(
        boss.userId,
        `SELECT count(*)::int AS n FROM app_agreements.agreements WHERE id = '${claimable}'`,
      )

    beforeAll(async () => {
      gone = (await minimal.session(world.orgId, { role: "member" })).userId
      boss = await minimal.session(world.orgId, { role: "admin" })
      plain = await minimal.session(world.orgId, { role: "member" })
      await withPrivilegedDb(world.orgId, "test:restricted-claim", async (tx) => {
        await insertAppRow(tx, "agreements", "agreements", {
          org_id: world.orgId,
          id: claimable,
          number: "AG-2026-302",
          kind: "nda",
          title: "Terms of a team that left",
          org_access: "none",
        })
        await insertAppRow(tx, "agreements", "agreement_shares", {
          org_id: world.orgId,
          agreement_id: claimable,
          user_id: gone,
          role: "editor",
        })
        await insertAppRow(tx, "agreements", "agreement_versions", {
          org_id: world.orgId,
          id: claimableVersion,
          agreement_id: claimable,
          number: 1,
          frozen_at: new Date().toISOString(),
        })
      })
      claimableAction = await insertClientAction(
        {
          orgId: world.orgId,
          clientA: { email: "left@maison-roux.example", name: "Signer" },
        } as never,
        { company_id: null, target_id: claimableVersion, visible_to: [gone] },
      )
      setSystemEmailProvider({
        send: async (m) => {
          sent.push(m)
        },
        verify: async () => true,
      })
    })
    afterAll(() => setSystemEmailProvider(null))

    it("is refused, like an unknown id, while a person on the list is active", async () => {
      await goneSince("30 days")
      const res = await claim(boss.bearer)
      expect(res.status).toBe(404)
      expect(await bossSees()).toBe(0)
    })

    it("is refused at 6 days 23 hours after the last person on the list was deactivated, and allowed at 7 days", async () => {
      await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${gone}::uuid`
      await goneSince("6 days 23 hours")
      const early = await claim(boss.bearer)
      expect(early.status).toBe(404)
      expect(await bossSees()).toBe(0)
      await goneSince("7 days")
      const res = await claim(boss.bearer)
      expect(res.status).toBe(200)
      expect(await bossSees()).toBe(1)
      const [row] = await sql<{ by: string | null; at: Date | null; acl: string[] }[]>`
        SELECT claimed_by_user_id::text AS by, claimed_at AS at, acl_user_ids AS acl
          FROM app_agreements.agreements WHERE id = ${claimable}::uuid`
      expect(row?.by).toBe(boss.userId)
      expect(row?.at).not.toBeNull()
      expect([...(row?.acl ?? [])].sort()).toEqual([boss.userId, gone].sort())
      // The client actions of its versions follow the new list in the claim's own transaction.
      const [action] = await sql<{ to: string[] | null }[]>`
        SELECT visible_to::text[] AS to FROM kernel.client_actions WHERE id = ${claimableAction}::uuid`
      expect([...(action?.to ?? [])].sort()).toEqual([boss.userId, gone].sort())
      // Everyone ever on the list is told, and nobody else.
      const [goneUser] = await sql<{ email: string }[]>`
        SELECT email FROM kernel.users WHERE id = ${gone}::uuid`
      const notices = sent.filter((m) => m.template === "agreements.claimed")
      expect(notices.map((m) => m.to)).toEqual([goneUser?.email as string])
    })

    it("is refused for a member without the admin scope, whatever the dates", async () => {
      const res = await claim(plain.bearer)
      expect(res.status).toBe(403)
      // The database refuses it too, under that member's own context.
      const actor = await held(plain.userId)
      const out = await withRlsContext(actor, async (tx) => {
        const rows = (await tx.execute(
          dsql`SELECT kernel.restricted_claim(${claimable}::uuid) AS r`,
        )) as unknown as Array<{ r: { state: string } }>
        return rows[0]?.r.state
      })
      expect(out).toBe("not_allowed")
    })
  })
})
