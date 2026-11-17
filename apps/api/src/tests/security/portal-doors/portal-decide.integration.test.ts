// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal's decide: only the invited person decides, a colleague is told who it
// waits on, a session past 12 hours since its sign-in asks the emailed code, signing
// always asks it, and the code check is recorded on the action. Each door test fails
// when its check is taken out of decideClientAction.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { EmailMessage, EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { awaitOrgApps } from "~/modules/apps/init"
import { createPortalSession } from "~/modules/auth/auth"
import { mintClientAction } from "~/modules/client-actions/mint"
import {
  ClientActionTargetsTestAccess,
  type ClientActionView,
} from "~/modules/client-actions/targets"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import {
  CaptureProvider,
  createDoorWorld,
  type DoorPerson,
  type DoorWorld,
  dropDoorWorld,
  insertClientAction,
  insertShare,
} from "./fixture"

const TARGET_APP = "doorsdeals"
const TARGET_TYPE = "deal_version"
const k = (table: string) => `"${schemaRef("kernel")}".${table}`

let w: DoorWorld
let previous: EmailProvider
const capture = new CaptureProvider()
let prevForce: string | undefined
let shareKind: "agreement" | null = null
const tokens: Record<string, string> = {}

function view(): ClientActionView {
  return {
    title: "Avenant Maison Alpha",
    senderName: "Admin",
    summary: [],
    sourceBlocks: [{ type: "paragraph", text: "Les parties conviennent." }],
    text: "Les parties conviennent.",
    pdfFileId: null,
    pages: null,
    pagesSha256: null,
    sha256: "a".repeat(64),
    wordsKey: null,
    wordsParams: {},
    copyStates: {},
    portalShareKind: shareKind,
  }
}

async function tokenOf(p: DoorPerson): Promise<string> {
  if (!tokens[p.userId])
    tokens[p.userId] = (await createPortalSession(p.userId, w.orgId)).accessToken
  return tokens[p.userId] as string
}

