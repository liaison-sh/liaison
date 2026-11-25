// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Staff's side of the client portal: inviting, sharing, ending a company's access,
// removing a person, resetting a second factor, the preview and the access log.
// Each door is driven through the service, the panel's routes or the tool itself,
// on the real roles.

import { afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { DEMO_WORLDS } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { PortalContextRefusedError, withPortalContext } from "~/db/portal-rls"
import { withRlsContext } from "~/db/rls"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { handleAuditSearch } from "~/modules/agent/tools/admin-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { primeOrgApps } from "~/modules/apps/org-apps"
import { createPortalSession, createSession } from "~/modules/auth/auth"
import { SessionRevocationTestAccess } from "~/modules/auth/session-revocation"
import { generateTotpSecret } from "~/modules/auth/totp"
import { deleteContact, updateContact } from "~/modules/contacts/service"
import { DemoOrgTestAccess, invalidateDemoMarker, visitorMarker } from "~/modules/demo/demo-org"
import {
  endPortalAccess,
  invitePortalPerson,
  PORTAL_INVITES_PER_HOUR,
  PortalAccessError,
  removePortalPerson,
  restorePortalAccess,
  setPortalShare,
} from "~/modules/portal/access"
import { PORTAL_REFRESH_COOKIE } from "~/modules/portal/auth-routes"
import {
  handlePortalAccessLog,
  handlePortalRemovePerson,
  portalShareSetParams,
  registerPortalTools,
} from "~/modules/portal/tools"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  adminContext,
  CaptureProvider,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
  insertClientAction,
  insertShare,
  memberContext,
  ORIGIN,
} from "./fixture"
import { dropReadsWorld, insertFile, insertTicket } from "./reads-world"

let w: DoorWorld
let previous: EmailProvider
const capture = new CaptureProvider()
let adminToken: string
const CLEAN = crypto.randomUUID()
const TAINTED = crypto.randomUUID()

const refusalCode = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (err: unknown) => (err instanceof PortalAccessError ? err.code : String(err)),
  )

const asAdmin = <T>(fn: Parameters<typeof withRlsContext<T>>[1]) =>
  withRlsContext(adminContext(w), fn)

const inviteKey = () => `portal:invite:hour:${w.orgId}`

/** A file on a ticket of the company, with the ticket's sensitivity. */
async function ticketFile(companyId: string, contactId: string, sensitivity = "internal") {
  const ticket = await insertTicket(w, {
    company_id: companyId,
    contact_id: contactId,
    sensitivity,
  })
  const file = await insertFile(w, { app: "tickets", entity_type: "ticket", entity_id: ticket.id })
  return { ticket: ticket.id, file }
}

beforeAll(async () => {
  await acquireTestLock()
  w = await createDoorWorld()
  previous = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  registerPortalTools(w.orgId)
  adminToken = (await createSession(w.admin.userId, w.orgId)).accessToken
  for (const [id, tainted] of [
    [CLEAN, false],
    [TAINTED, true],
  ] as const) {
    await sql.unsafe(
      insertSql("kernel.threads", {
        id,
        org_id: w.orgId,
        handle: `portal-${id.slice(0, 8)}`,
        type: "agent_chat",
        created_by: w.admin.userId,
        tainted,
      }),
    )
    await sql.unsafe(
      insertSql("kernel.thread_participants", {
        thread_id: id,
        user_id: w.admin.userId,
        org_id: w.orgId,
      }),
    )
  }
})

