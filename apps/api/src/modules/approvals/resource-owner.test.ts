// SPDX-License-Identifier: FSL-1.1-ALv2
// Ownership-aware approval routing + personal-mailbox RLS (privacy, two tiers).
//
// Tier 1: a gated mail tool targeting a PERSONAL account routes its approval to
// the owner alone (notify == [owner], resource_owner_id persisted), the owner
// can decide it WITHOUT mail:approve, and no other org member — including '*'
// holders — can see or decide it.
// Tier 2: app_mail rows belonging to a personal account are invisible to '*'
// holders under RLS; shared/org accounts keep team behavior; system contexts
// (sync) keep working.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { HTTPException } from "hono/http-exception"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { initEventBus } from "~/infra/events/event-bus"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { recordStarted, recordSucceeded } from "~/modules/approvals/handler-protocol"
import {
  effectiveVisibility,
  resolveApprovalResourceOwner,
} from "~/modules/approvals/resource-owner"
import {
  approvalResourceOwnerRegistry,
  resetAppRegistries,
  setDeclaredEmits,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { createApprovalRequestInBundle } from "~/modules/apps/execute-tool"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { setAccountVisibility } from "~/modules/mail/service"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const ORG = "00000000-0000-4000-8000-000000077101"
const OWNER = "00000000-0000-4000-8000-000000077102"
const ADMIN = "00000000-0000-4000-8000-000000077103"
const REQ = "00000000-0000-4000-8000-000000077104"
const THREAD = "00000000-0000-4000-8000-000000077105"
const ACC_PERSONAL = "00000000-0000-4000-8000-000000077110"
const ACC_SHARED = "00000000-0000-4000-8000-000000077111"
const ACC_PERSONAL_SHARED = "00000000-0000-4000-8000-000000077112"
const CONV_PERSONAL = "00000000-0000-4000-8000-000000077120"
const CONV_SHARED = "00000000-0000-4000-8000-000000077121"
const CONV_PERSONAL_SHARED = "00000000-0000-4000-8000-000000077122"
const MSG_PERSONAL = "00000000-0000-4000-8000-000000077130"

const ownerActor: UserContext = {
  actorType: "user",
  userId: OWNER,
  orgId: ORG,
  scopes: ["mail:conversations:read", "mail:accounts:write"],
  dimensionGrants: {},
}
const adminActor: UserContext = {
  actorType: "user",
  userId: ADMIN,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}
const requesterActor: UserContext = {
  actorType: "user",
  userId: REQ,
  orgId: ORG,
  scopes: ["mail:conversations:write"],
  dimensionGrants: {},
}

const SUMMARY = { kind: "mail:reply", title: "Reply draft", lines: ["To: someone"] }

async function insertAccount(id: string, ownerType: string, ownerId: string | null, email: string) {
  await sql.unsafe(
    `INSERT INTO app_mail.accounts
       (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
     VALUES ('${id}', '${ORG}', gen_random_uuid(), '${ownerType}',
             ${ownerId ? `'${ownerId}'` : "NULL"}, 'gmail', '${email}', 'idle')
     ON CONFLICT (id) DO NOTHING`,
  )
}

async function insertConversation(
  id: string,
  accountId: string,
  ownerType: string,
  ownerId: string | null,
) {
  await sql.unsafe(
    `INSERT INTO app_mail.conversations
       (id, org_id, account_id, owner_type, owner_id, external_thread_id, status,
        labels, is_read, is_starred, message_count)
     VALUES ('${id}', '${ORG}', '${accountId}', '${ownerType}',
             ${ownerId ? `'${ownerId}'` : "NULL"}, 'ext-${id}', 'open', '[]', false, false, 0)
     ON CONFLICT (id) DO NOTHING`,
  )
}

async function stageReply(conversationId: string): Promise<string> {
  return createApprovalRequestInBundle({
    orgId: ORG,
    threadId: THREAD,
    toolName: "mail:reply",
    toolParams: { conversationId, textBody: "private draft body" },
    requestedBy: REQ,
    summary: SUMMARY,
    appName: "mail",
    toolShortName: "reply",
    requesterCanApprove: false,
    origin: "in-app-agent",
    stepBundleId: null,
  })
}

async function approvalRow(id: string) {
  const [row] = await sql`
    SELECT notify_user_ids, resource_owner_id, status
    FROM kernel.approval_requests WHERE id = ${id}`
  return row as { notify_user_ids: string[]; resource_owner_id: string | null; status: string }
}

describe("personal-mailbox privacy (tiers 1 + 2)", () => {
  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    await acquireAppSchemaJsLock("app_tickets")
    try {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${ORG}, 'Resource Owner Org', 'resource-owner-org') ON CONFLICT DO NOTHING`
      for (const [id, email, name] of [
        [OWNER, "owner-ro@test.com", "Owner"],
        [ADMIN, "admin-ro@test.com", "Admin"],
        [REQ, "req-ro@test.com", "Requester"],
      ]) {
        await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
          VALUES (${id}, ${ORG}, ${email}, ${name}, 'active', 'hash') ON CONFLICT DO NOTHING`
      }
      // DB-side grants (RLS policies and eligibleApprovers read these).
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${ADMIN}, ${ORG}, '*') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${REQ}, ${ORG}, 'mail:conversations:write') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${OWNER}, ${ORG}, 'mail:conversations:read') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${THREAD}, ${ORG}, 'resource-owner-thread', 'agent_chat', ${REQ}) ON CONFLICT DO NOTHING`
      for (const uid of [OWNER, ADMIN, REQ]) {
        await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
          VALUES (${THREAD}, ${uid}, ${ORG}, 'member') ON CONFLICT DO NOTHING`
      }

      await initSandboxPool()
      initEventBus()
      setDeclaredEmits(
        "*",
        "kernel",
        new Set(["connected_account:create", "connected_account:disconnect"]),
      )
      await registerApps(
        [
          mailAppManifest as unknown as AppDescriptor,
          ticketsAppManifest as unknown as AppDescriptor,
        ],
        ORG,
      )

      await insertAccount(ACC_PERSONAL, "user", OWNER, "owner-personal@ro.test")
      await insertAccount(ACC_SHARED, "org", null, "support-shared@ro.test")
      await insertAccount(ACC_PERSONAL_SHARED, "user", OWNER, "owner-opted-shared@ro.test")
      await sql.unsafe(
        `UPDATE app_mail.accounts SET visibility = 'shared' WHERE id = '${ACC_PERSONAL_SHARED}'`,
      )
      await insertConversation(CONV_PERSONAL, ACC_PERSONAL, "user", OWNER)
      await insertConversation(CONV_SHARED, ACC_SHARED, "org", null)
      await insertConversation(CONV_PERSONAL_SHARED, ACC_PERSONAL_SHARED, "user", OWNER)
      await sql.unsafe(
        `INSERT INTO app_mail.messages
           (id, org_id, conversation_id, account_id, message_references, from_address,
            to_addresses, cc_addresses, bcc_addresses, labels, direction, raw_headers,
            owner_type, owner_id, is_read, is_starred)
         VALUES ('${MSG_PERSONAL}', '${ORG}', '${CONV_PERSONAL}', '${ACC_PERSONAL}', '[]',
                 '{"email":"x@y.z"}', '[]', '[]', '[]', '[]', 'inbound', '{}',
                 'user', '${OWNER}', false, false)
         ON CONFLICT (id) DO NOTHING`,
      )
    } catch (err) {
      await releaseAppSchemaJsLock("app_tickets")
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 60_000)

  afterAll(async () => {
    try {
      await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
      await sql.unsafe(`DELETE FROM app_mail.messages WHERE org_id = '${ORG}'`)
      await sql.unsafe(`DELETE FROM app_mail.conversations WHERE org_id = '${ORG}'`)
      await sql.unsafe(`DELETE FROM app_mail.accounts WHERE org_id = '${ORG}'`)
      await sql`DELETE FROM kernel.apps WHERE name IN ('mail', 'tickets')`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
      resetAppRegistries()
    } finally {
      await releaseAppSchemaJsLock("app_tickets")
      await releaseAppSchemaJsLock("app_mail")
    }
  })

  describe("effectiveVisibility", () => {
    it("derives from owner_type when no explicit visibility", () => {
      expect(effectiveVisibility({ owner_type: "user" })).toBe("personal")
      expect(effectiveVisibility({ owner_type: "org" })).toBe("shared")
      expect(effectiveVisibility({})).toBe("shared")
    })
    it("explicit visibility overrides owner_type", () => {
      expect(effectiveVisibility({ owner_type: "user", visibility: "shared" })).toBe("shared")
      expect(effectiveVisibility({ owner_type: "org", visibility: "personal" })).toBe("personal")
    })
  })

  describe("resolveApprovalResourceOwner", () => {
    it("manifest registration wires the mail resourceOwner declarations", () => {
      expect(approvalResourceOwnerRegistry.get([ORG, "mail", "reply"])).toBeTruthy()
      expect(approvalResourceOwnerRegistry.get([ORG, "mail", "forward"])).toBeTruthy()
      expect(approvalResourceOwnerRegistry.get([ORG, "mail", "compose"])).toBeTruthy()
    })
    it("resolves the owner for a personal-account conversation", async () => {
      const owner = await resolveApprovalResourceOwner(ORG, "mail", "reply", {
        conversationId: CONV_PERSONAL,
      })
      expect(owner).toBe(OWNER)
    })
    it("returns null for an org-account conversation", async () => {
      const owner = await resolveApprovalResourceOwner(ORG, "mail", "reply", {
        conversationId: CONV_SHARED,
      })
      expect(owner).toBeNull()
    })
    it("honors an explicit visibility='shared' override on a user-owned account", async () => {
      const owner = await resolveApprovalResourceOwner(ORG, "mail", "reply", {
        conversationId: CONV_PERSONAL_SHARED,
      })
      expect(owner).toBeNull()
    })
    it("resolves compose via accountId (self form)", async () => {
      const owner = await resolveApprovalResourceOwner(ORG, "mail", "compose", {
        accountId: ACC_PERSONAL,
      })
      expect(owner).toBe(OWNER)
    })
    it("returns null on missing param, unknown row, and undeclared tool", async () => {
      expect(await resolveApprovalResourceOwner(ORG, "mail", "reply", {})).toBeNull()
      expect(
        await resolveApprovalResourceOwner(ORG, "mail", "reply", {
          conversationId: "00000000-0000-4000-8000-0000000771ff",
        }),
      ).toBeNull()
      expect(
        await resolveApprovalResourceOwner(ORG, "mail", "archive", {
          conversationId: CONV_PERSONAL,
        }),
      ).toBeNull()
    })
    it("a `requester` declaration makes the requester the owner when the param matches (P3-T1)", async () => {
      approvalResourceOwnerRegistry.set([ORG, "mcp-manager", "add_connection"], {
        requester: { param: "ownershipScope", equals: "personal" },
      })
      try {
        expect(
          await resolveApprovalResourceOwner(
            ORG,
            "mcp-manager",
            "add_connection",
            { ownershipScope: "personal" },
            REQ,
          ),
        ).toBe(REQ)
        expect(
          await resolveApprovalResourceOwner(
            ORG,
            "mcp-manager",
            "add_connection",
            { ownershipScope: "org" },
            REQ,
          ),
        ).toBeNull()
        expect(
          await resolveApprovalResourceOwner(ORG, "mcp-manager", "add_connection", {}, REQ),
        ).toBeNull()
      } finally {
        approvalResourceOwnerRegistry.delete([ORG, "mcp-manager", "add_connection"])
      }
    })
  })

  describe("tier 1: approval routing + decide + RLS", () => {
    it("routes a personal-mailbox reply approval to the owner alone", async () => {
      const id = await stageReply(CONV_PERSONAL)
      const row = await approvalRow(id)
      expect(row.resource_owner_id).toBe(OWNER)
      expect(row.notify_user_ids).toEqual([OWNER])
      expect(row.notify_user_ids).not.toContain(ADMIN)
      expect(row.notify_user_ids).not.toContain(REQ)
    })

    it("keeps org-wide fan-out for a shared-account reply (regression)", async () => {
      const id = await stageReply(CONV_SHARED)
      const row = await approvalRow(id)
      expect(row.resource_owner_id).toBeNull()
      expect(row.notify_user_ids).toContain(REQ)
      expect(row.notify_user_ids).toContain(ADMIN)
    })

    it("hides a personal approval row from a '*' holder under RLS, shows it to owner and requester", async () => {
      const id = await stageReply(CONV_PERSONAL)
      const count = async (actor: UserContext) =>
        withRlsContext(actor, async (tx) => {
          const res = (await tx.execute(
            sqlFragment(`SELECT id FROM kernel.approval_requests WHERE id = '${id}'`),
          )) as unknown as { length?: number }
          return rowsOf(res).length
        })
      expect(await count(adminActor)).toBe(0)
      expect(await count(ownerActor)).toBe(1)
      expect(await count(requesterActor)).toBe(1)
    })

    it("lets the owner deny WITHOUT holding mail:approve; a '*' admin cannot even find it", async () => {
      const id = await stageReply(CONV_PERSONAL)
      // Admin holds '*' (which satisfies mail:approve) but is not owner/requester:
      // the RLS-scoped read 404s — the approval's existence is hidden.
      await expect(
        decideApproval({ orgId: ORG, requestId: id, actor: adminActor, decision: "deny" }),
      ).rejects.toThrow(ApprovalDecisionError)
      const denied = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: ownerActor,
        decision: "deny",
        reason: "not like this",
      })
      expect(denied.status).toBe("denied")
      expect(denied.decidedBy).toBe(OWNER)
    })

    it("lets the owner APPROVE without mail:approve (handler executes)", async () => {
      // Override the sandboxed mail:reply handler with a protocol-recording stub
      // so the approve flow executes host-side without a live mailbox.
      toolRegistry.set([ORG, "mail", "reply"], {
        appName: "mail",
        name: "reply",
        description: "test stub",
        requiredScopes: ["mail:conversations:write"],
        gated: true,
        handler: async () => {
          const [row] = await sql`
            SELECT id, decided_by FROM kernel.approval_requests
            WHERE org_id = ${ORG} AND status = 'approving'
            ORDER BY created_at DESC LIMIT 1`
          const ctx = {
            orgId: ORG,
            approvalRequestId: row.id,
            approvalDeciderId: row.decided_by,
            toolName: "mail:reply",
          }
          await withPrivilegedDb(ORG, "ro-test-start", (tx) => recordStarted(tx, ctx, "mail:reply"))
          await withPrivilegedDb(ORG, "ro-test-finish", (tx) =>
            recordSucceeded(tx, ctx, "mail:reply", { sent: true }),
          )
          return { sent: true }
        },
      } as any)
      const id = await stageReply(CONV_PERSONAL)
      const approved = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: ownerActor,
        decision: "approve",
      })
      expect(approved.status).toBe("approved")
      expect(approved.decidedBy).toBe(OWNER)
    })

    it("shared-account approvals stay decidable by an approve-scope holder (regression)", async () => {
      const id = await stageReply(CONV_SHARED)
      const denied = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: adminActor,
        decision: "deny",
      })
      expect(denied.status).toBe("denied")
    })
  })

  describe("tier 2: app_mail RLS personal restriction", () => {
    const selectIds = async (actor: Parameters<typeof withRlsContext>[0], query: string) =>
      withRlsContext(actor, async (tx) => rowsOf(await tx.execute(sqlFragment(query))))

    it("hides personal conversations, messages, and accounts from a '*' holder", async () => {
      const convs = await selectIds(
        adminActor,
        `SELECT id FROM app_mail.conversations WHERE org_id = '${ORG}'`,
      )
      const ids = convs.map((r: any) => r.id)
      expect(ids).not.toContain(CONV_PERSONAL)
      expect(ids).toContain(CONV_SHARED)
      expect(ids).toContain(CONV_PERSONAL_SHARED)

      const msgs = await selectIds(
        adminActor,
        `SELECT id FROM app_mail.messages WHERE id = '${MSG_PERSONAL}'`,
      )
      expect(msgs.length).toBe(0)

      const accts = await selectIds(
        adminActor,
        `SELECT id FROM app_mail.accounts WHERE id = '${ACC_PERSONAL}'`,
      )
      expect(accts.length).toBe(0)
    })

    it("keeps personal rows visible to the owner", async () => {
      const convs = await selectIds(
        ownerActor,
        `SELECT id FROM app_mail.conversations WHERE id = '${CONV_PERSONAL}'`,
      )
      expect(convs.length).toBe(1)
      const msgs = await selectIds(
        ownerActor,
        `SELECT id FROM app_mail.messages WHERE id = '${MSG_PERSONAL}'`,
      )
      expect(msgs.length).toBe(1)
    })

    it("keeps personal rows reachable by SYSTEM contexts (sync ingestion)", async () => {
      const rows = await selectIds(
        { actorType: "system", orgId: ORG, purpose: "job", scopes: ["mail:*"] } as any,
        `SELECT id FROM app_mail.conversations WHERE id = '${CONV_PERSONAL}'`,
      )
      expect(rows.length).toBe(1)
    })

    it("only the owner can flip their personal account's visibility", async () => {
      await expect(
        withRlsContext(adminActor, (tx) =>
          setAccountVisibility(tx as any, {
            orgId: ORG,
            accountId: ACC_PERSONAL,
            visibility: "shared",
          }),
        ),
      ).rejects.toThrow(HTTPException)
      const updated = await withRlsContext(ownerActor, (tx) =>
        setAccountVisibility(tx as any, {
          orgId: ORG,
          accountId: ACC_PERSONAL,
          visibility: "shared",
        }),
      )
      expect(updated.visibility).toBe("shared")
      // Flip back for other tests + prove the owner can re-privatize.
      const reverted = await withRlsContext(ownerActor, (tx) =>
        setAccountVisibility(tx as any, {
          orgId: ORG,
          accountId: ACC_PERSONAL,
          visibility: "personal",
        }),
      )
      expect(reverted.visibility).toBe("personal")
    })
  })
})

// ── tiny raw-SQL helpers (drizzle sql over an RlsClient) ──
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"

function sqlFragment(q: string) {
  return drizzleSql.raw(q)
}
function rowsOf(res: unknown): any[] {
  return extractRows<any>(res as never)
}