async function portalPost(path: string, body: unknown, as: DoorPerson = w.clientA) {
  return app.request(`/api/portal${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "door-browser",
      Authorization: `Bearer ${await tokenOf(as)}`,
    },
    body: JSON.stringify(body),
  })
}

/** The person's sign-in, this long ago by the database's clock. */
async function signedInAgo(p: DoorPerson, interval: string) {
  await sql.unsafe(
    `UPDATE ${k("portal_people")} SET last_sign_in_at = now() - $1::interval WHERE user_id = $2`,
    [interval, p.userId],
  )
}

/** An open action on a shared target of company A, sent to `to`. */
async function sharedAction(kind: "sign" | "approve", to: DoorPerson = w.clientA) {
  const target = crypto.randomUUID()
  await insertShare(w, { company_id: w.companyA, kind: "agreement", object_id: target })
  const id = await insertClientAction(w, {
    company_id: w.companyA,
    target_id: target,
    target_app: TARGET_APP,
    target_type: TARGET_TYPE,
    kind,
    invited_email: to.email,
    invited_name: to.name,
    created_by_user_id: w.admin.userId,
  })
  return { id, target }
}

async function row(id: string) {
  const [r] = await sql.unsafe(`SELECT * FROM ${k("client_actions")} WHERE id = $1`, [id])
  return r as Record<string, unknown>
}

async function codeFor(id: string): Promise<string> {
  const before = capture.sent.length
  const res = await portalPost(`/actions/${id}/code`, {})
  expect(res.status).toBe(202)
  for (let i = 0; i < 100; i++) {
    const m = capture.sent
      .slice(before)
      .find((x: EmailMessage) => x.template === "client-action.code" && x.to === w.clientA.email)
    const c = m && (m.text ?? "").match(/\b(\d{6})\b/)?.[1]
    if (c) return c
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("no code mail")
}

beforeAll(async () => {
  await acquireTestLock()
  prevForce = process.env.RATE_LIMIT_FORCE_ENABLED
  process.env.RATE_LIMIT_FORCE_ENABLED = "true"
  previous = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createDoorWorld()
  await awaitOrgApps(w.orgId)
  ClientActionTargetsTestAccess.set(TARGET_APP, TARGET_TYPE, ["sign", "approve"], async () =>
    view(),
  )
})

afterEach(async () => {
  shareKind = null
  await clearRedisPatterns(["ca:*", "ratelimit:portal:action-*"])
})

afterAll(async () => {
  ClientActionTargetsTestAccess.clear(TARGET_APP, TARGET_TYPE)
  setSystemEmailProvider(previous)
  if (prevForce === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
  else process.env.RATE_LIMIT_FORCE_ENABLED = prevForce
  if (w) await dropDoorWorld(w)
  await releaseTestLock()
})

describe("portal doors: the portal decide", () => {
  it("NT-42 a colleague's decide gets 403 naming who it waits on; the invited person's session at 11 h 59 confirms by click, at 12 h 01 gets code_required", async () => {
    const { id } = await sharedAction("approve")
    // The colleague sees the action (same company, same share) but it is not theirs.
    await signedInAgo(w.clientA2, "1 hour")
    const colleague = await portalPost(`/actions/${id}/decide`, { decision: "approve" }, w.clientA2)
    expect(colleague.status).toBe(403)
    const body = (await colleague.json()) as { error: { message: string }; waiting_on: string }
    expect(body.error.message).toBe(`Waiting on ${w.clientA.name}`)
    expect((await row(id)).decided_at).toBeNull()

    await signedInAgo(w.clientA, "12 hours 1 minute")
    const stale = await portalPost(`/actions/${id}/decide`, {
      decision: "approve",
      typed_name: w.clientA.name,
    })
    expect(stale.status).toBe(401)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("code_required")
    expect((await row(id)).decided_at).toBeNull()

    await signedInAgo(w.clientA, "11 hours 59 minutes")
    const fresh = await portalPost(`/actions/${id}/decide`, {
      decision: "approve",
      typed_name: w.clientA.name,
    })
    expect(fresh.status).toBe(200)
    const decided = await row(id)
    expect(decided.decision).toBe("approved")
    expect(decided.decided_via).toBe("portal")
    expect(decided.decided_user_id).toBe(w.clientA.userId)
    // No code was checked for the click, and none is recorded.
    expect(decided.code_verified_at).toBeNull()
  })

  it("signing always asks the code on the portal, and the code check is recorded on the action", async () => {
    await signedInAgo(w.clientA, "5 minutes")
    const { id } = await sharedAction("sign")
    const without = await portalPost(`/actions/${id}/decide`, {
      decision: "sign",
      typed_name: w.clientA.name,
    })
    expect(without.status).toBe(401)
    expect(((await without.json()) as { error: { code: string } }).error.code).toBe("code_required")
    const wrong = await portalPost(`/actions/${id}/decide`, {
      decision: "sign",
      typed_name: w.clientA.name,
      code: "000000",
    })
    expect(wrong.status).toBe(401)
    expect((await row(id)).decided_at).toBeNull()
    const code = await codeFor(id)
    const signed = await portalPost(`/actions/${id}/decide`, {
      decision: "sign",
      typed_name: w.clientA.name,
      capacity: "Gérante",
      code,
    })
    expect(signed.status).toBe(200)
    const r = await row(id)
    expect(r.decision).toBe("signed")
    expect(r.code_verified_at).not.toBeNull()
    expect(r.capacity).toBe("Gérante")
    expect(String(r.words_shown)).toContain("Avenant Maison Alpha")
    const [ev] = await sql.unsafe(
      `SELECT actor_kind, meta FROM ${k("client_action_events")} WHERE action_id = $1 AND event = 'decided'`,
      [id],
    )
    expect(ev?.actor_kind).toBe("portal_user")
    expect((ev?.meta as { code_verified?: boolean } | undefined)?.code_verified).toBe(true)
    // The decision is on the person's portal log.
    let logged = 0
    for (let i = 0; i < 50 && logged === 0; i++) {
      const [n] = await sql.unsafe(
        `SELECT count(*)::int AS n FROM ${k("audit_log")} WHERE actor_id = $1 AND action = 'portal.approve' AND entity_id = $2`,
        [w.clientA.userId, id],
      )
      logged = Number((n as unknown as { n: number } | undefined)?.n ?? 0)
      if (logged === 0) await new Promise((r) => setTimeout(r, 20))
    }
    expect(logged).toBe(1)
  })

  it("only the invited person gets a code: a colleague's ask sends nothing", async () => {
    await signedInAgo(w.clientA2, "5 minutes")
    const { id } = await sharedAction("sign")
    const before = capture.sent.length
    const res = await portalPost(`/actions/${id}/code`, {}, w.clientA2)
    expect(res.status).toBe(403)
    expect(capture.sent.length).toBe(before)
  })

  it("a typo in the name is refused before the code is spent", async () => {
    await signedInAgo(w.clientA, "5 minutes")
    const { id } = await sharedAction("sign")
    const code = await codeFor(id)
    const typo = await portalPost(`/actions/${id}/decide`, {
      decision: "sign",
      code,
      typed_phrase: "x",
    })
    expect(typo.status).toBe(422)
    const ok = await portalPost(`/actions/${id}/decide`, {
      decision: "sign",
      typed_name: w.clientA.name,
      code,
    })
    expect(ok.status).toBe(200)
  })

  it("NT-20 company B's action ids give the same 404 as a random id on the code and decide routes", async () => {
    await signedInAgo(w.clientA, "5 minutes")
    const target = crypto.randomUUID()
    await insertShare(w, { company_id: w.companyB, kind: "agreement", object_id: target })
    const bAction = await insertClientAction(w, {
      company_id: w.companyB,
      target_id: target,
      target_app: TARGET_APP,
      target_type: TARGET_TYPE,
      invited_email: w.clientA.email,
      invited_name: w.clientA.name,
    })
    for (const route of ["code", "decide"]) {
      const body = { decision: "sign", typed_name: w.clientA.name, code: "123456" }
      const asB = await portalPost(`/actions/${bAction}/${route}`, body)
      const random = await portalPost(`/actions/${crypto.randomUUID()}/${route}`, body)
      expect({ route, status: asB.status }).toEqual({ route, status: 404 })
      expect(await asB.text()).toBe(await random.text())
    }
    expect((await row(bAction)).decided_at).toBeNull()
    // A share closed on its target hides the action again.
    await sql.unsafe(
      `UPDATE ${k("portal_shares")} SET closed_at = now() WHERE org_id = $1 AND object_id = $2`,
      [w.orgId, target],
    )
  })

  it("a send to a portal client of the company opens its share on their portal, never on a restricted document", async () => {
    shareKind = "agreement"
    const open = await mintClientAction({
      orgId: w.orgId,
      kind: "sign",
      targetApp: TARGET_APP,
      targetType: TARGET_TYPE,
      targetId: crypto.randomUUID(),
      contactId: w.clientA.contactId,
      companyId: w.companyA,
      expiresInDays: 7,
      createdByUserId: w.admin.userId,
    })
    expect(open.sharedOnPortal).toBe(true)
    const restrictedTarget = crypto.randomUUID()
    const restricted = await mintClientAction({
      orgId: w.orgId,
      kind: "sign",
      targetApp: TARGET_APP,
      targetType: TARGET_TYPE,
      targetId: restrictedTarget,
      contactId: w.clientA.contactId,
      companyId: w.companyA,
      expiresInDays: 7,
      visibleTo: [w.admin.userId],
      createdByUserId: w.admin.userId,
    })
    expect(restricted.sharedOnPortal).toBe(false)
    const shares = await sql.unsafe(
      `SELECT kind, object_id, shared_by_user_id FROM ${k("portal_shares")} WHERE org_id = $1 AND object_id = $2`,
      [w.orgId, restrictedTarget],
    )
    expect(shares.length).toBe(0)
  })
})
