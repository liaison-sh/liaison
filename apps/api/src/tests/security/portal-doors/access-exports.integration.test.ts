// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the client portal leaves behind in staff's views. The whole-organization
// export lists the people outside as their own section and carries no link
// token, refresh token, second-factor secret or hash of one. A client's sign-ins,
// views, downloads and opens never become an engagement field on Home or on a
// company's or contact's card: the access log is read by its named readers only.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { unzipSync } from "fflate"
import { app } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import type { AppEvent } from "~/infra/events/event-bus"
import { deleteObject, getObjectBuffer } from "~/infra/storage/object-storage"
import { processTranslationEvent } from "~/modules/attention/translator"
import { createPortalSession, createSession } from "~/modules/auth/auth"
import { SYSTEM_ACTOR_ID } from "~/modules/client-actions/mint"
import { handleClientActionsList } from "~/modules/client-actions/tools"
import { buildOrgArchive } from "~/modules/export/org-archive/writer"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  adminContext,
  createSignInWorld,
  dropDoorWorld,
  insertClientAction,
  ORIGIN,
  type SignInWorld,
} from "./fixture"

let w: SignInWorld
let adminToken: string
const objectKeys: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  w = await createSignInWorld()
  adminToken = (await createSession(w.admin.userId, w.orgId)).accessToken
})

afterAll(async () => {
  for (const key of objectKeys) await deleteObject(key).catch(() => undefined)
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${w.orgId}`
  await dropDoorWorld(w)
  await releaseTestLock()
})

const get = (path: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${adminToken}`, Origin: ORIGIN } })

describe("the whole-organization export", () => {
  it("NT-53 lists the people outside as their own section and carries no token or token hash", async () => {
    const actionId = await insertClientAction(w, { company_id: w.companyB })
    await sql`UPDATE kernel.client_actions
      SET prior_token_hashes = ARRAY[${"b".repeat(64)}]::text[] WHERE id = ${actionId}`
    const session = await createPortalSession(w.clientB.userId, w.orgId)
    const [secrets] = (await sql`
      SELECT a.token_hash, s.refresh_token_hash, u.totp_secret
        FROM kernel.client_actions a, kernel.sessions s, kernel.users u
       WHERE a.id = ${actionId} AND s.user_id = ${w.clientB.userId}
         AND u.id = ${w.clientTotp.userId}`) as unknown as Array<Record<string, string>>
    const secretValues = [
      secrets?.token_hash,
      "b".repeat(64),
      secrets?.refresh_token_hash,
      secrets?.totp_secret,
      w.clientTotp.secret,
      session.refreshToken,
      session.accessToken,
    ]
    for (const v of secretValues) expect(typeof v === "string" && v.length > 0).toBe(true)

    const res = await buildOrgArchive({ orgId: w.orgId, exportId: crypto.randomUUID() })
    objectKeys.push(res.objectKey)
    const files = unzipSync(new Uint8Array(await getObjectBuffer(res.objectKey)))
    const rows = (name: string) =>
      new TextDecoder()
        .decode(files[name] ?? new Uint8Array())
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)

    const outside = [w.clientA, w.clientA2, w.clientB, w.clientC, w.clientGone, w.clientTotp]
    const outsideIds = outside.map((p) => p.userId).sort()

    // Their own section: who they are, how many, and where their rows are.
    const section = res.manifest.external
    expect(section.people).toBe(outside.length)
    expect(section.users).toEqual({
      file: "data/kernel.users.ndjson",
      where: "user_type = 'external'",
    })
    const sectionTables = Object.fromEntries(section.tables.map((t) => [t.table, t]))
    expect(Object.keys(sectionTables).sort()).toEqual([
      "kernel.client_action_devices",
      "kernel.client_action_events",
      "kernel.client_actions",
      "kernel.portal_people",
      "kernel.portal_shares",
    ])
    for (const t of section.tables) expect(files[t.file]).toBeDefined()
    expect(sectionTables["kernel.portal_people"]?.rows).toBe(outside.length)
    expect(sectionTables["kernel.client_actions"]?.rows).toBe(1)

    // The rows are there, and only this organization's.
    const users = rows("data/kernel.users.ndjson")
    expect(
      users
        .filter((u) => u.user_type === "external")
        .map((u) => u.id)
        .sort(),
    ).toEqual(outsideIds)
    expect(users.some((u) => u.id === w.otherClient.userId)).toBe(false)
    expect(
      rows("data/kernel.portal_people.ndjson")
        .map((p) => p.user_id)
        .sort(),
    ).toEqual(outsideIds)

    // No secret, raw or hashed, anywhere in the archive.
    const actions = rows("data/kernel.client_actions.ndjson")
    expect(actions.map((a) => [a.id, a.token_hash, a.prior_token_hashes])).toEqual([
      [actionId, null, null],
    ])
    const sessions = rows("data/kernel.sessions.ndjson").filter(
      (s) => s.user_id === w.clientB.userId,
    )
    expect(sessions.length).toBe(1)
    expect(sessions[0]?.refresh_token_hash).toBeNull()
    expect(users.find((u) => u.id === w.clientTotp.userId)?.totp_secret).toBeNull()
    const text = Object.values(files)
      .map((bytes) => new TextDecoder().decode(bytes))
      .join("\n")
    for (const v of secretValues) expect(text.includes(String(v))).toBe(false)
  }, 60_000)
})