afterAll(async () => {
  setSystemEmailProvider(previous)
  toolRegistry.deleteByPrefix([w.orgId])
  await redis.del(inviteKey())
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${w.orgId}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${w.orgId}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${w.orgId}`
  await dropReadsWorld(w)
  // Invited contacts name their inviter as owner; the world drops users before contacts.
  await sql`UPDATE kernel.contacts SET owner_user_id = NULL WHERE org_id = ${w.orgId}`
  await dropDoorWorld(w)
  await releaseTestLock()
})

beforeEach(async () => {
  capture.sent = []
  await redis.del(inviteKey())
})

/** A turn a person typed, with its own record of the scoped data it read (none yet). */
const humanFrame = () => ({
  runId: "r",
  parentRunId: null,
  rootRunId: "r",
  nestingDepth: 0,
  humanTurn: true,
  turnScopeAccumulator: createTurnScopeAccumulator(),
})

async function callTool(toolName: string, threadId: string, params: Record<string, unknown>) {
  // As every entry point does: the portal tools follow the companies switch, read from here.
  await primeOrgApps(w.orgId)
  return executeTool({
    toolName: `kernel:${toolName}`,
    orgId: w.orgId,
    actor: adminContext(w),
    params,
    threadId,
    origin: "in-app-agent",
  })
}

describe("inviting a client", () => {
  it("NT-29 one address reaches one company's portal: a second company's invite is refused", async () => {
    const email = `twice-${w.orgId.slice(0, 8)}@doors.example.com`
    const first = await asAdmin((tx) =>
      invitePortalPerson({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        companyId: w.companyA,
        email,
        name: "Paule Deux",
      }),
    )
    expect(first.userId).toBeTruthy()
    const [row] = extractRows<{ user_type: string; company_id: string }>(
      await sql.unsafe(`SELECT user_type, company_id FROM kernel.users WHERE id = $1`, [
        first.userId,
      ]),
    )
    expect(row).toEqual({ user_type: "external", company_id: w.companyA })
    expect(capture.sent.map((m) => m.template)).toEqual(["portal.invite"])
    // The invitation holds no secret: the person asks the portal for their link.
    expect(capture.sent[0]?.text ?? "").not.toMatch(/#c=|&t=/)
    const again = (companyId: string) =>
      refusalCode(
        asAdmin((tx) =>
          invitePortalPerson({
            orgId: w.orgId,
            actorId: w.admin.userId,
            db: tx,
            companyId,
            email,
            name: "Paule Deux",
          }),
        ),
      )
    expect(await again(w.companyB)).toBe("PORTAL_EMAIL_IN_USE")
    expect(await again(w.companyA)).toBe("EMAIL_IS_PORTAL_USER")
    expect(
      await refusalCode(
        asAdmin((tx) =>
          invitePortalPerson({
            orgId: w.orgId,
            actorId: w.admin.userId,
            db: tx,
            companyId: w.companyA,
            email: w.member.email,
            name: "A member",
          }),
        ),
      ),
    ).toBe("PORTAL_EMAIL_IS_STAFF")
  })

  it("NT-30 the portal invite refuses a staff address, active or deactivated, and makes no client row", async () => {
    const users = async () =>
      (
        await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.users WHERE org_id = ${w.orgId}`
      )[0]?.n
    const before = await users()
    const invite = (email: string) =>
      refusalCode(
        asAdmin((tx) =>
          invitePortalPerson({
            orgId: w.orgId,
            actorId: w.admin.userId,
            db: tx,
            companyId: w.companyA,
            email,
            name: "A colleague",
          }),
        ),
      )
    expect(await invite(w.member.email)).toBe("PORTAL_EMAIL_IS_STAFF")
    expect(await invite(w.member.email.toUpperCase())).toBe("PORTAL_EMAIL_IS_STAFF")
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${w.member.userId}`
    try {
      expect(await invite(w.member.email)).toBe("PORTAL_EMAIL_IS_STAFF")
    } finally {
      await sql`UPDATE kernel.users SET status = 'active' WHERE id = ${w.member.userId}`
    }
    expect(await users()).toBe(before)
    expect(capture.sent).toEqual([])
  })

  it("one address, two signers: ending one person's access leaves the other's link open", async () => {
    const email = `shared-${w.orgId.slice(0, 8)}@doors.example.com`
    const person = await asAdmin((tx) =>
      invitePortalPerson({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        companyId: w.companyA,
        email,
        name: "Anne Shared",
      }),
    )
    const target = crypto.randomUUID()
    const link = (invited_name: string, target_id = target) =>
      insertClientAction(w, {
        company_id: w.companyA,
        target_id,
        invited_email: email,
        invited_name,
      })
    const anne = await link("Anne Shared")
    const jean = await link("Jean Shared")
    // Alone on another document, under another spelling: hers.
    const alone = await link("A. Shared", crypto.randomUUID())
    await asAdmin((tx) =>
      removePortalPerson({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        userId: person.userId,
      }),
    )
    const rows = (await sql.unsafe(
      `SELECT id, revoke_reason FROM kernel.client_actions WHERE id = ANY($1)`,
      [[anne, jean, alone]],
    )) as unknown as Array<{ id: string; revoke_reason: string | null }>
    const reason = (id: string) => rows.find((r) => r.id === id)?.revoke_reason ?? null
    expect([reason(anne), reason(jean), reason(alone)]).toEqual([
      "access_ended",
      null,
      "access_ended",
    ])
  })

  it("NT-29 moving a person to another company: removed from the first, invited to the second, old sessions end and nothing carries over", async () => {
    const email = `mover-${w.orgId.slice(0, 8)}@doors.example.com`
    const invite = (companyId: string) =>
      asAdmin((tx) =>
        invitePortalPerson({
          orgId: w.orgId,
          actorId: w.admin.userId,
          db: tx,
          companyId,
          email,
          name: "Mover Client",
        }),
      )
    const first = await invite(w.companyA)
    const old = await createPortalSession(first.userId, w.orgId)
    await asAdmin((tx) =>
      removePortalPerson({ orgId: w.orgId, actorId: w.admin.userId, db: tx, userId: first.userId }),
    )
    // The contact made for company A stays A's; company B gets its own contact.
    const second = await refusalCode(invite(w.companyB))
    expect(second).toBe("CONTACT_NOT_THIS_COMPANY")
    await asAdmin((tx) =>
      updateContact(tx, {
        orgId: w.orgId,
        userId: w.admin.userId,
        contactId: first.contactId,
        updates: { companyId: w.companyB },
      }),
    )
    const moved = await invite(w.companyB)
    expect(moved.userId).toBe(first.userId)
    const oldRead = await app.request("/api/portal/me", {
      headers: { Authorization: `Bearer ${old.accessToken}` },
    })
    expect(oldRead.status).toBe(401)
    const fresh = await createPortalSession(moved.userId, w.orgId)
    const now = await app.request("/api/portal/me", {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    })
    expect(now.status).toBe(200)
    const company = await withPortalContext({ orgId: w.orgId, userId: moved.userId }, async (tx) =>
      extractRows<{ company_id: string }>(
        await tx.execute(drizzleSql`SELECT company_id FROM portal.me`),
      ).map((r) => r.company_id),
    )
    expect(company).toEqual([w.companyB])
    // Nothing read in the first company comes along: no notice read, no sign-in time.
    const [row] = extractRows<{
      company_id: string
      notice_ack_at: string | null
      last_sign_in_at: string | null
    }>(
      await sql.unsafe(
        `SELECT company_id, notice_ack_at, last_sign_in_at FROM kernel.portal_people WHERE user_id = $1`,
        [moved.userId],
      ),
    )
    expect(row).toEqual({ company_id: w.companyB, notice_ack_at: null, last_sign_in_at: null })
  })

  it("NT-61 the fiftieth invitation in an hour goes, the next is refused; an agent's always parks", async () => {
    await redis.set(inviteKey(), String(PORTAL_INVITES_PER_HOUR - 1), "EX", 3600)
    const invite = (n: number) =>
      refusalCode(
        asAdmin((tx) =>
          invitePortalPerson({
            orgId: w.orgId,
            actorId: w.admin.userId,
            db: tx,
            companyId: w.companyB,
            email: `flood-${n}-${w.orgId.slice(0, 8)}@doors.example.com`,
            name: `Flood ${n}`,
          }),
        ),
      )
    expect(await invite(50)).toBe("ok")
    expect(await invite(51)).toBe("PORTAL_INVITE_LIMIT")
    const tool = toolRegistry.get([w.orgId, "kernel", "portal_invite"])
    expect(tool?.gated).toBe(true)
    expect(tool?.noAutoApprove).toBe(true)
    const res = await runContextStore.run(humanFrame(), () =>
      callTool("portal_invite", CLEAN, {
        company_id: w.companyB,
        email: `agent-${w.orgId.slice(0, 8)}@doors.example.com`,
        name: "Agent Asked",
      }),
    )
    expect(res.blocked?.approvalRequestId).toBeDefined()
    // The card names the company, never its id.
    const [card] = (await sql`
      SELECT summary FROM kernel.approval_requests WHERE id = ${res.blocked?.approvalRequestId ?? ""}`) as unknown as [
      { summary: { title: string; lines: string[] } },
    ]
    expect(card.summary.title).toBe("Invite Agent Asked to Maison Beta's client portal")
    expect(JSON.stringify(card.summary)).not.toContain(w.companyB)
  })

  it("an agent's invitation of someone already on the company's portal answers that and stages no second card", async () => {
    const email = `already-${w.orgId.slice(0, 8)}@doors.example.com`
    await asAdmin((tx) =>
      invitePortalPerson({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        companyId: w.companyB,
        email,
        name: "Already Here",
      }),
    )
    const [{ n: before }] = (await sql`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${w.orgId}`) as unknown as [
      { n: number },
    ]
    const refused = await runContextStore
      .run(humanFrame(), () =>
        callTool("portal_invite", CLEAN, { company_id: w.companyB, email, name: "Already Here" }),
      )
      .then(
        () => null,
        (err: Error & { code?: string }) => err,
      )
    expect(refused?.code).toBe("EMAIL_IS_PORTAL_USER")
    expect(refused?.message).toContain("already invited")
    expect(refused?.message).toContain("Already Here")
    const [{ n: after }] = (await sql`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${w.orgId}`) as unknown as [
      { n: number },
    ]
    expect(after).toBe(before)
  })

  it("refuses on a demo box, which sends no mail", async () => {
    const was = env.LIAISON_DEMO_MODE
    ;(env as { LIAISON_DEMO_MODE: boolean }).LIAISON_DEMO_MODE = true
    try {
      expect(
        await refusalCode(
          asAdmin((tx) =>
            invitePortalPerson({
              orgId: w.orgId,
              actorId: w.admin.userId,
              db: tx,
              companyId: w.companyB,
              email: `demo-${w.orgId.slice(0, 8)}@doors.example.com`,
              name: "Demo",
            }),
          ),
        ),
      ).toBe("NO_MAIL_ON_DEMO")
    } finally {
      ;(env as { LIAISON_DEMO_MODE: boolean }).LIAISON_DEMO_MODE = was
    }
  })
})

describe("a client's portal in each demo world's workspace on a demo box", () => {
  for (const world of DEMO_WORLDS) {
    it(`a ${world} workspace refuses an invitation, and its staff preview of the portal still works`, async () => {
      const was = env.LIAISON_DEMO_MODE
      ;(env as { LIAISON_DEMO_MODE: boolean }).LIAISON_DEMO_MODE = true
      DemoOrgTestAccess.prime(w.orgId, visitorMarker(1, new Date(), undefined, { worldId: world }))
      try {
        expect(
          await refusalCode(
            asAdmin((tx) =>
              invitePortalPerson({
                orgId: w.orgId,
                actorId: w.admin.userId,
                db: tx,
                companyId: w.companyB,
                email: `demo-${world}-${w.orgId.slice(0, 8)}@doors.example.com`,
                name: "Demo",
              }),
            ),
          ),
        ).toBe("NO_MAIL_ON_DEMO")
        const res = await get(
          `/api/contacts/companies/${w.companyB}/portal/preview/${w.clientB.userId}`,
          adminToken,
        )
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          data: { signedInWouldSee: Record<string, unknown> | null }
        }
        expect(body.data.signedInWouldSee?.me).toBeDefined()
      } finally {
        ;(env as { LIAISON_DEMO_MODE: boolean }).LIAISON_DEMO_MODE = was
        DemoOrgTestAccess.prime(w.orgId, null)
        await invalidateDemoMarker(w.orgId)
      }
    })
  }
})

describe("what a share may point at", () => {
  it("NT-70 another company's file is refused, for a person and an agent, and this company's opens", async () => {
    const theirs = (await ticketFile(w.companyB, w.clientB.contactId)).file
    const restricted = (await ticketFile(w.companyA, w.clientA.contactId, "restricted")).file
    const { ticket, file: ours } = await ticketFile(w.companyA, w.clientA.contactId)
    const share = (objectId: string) =>
      refusalCode(
        asAdmin((tx) =>
          setPortalShare({
            orgId: w.orgId,
            actorId: w.admin.userId,
            db: tx,
            scopes: ["*"],
            companyId: w.companyA,
            kind: "file",
            objectId,
            open: true,
          }),
        ),
      )
    expect(await share(theirs)).toBe("SHARE_NOT_THIS_COMPANY")
    expect(await share(restricted)).toBe("SHARE_NOT_THIS_COMPANY")
    expect(await share(crypto.randomUUID())).toBe("SHARE_NOT_THIS_COMPANY")
    expect(await share(ours)).toBe("ok")
    const allowed = () =>
      withPortalContext(
        { orgId: w.orgId, userId: w.clientA.userId },
        async (tx) =>
          extractRows<{ ok: boolean }>(
            await tx.execute(drizzleSql`SELECT portal.file_allowed(${ours}::uuid) AS ok`),
          )[0]?.ok,
      )
    expect(await allowed()).toBe(true)
    // The parent turns restricted later: the share stays open, the file no longer reads.
    await sql.unsafe(`UPDATE app_tickets.tickets SET sensitivity = 'restricted' WHERE id = $1`, [
      ticket,
    ])
    expect(await allowed()).toBe(false)
    const tool = toolRegistry.get([w.orgId, "kernel", "portal_share_set"])
    expect(tool?.gated).toBe(true)
    expect(tool?.noAutoApprove).toBe(true)
    const parked = await runContextStore.run(humanFrame(), () =>
      callTool("portal_share_set", CLEAN, {
        company_id: w.companyA,
        kind: "file",
        object_id: theirs,
        open: true,
      }),
    )
    expect(parked.blocked?.approvalRequestId).toBeDefined()
    const open = extractRows<{ object_id: string }>(
      await sql.unsafe(
        `SELECT object_id FROM kernel.portal_shares WHERE company_id = $1 AND kind = 'file' AND closed_at IS NULL`,
        [w.companyA],
      ),
    ).map((r) => r.object_id)
    expect(open).toContain(ours)
    expect(open).not.toContain(theirs)
  })

  it("NT-39 the share tool refuses a kind for notes, discussions, agents, routines, cost or margin and writes nothing", async () => {
    const shares = async () =>
      (
        await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.portal_shares WHERE org_id = ${w.orgId}`
      )[0]?.n
    const before = await shares()
    for (const kind of ["notes", "threads", "agents", "routines", "cost", "margin", "task_time"]) {
      expect(
        portalShareSetParams.safeParse({ company_id: w.companyA, kind, open: true }).success,
        kind,
      ).toBe(false)
      const outcome = await runContextStore
        .run(humanFrame(), () =>
          callTool("portal_share_set", CLEAN, { company_id: w.companyA, kind, open: true }),
        )
        .then(
          (r) => ({ blocked: (r as { blocked?: unknown }).blocked }),
          () => ({ blocked: undefined }),
        )
      expect({ kind, parked: Boolean(outcome.blocked) }).toEqual({ kind, parked: false })
    }
    expect(await shares()).toBe(before)
  })

  it("a named person must be on this company's portal", async () => {
    expect(
      await refusalCode(
        asAdmin((tx) =>
          setPortalShare({
            orgId: w.orgId,
            actorId: w.admin.userId,
            db: tx,
            scopes: ["*"],
            companyId: w.companyA,
            kind: "invoices",
            open: true,
            onlyUserIds: [w.clientB.userId],
          }),
        ),
      ),
    ).toBe("SHARE_NOT_THIS_COMPANY")
  })
})

