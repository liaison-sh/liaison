// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mail a person sends from the composer: the real mail bundle in the real
// sandbox on a stubbed SMTP, through the draft send route. The conversation it
// stores links to the existing contact of its first To address, found the way
// the mailbox sync finds it, and sending creates no contact.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { mailRoutes } from "~/modules/mail/routes"
import * as mailService from "~/modules/mail/service"
import { seedContext } from "~/seed/context"
import { insertSql } from "~/seed/factories/org/test-rows"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMailAccount } from "../../../test-support/seed/mail"

let orgId = ""
let userId = ""
let admin: UserContext
let accountId = ""
const sent: Array<Record<string, unknown>> = []
const suffix = crypto.randomUUID().slice(0, 8)

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  admin = {
    ...a.actor,
    scopes: [...a.actor.scopes, "mail:conversations:write", "mail:conversations:read"],
  }
  await ensureAppsForOrg(orgId)
  SandboxBridgeTestAccess.setSmtpSend(async (_connection, _identifier, message) => {
    sent.push(message as Record<string, unknown>)
    return { messageId: `<sent-${suffix}-${sent.length}@org.test>`, deliveryState: "delivered" }
  })
  const ctx = seedContext({ orgId, now: new Date() })
  accountId = (
    await ensureMailAccount(ctx, {
      ownerType: "org",
      userId,
      email: "sales@org.test",
      provider: "imap",
    })
  ).accountId
}, 120_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setSmtpSend(null)
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("mail a person sends from the composer", () => {
  it("links the first To address's existing contact, is listed under that contact, and creates no contact", async () => {
    // Mutation caught: the composer's send stored its conversation with no contact.
    const contact = crypto.randomUUID()
    const known = `daniel-${suffix}@studio.example`
    const unknown = `nobody-${suffix}@elsewhere.example`
    await sql.unsafe(
      insertSql("kernel.contacts", {
        id: contact,
        org_id: orgId,
        handle: `@composer-${suffix}`,
        email: known,
        name: "Daniel Composer",
        org_access: "editor",
        created_by: userId,
      } as never),
    )
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("userId", userId)
      c.set("orgId", orgId)
      c.set("scopes", admin.scopes as never)
      c.set("dimensionGrants", admin.dimensionGrants as never)
      c.set("roles", admin.roles as never)
      await next()
    })
    app.route("/api/mail", mailRoutes)
    const send = async (to: string, subject: string) => {
      const draft = await withRlsContext(admin, (tx) =>
        mailService.createDraft(tx as never, {
          orgId,
          userId,
          accountId,
          to: [{ email: to }],
          subject,
        }),
      )
      const res = await app.request(`/api/mail/drafts/${(draft as { id: string }).id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: [{ email: to.toUpperCase() }],
          subject,
          textBody: "It ships on Monday.",
          htmlBody: "<p>It ships on Monday.</p>",
        }),
      })
      expect(res.status === 200 ? 200 : await res.text()).toBe(200)
      const [row] = await sql<Array<{ contact_id: string | null }>>`
        SELECT conversation.contact_id::text AS contact_id
          FROM app_mail.messages message
          JOIN app_mail.conversations conversation ON conversation.id = message.conversation_id
         WHERE message.org_id = ${orgId} AND message.subject = ${subject}`
      return row?.contact_id ?? null
    }
    expect(await send(known, "Your monitor repair: delivery date")).toBe(contact)
    expect(await send(unknown, "A note to nobody we know")).toBeNull()

    const listed = await app.request(`/api/mail/conversations?contactId=${contact}`)
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { data: Array<{ subject: string | null }> }
    expect(body.data.map((c) => c.subject)).toEqual(["Your monitor repair: delivery date"])
    const created = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.contacts WHERE org_id = ${orgId} AND lower(email) = ${unknown}`
    expect(created[0]?.n).toBe(0)
  }, 60_000)
})
