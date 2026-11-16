// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The gated request carries the send check its card showed: the preflight pins
// a plain service-mail check to the invited address and the one-request key
// (target, contact, address); the approved call mints only when both still hold.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { isPinnedSendGuard } from "~/modules/mail/send-guard"
import { adminContext } from "~/tests/security/portal-doors/fixture"
import { k, useClientActionWorld } from "../../../test-support/client-actions-kit"
import {
  clientActionCreatePreflight,
  clientActionGuardKey,
  handleClientActionCreate,
} from "./tools"

const kit = useClientActionWorld("guarddocs")

function params(targetId = crypto.randomUUID()) {
  return {
    kind: "sign" as const,
    target_app: kit.targetApp,
    target_type: kit.targetType,
    target_id: targetId,
    target_sha256: "b".repeat(64),
    contact_id: kit.w.clientA.contactId,
    expires_in_days: 7 as const,
  }
}

function asAdmin<T>(fn: (ctx: Parameters<typeof handleClientActionCreate>[1]) => Promise<T>) {
  const ctx = adminContext(kit.w)
  return withRlsContext(ctx, (db) => fn({ userId: ctx.userId, orgId: ctx.orgId, db }))
}

async function pinned(p: ReturnType<typeof params>) {
  const out = (await asAdmin((ctx) => clientActionCreatePreflight(p, ctx))) as {
    ok: true
    pinnedParams: { sendGuard: unknown; guardKey: string }
  }
  return out.pinnedParams
}

describe("the send check a client request carries", () => {
  it("the preflight pins a service-mail check to the contact's address and the one-request key", async () => {
    const p = params()
    const pin = await pinned(p)
    expect(isPinnedSendGuard(pin.sendGuard)).toBe(true)
    expect(pin.sendGuard).toMatchObject({
      mode: "plain",
      classification: "service",
      addresses: [kit.w.clientA.email],
      contactIds: [kit.w.clientA.contactId],
    })
    expect(pin.guardKey).toBe(
      clientActionGuardKey(p.target_id, kit.w.clientA.contactId, kit.w.clientA.email),
    )
  })

  it("an approved call whose key no longer matches its card sends nothing", async () => {
    const p = params()
    const pin = await pinned(p)
    const moved = { ...p, invited_email: "someone-else@example.com", ...pin }
    const r = (await asAdmin((ctx) => handleClientActionCreate(moved, ctx))) as {
      error?: { code: string; message: string }
    }
    expect(r.error?.code).toBe("SEND_GUARD_MISMATCH")
    expect(r.error?.message).toContain("Nothing was sent")
    const rows = await sql`SELECT id FROM ${k("client_actions")} WHERE target_id = ${p.target_id}`
    expect(rows).toHaveLength(0)
  })

  it("an approved call whose check still holds makes the request and mails the link", async () => {
    const p = params()
    const pin = await pinned(p)
    const r = (await asAdmin((ctx) => handleClientActionCreate({ ...p, ...pin }, ctx))) as {
      id: string
      sent: boolean
    }
    expect(r.sent).toBe(true)
    const rows = await sql`SELECT id FROM ${k("client_actions")} WHERE target_id = ${p.target_id}`
    expect(rows.map((x) => x.id)).toEqual([r.id])
  })

  it("a pinned value that is not a send check is refused", async () => {
    const p = params()
    const pin = await pinned(p)
    const r = (await asAdmin((ctx) =>
      handleClientActionCreate({ ...p, ...pin, sendGuard: { applies: false } }, ctx),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("SEND_GUARD_MISMATCH")
  })
})