describe("closing tools never run from outside text", () => {
  it("NT-71 an injected 'close our portal and erase our accounts' in a tainted turn or a routine closes nothing", async () => {
    const before = await sql.unsafe(`SELECT portal_ended_at FROM kernel.companies WHERE id = $1`, [
      w.companyB,
    ])
    // A person's clean typed turn still parks the end of access and the erasure: neither can be undone.
    for (const [name, params] of [
      ["portal_end_access", { company_id: w.companyB }],
      ["portal_remove_person", { user_id: w.clientB.userId, erase: true }],
    ] as const) {
      const clean = await runContextStore.run(humanFrame(), () => callTool(name, CLEAN, params))
      expect(clean.blocked?.approvalRequestId).toBeDefined()
      const tainted = await runContextStore.run(humanFrame(), () => callTool(name, TAINTED, params))
      expect(tainted.blocked).toBeDefined()
      const routine = await runContextStore.run(
        { ...humanFrame(), humanTurn: undefined, routineId: "rt", background: true },
        () => callTool(name, CLEAN, params),
      )
      expect(routine.blocked).toBeDefined()
    }
    // Removing without erasure: a routine and a tainted turn park; a person's clean turn runs.
    const params = { user_id: w.clientB.userId, erase: false }
    const routine = await runContextStore.run(
      { ...humanFrame(), humanTurn: undefined, routineId: "rt", background: true },
      () => callTool("portal_remove_person", CLEAN, params),
    )
    expect(routine.blocked).toBeDefined()
    const tainted = await runContextStore.run(humanFrame(), () =>
      callTool("portal_remove_person", TAINTED, params),
    )
    expect(tainted.blocked).toBeDefined()
    const [stillThere] = extractRows<{ removed_at: string | null; status: string }>(
      await sql.unsafe(
        `SELECT p.removed_at, u.status FROM kernel.portal_people p JOIN kernel.users u ON u.id = p.user_id WHERE p.user_id = $1`,
        [w.clientB.userId],
      ),
    )
    expect(stillThere).toEqual({ removed_at: null, status: "active" })
    expect(
      await sql.unsafe(`SELECT portal_ended_at FROM kernel.companies WHERE id = $1`, [w.companyB]),
    ).toEqual(before)
    for (const name of [
      "portal_end_access",
      "portal_remove_person",
      "portal_invite",
      "portal_share_set",
    ]) {
      expect(toolRegistry.get([w.orgId, "kernel", name])?.externalEffect).toBe(true)
    }
  })
})