/** A key that would count, date or score what a client did on the portal. */
const ENGAGEMENT_KEY =
  /engag|score|^(last|latest|first)_(seen|visit|visited|open|opened|view|viewed|sign_in|signed_in|login|download|downloaded)|(seen|visit|open|view|download|sign_in|login)s?_(count|total|number|times)$|^times_|^(views|opens|visits|downloads|sign_ins|logins)$/

const snake = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()

function engagementKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => engagementKeys(v, `${path}[${i}]`))
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([k, v]) => [
    ...(ENGAGEMENT_KEY.test(snake(k)) ? [`${path}.${k}`] : []),
    ...engagementKeys(v, `${path}.${k}`),
  ])
}

describe("what a client did on the portal, in staff's views", () => {
  it("NT-40 no engagement field in any home or card payload", async () => {
    expect(engagementKeys({ items: [{ lastSeenAt: 1, viewCount: 2, opened: true }] })).toEqual([
      "$.items[0].lastSeenAt",
      "$.items[0].viewCount",
    ])

    // Client B signs in, looks and downloads, and opens a request three times.
    const logIds: string[] = []
    for (const action of ["portal.sign_in", "portal.view", "portal.view", "portal.download"]) {
      const id = crypto.randomUUID()
      logIds.push(id)
      await sql.unsafe(
        insertSql("kernel.audit_log", {
          id,
          org_id: w.orgId,
          actor_type: "external",
          actor_id: w.clientB.userId,
          app: "portal",
          action,
          entity_type: "company",
          entity_id: w.companyB,
          metadata: JSON.stringify({ companyId: w.companyB }),
        }),
      )
    }
    const actionId = await insertClientAction(w, {
      company_id: w.companyB,
      contact_id: w.clientB.contactId,
      invited_email: w.clientB.email,
      invited_name: w.clientB.name,
    })
    await sql`UPDATE kernel.client_actions
      SET sent_at = now(), first_opened_at = now(), document_shown_at = now() WHERE id = ${actionId}`
    for (const event of ["link_loaded", "opened", "document_shown", "document_shown"]) {
      await sql.unsafe(
        insertSql("kernel.client_action_events", {
          org_id: w.orgId,
          action_id: actionId,
          event,
          actor_kind: "portal_user",
          actor_user_id: w.clientB.userId,
        }),
      )
    }
    await sql`UPDATE kernel.portal_people SET last_sign_in_at = now()
      WHERE user_id = ${w.clientB.userId}`
    for (let i = 0; i < 3; i++) {
      const opened: AppEvent = {
        app: "kernel",
        entity: "client_action",
        action: "opened",
        orgId: w.orgId,
        actorId: SYSTEM_ACTOR_ID,
        actorType: "system",
        entityId: actionId,
        timestamp: new Date().toISOString(),
        data: { invitedName: w.clientB.name, senderUserIds: [w.admin.userId] },
      }
      await processTranslationEvent(opened)
    }

    const payloads: Record<string, unknown> = {}
    for (const path of [
      "/api/attention-items",
      "/api/home/brief",
      `/api/contacts/companies/${w.companyB}`,
      `/api/contacts/companies/${w.companyB}/activity`,
      `/api/contacts/${w.clientB.contactId}`,
      `/api/contacts/${w.clientB.contactId}/activity`,
    ]) {
      const res = await get(path)
      expect({ path, status: res.status }).toEqual({ path, status: 200 })
      payloads[path] = await res.json()
    }
    payloads.client_actions_list = await withRlsContext(adminContext(w), (tx) =>
      handleClientActionsList({ company_id: w.companyB, limit: 50 }, {
        orgId: w.orgId,
        userId: w.admin.userId,
        db: tx,
      } as Parameters<typeof handleClientActionsList>[1]),
    )
    // The Home row says the request was opened, once per request, with no tally.
    const home = JSON.stringify(payloads["/api/attention-items"])
    expect(home).toContain("opened your request")
    expect(home.split("opened your request").length - 1).toBe(1)

    expect(engagementKeys(payloads)).toEqual([])
    // No row of the access log reaches a card or Home.
    const all = JSON.stringify(payloads)
    expect(logIds.filter((id) => all.includes(id))).toEqual([])
  }, 60_000)
})