describe("ending a company's access", () => {
  it("NT-22 ends at once: reads refused, sessions gone, links withdrawn, shares closed; giving access again restores none of it", async () => {
    const session = await createPortalSession(w.clientA.userId, w.orgId)
    const share = await insertShare(w, { company_id: w.companyA, kind: "requests" })
    const action = await insertClientAction(w, { company_id: w.companyA })
    const before = await app.request("/api/portal/me", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
    expect(before.status).toBe(200)

    const res = await app.request(`/api/contacts/companies/${w.companyA}/portal/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "contract over" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { signedOut: number; cancelledLinks: number } }
    expect(body.data.signedOut).toBeGreaterThanOrEqual(2)
    expect(body.data.cancelledLinks).toBeGreaterThanOrEqual(1)

    const after = await app.request("/api/portal/me", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
    expect(after.status).toBe(401)
    await expect(
      withPortalContext({ orgId: w.orgId, userId: w.clientA.userId }, async (tx) =>
        tx.execute(drizzleSql`SELECT 1`),
      ),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
    const [state] = extractRows<{ sessions: number; share_closed: boolean; reason: string | null }>(
      await sql.unsafe(
        `SELECT (SELECT count(*)::int FROM kernel.sessions s JOIN kernel.users u ON u.id = s.user_id
                  WHERE u.company_id = $1) AS sessions,
                (SELECT closed_at IS NOT NULL FROM kernel.portal_shares WHERE id = $2) AS share_closed,
                (SELECT revoke_reason FROM kernel.client_actions WHERE id = $3) AS reason`,
        [w.companyA, share, action],
      ),
    )
    expect(state).toEqual({ sessions: 0, share_closed: true, reason: "access_ended" })

    // Giving access again: people may sign in anew, nothing else comes back.
    await asAdmin((tx) =>
      restorePortalAccess({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        companyId: w.companyA,
      }),
    )
    const old = await app.request("/api/portal/me", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
    expect(old.status).toBe(401)
    const [restored] = extractRows<{ open: number; revoked: boolean; ended: string | null }>(
      await sql.unsafe(
        `SELECT (SELECT count(*)::int FROM kernel.portal_shares WHERE company_id = $1 AND closed_at IS NULL) AS open,
                (SELECT revoked_at IS NOT NULL FROM kernel.client_actions WHERE id = $2) AS revoked,
                (SELECT portal_ended_at FROM kernel.companies WHERE id = $1) AS ended`,
        [w.companyA, action],
      ),
    )
    expect(restored).toEqual({ open: 0, revoked: true, ended: null })
    const fresh = await createPortalSession(w.clientA.userId, w.orgId)
    const now = await app.request("/api/portal/me", {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    })
    expect(now.status).toBe(200)
  })

  it("a member without the portal admin scope cannot end access", async () => {
    const token = (await createSession(w.member.userId, w.orgId)).accessToken
    const res = await app.request(`/api/contacts/companies/${w.companyB}/portal/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })
})

/** A role holding exactly these scopes, given to the world's member. */
async function grantMember(scopes: string[]): Promise<void> {
  const role = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.roles", { id: role, org_id: w.orgId, name: `member-${role.slice(0, 8)}` }),
  )
  for (const scope of scopes) {
    await sql.unsafe(insertSql("kernel.role_scope_grants", { role_id: role, scope }))
  }
  await sql.unsafe(
    insertSql("kernel.user_roles", { user_id: w.member.userId, role_id: role, org_id: w.orgId }),
  )
}

const get = (path: string, token: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } })

describe("staff's reads of the portal", () => {
  it("NT-40 the audit search tool and the access log tool give no portal row without the portal log scope", async () => {
    await sql.unsafe(
      insertSql("kernel.audit_log", {
        org_id: w.orgId,
        actor_type: "external",
        actor_id: w.clientB.userId,
        app: "portal",
        action: "portal.sign_in",
        metadata: JSON.stringify({ companyId: w.companyB }),
      }),
    )
    await grantMember(["kernel:audit:read"])
    const search = await handleAuditSearch(
      { limit: 200 },
      { orgId: w.orgId, userId: w.member.userId },
    )
    expect(search.entries.filter((e) => e.app === "portal")).toEqual([])
    const log = (scopes: string[]) =>
      withRlsContext(memberContext(w, scopes), (tx) =>
        handlePortalAccessLog(
          { company_id: w.companyB, limit: 50 },
          {
            orgId: w.orgId,
            userId: w.member.userId,
            db: tx,
          },
        ),
      )
    expect((await log(["kernel:audit:read"])).items).toEqual([])
    expect((await log(["kernel:portal:logs"])).items.map((r) => r.action)).toEqual([
      "portal.sign_in",
    ])
  })

  it("NT-54 the preview is GET only, needs the portal admin scope, writes one staff row and none as the client", async () => {
    const adminRows = () =>
      sql.unsafe(
        `SELECT actor_type::text AS t, count(*)::int AS n FROM kernel.audit_log
          WHERE org_id = $1 AND entity_id = $2 GROUP BY 1 ORDER BY 1`,
        [w.orgId, w.clientB.userId],
      )
    // The member may read and write contacts, so only the portal scope refuses them.
    await grantMember(["kernel:contacts:read", "kernel:contacts:write"])
    const before = await adminRows()
    const path = `/api/contacts/companies/${w.companyB}/portal/preview/${w.clientB.userId}`
    const res = await get(path, adminToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { signedInWouldSee: Record<string, unknown> | null }
    }
    expect(body.data.signedInWouldSee?.me).toBeDefined()
    const post = await app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(post.status).toBe(404)
    const memberToken = (await createSession(w.member.userId, w.orgId)).accessToken
    expect((await get(path, memberToken)).status).toBe(403)
    // Another company's person through this company's path: nothing.
    expect(
      (
        await get(
          `/api/contacts/companies/${w.companyA}/portal/preview/${w.clientB.userId}`,
          adminToken,
        )
      ).status,
    ).toBe(404)
    const after = await adminRows()
    const count = (rows: unknown, t: string) =>
      (rows as Array<{ t: string; n: number }>).find((r) => r.t === t)?.n ?? 0
    expect(count(after, "user") - count(before, "user")).toBe(1)
    expect(count(after, "external")).toBe(count(before, "external"))
  })

  it("NT-37 the panel's preview reads through the portal's own reads: a share opened shows, closed it is gone", async () => {
    const ticket = await insertTicket(w, {
      company_id: w.companyB,
      contact_id: w.clientB.contactId,
      channel: "portal",
      subject: "Preview probe",
    })
    const path = `/api/contacts/companies/${w.companyB}/portal/preview/${w.clientB.userId}`
    const requests = async () => {
      const res = await get(path, adminToken)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { signedInWouldSee: { requests: Array<{ id: string }> | null } }
      }
      return (body.data.signedInWouldSee.requests ?? []).map((r) => r.id)
    }
    expect(await requests()).not.toContain(ticket.id)
    const opened = await asAdmin((tx) =>
      setPortalShare({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        scopes: ["*"],
        companyId: w.companyB,
        kind: "requests",
        open: true,
      }),
    )
    expect(opened.changed).toBe(true)
    expect(await requests()).toContain(ticket.id)
    await asAdmin((tx) =>
      setPortalShare({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        scopes: ["*"],
        companyId: w.companyB,
        kind: "requests",
        open: false,
      }),
    )
    expect(await requests()).not.toContain(ticket.id)
  })

  it("NT-58 a second factor reset needs the portal admin scope, is logged and mails the person", async () => {
    await sql.unsafe(
      `UPDATE kernel.users SET totp_secret = $2, totp_enabled = true WHERE id = $1`,
      [w.clientB.userId, generateTotpSecret()],
    )
    const path = `/api/contacts/companies/${w.companyB}/portal/people/${w.clientB.userId}/totp-reset`
    const memberToken = (await createSession(w.member.userId, w.orgId)).accessToken
    const refused = await app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}` },
    })
    expect(refused.status).toBe(403)
    capture.sent = []
    const res = await app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const [u] = extractRows<{ totp_enabled: boolean; totp_secret: string | null }>(
      await sql.unsafe(`SELECT totp_enabled, totp_secret FROM kernel.users WHERE id = $1`, [
        w.clientB.userId,
      ]),
    )
    expect(u).toEqual({ totp_enabled: false, totp_secret: null })
    const audit = await sql.unsafe(
      `SELECT actor_id FROM kernel.audit_log WHERE org_id = $1 AND action = 'portal.totp_reset' AND entity_id = $2`,
      [w.orgId, w.clientB.userId],
    )
    expect(audit.map((r) => r.actor_id)).toEqual([w.admin.userId])
    await new Promise((r) => setTimeout(r, 50))
    expect(capture.sent.map((m) => [m.to, m.template])).toEqual([
      [w.clientB.email, "portal.totp-reset"],
    ])
  })
})

describe("a contact moved, deleted or erased", () => {
  it("NT-26 a contact moved to another company or deleted ends the portal access made from it; erasure keeps the signed record and names it", async () => {
    const moved = await asAdmin((tx) =>
      invitePortalPerson({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        companyId: w.companyB,
        email: `moved-${w.orgId.slice(0, 8)}@doors.example.com`,
        name: "Paul Moved",
      }),
    )
    const session = await createPortalSession(moved.userId, w.orgId)
    await asAdmin((tx) =>
      updateContact(tx, {
        orgId: w.orgId,
        userId: w.admin.userId,
        contactId: moved.contactId,
        updates: { companyId: w.companyA },
      }),
    )
    const state = async (userId: string) =>
      extractRows<{ status: string; removed: boolean; sessions: number }>(
        await sql.unsafe(
          `SELECT u.status, p.removed_at IS NOT NULL AS removed,
                  (SELECT count(*)::int FROM kernel.sessions s WHERE s.user_id = u.id) AS sessions
             FROM kernel.users u JOIN kernel.portal_people p ON p.user_id = u.id WHERE u.id = $1`,
          [userId],
        ),
      )[0]
    expect(await state(moved.userId)).toEqual({ status: "deactivated", removed: true, sessions: 0 })
    const res = await app.request("/api/portal/me", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
    expect(res.status).toBe(401)

    await asAdmin((tx) =>
      deleteContact(tx, {
        orgId: w.orgId,
        userId: w.admin.userId,
        contactId: w.clientA2.contactId,
      }),
    )
    expect((await state(w.clientA2.userId))?.removed).toBe(true)

    // Erasure: the account goes, what they signed stays and is named.
    const signed = await insertClientAction(w, {
      company_id: w.companyB,
      invited_email: w.clientB.email,
      invited_name: w.clientB.name,
      decided_at: { raw: "now()" },
      decision: "signed",
      decided_via: "link",
    })
    const out = (await asAdmin((tx) =>
      handlePortalRemovePerson(
        { user_id: w.clientB.userId, erase: true },
        { orgId: w.orgId, userId: w.admin.userId, db: tx },
      ),
    )) as { kept?: Array<{ id: string }>; error?: unknown }
    expect(out.error).toBeUndefined()
    expect(out.kept?.map((k) => k.id)).toEqual([signed])
    // The account row stays as a tombstone (the audit trail points at it), with nothing of them.
    const [left] = extractRows<{ email: string; name: string }>(
      await sql.unsafe(`SELECT email, name FROM kernel.users WHERE id = $1`, [w.clientB.userId]),
    )
    expect(left?.email).not.toBe(w.clientB.email)
    expect(left?.name).not.toBe(w.clientB.name)
    const record = await sql.unsafe(`SELECT decision FROM kernel.client_actions WHERE id = $1`, [
      signed,
    ])
    expect(record.map((r) => r.decision)).toEqual(["signed"])
  })
})

describe("ending access when the other processes do not hear it", () => {
  it("NT-22b with the revocation broadcast lost, the token is refused once the auth cache lapses and the refresh at once", async () => {
    const companyD = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.companies", {
        id: companyD,
        org_id: w.orgId,
        handle: `d-${companyD.slice(0, 8)}`,
        name: "Maison Delta",
        closed_at: null,
      }),
    )
    const person = await asAdmin((tx) =>
      invitePortalPerson({
        orgId: w.orgId,
        actorId: w.admin.userId,
        db: tx,
        companyId: companyD,
        email: `delta-${w.orgId.slice(0, 8)}@doors.example.com`,
        name: "Delta Client",
      }),
    )
    const session = await createPortalSession(person.userId, w.orgId)
    const me = () =>
      app.request("/api/portal/me", { headers: { Authorization: `Bearer ${session.accessToken}` } })
    expect((await me()).status).toBe(200)
    await asAdmin((tx) =>
      endPortalAccess({ orgId: w.orgId, actorId: w.admin.userId, db: tx, companyId: companyD }),
    )
    // A peer that never got the message: no revoked session in its memory.
    await SessionRevocationTestAccess.settle()
    SessionRevocationTestAccess.reset()
    // Its cached auth state lapses within 15 s; the token is refused on the next read after.
    setSystemTime(new Date(Date.now() + 16_000))
    try {
      expect((await me()).status).toBe(401)
    } finally {
      setSystemTime()
    }
    const refresh = await app.request("/api/portal/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Cookie: `${PORTAL_REFRESH_COOKIE}=${session.refreshToken}`,
      },
      body: "{}",
    })
    expect(refresh.status).toBe(401)
  })
})
