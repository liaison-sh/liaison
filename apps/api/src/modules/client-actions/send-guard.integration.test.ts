// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The gated request carries the send check its card showed: the preflight pins
// a plain service-mail check to the invited address and the one-request key
// (target, contact, address); the approved call mints only when both still hold.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { isPinnedSendGuard } from "~/modules/mail/send-guard"
import { adminContext } from "~/tests/security/portal-doors/fixture"
import { baseView, k, useClientActionWorld } from "../../../test-support/client-actions-kit"
import { ClientActionTargetsTestAccess } from "./targets"
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
    // Another document under the same check, then another address.
    const otherTarget = { ...p, ...pin, target_id: crypto.randomUUID() }
    const otherAddress = { ...p, ...pin, invited_email: "someone-else@example.com" }
    for (const moved of [otherTarget, otherAddress]) {
      const r = (await asAdmin((ctx) => handleClientActionCreate(moved, ctx))) as {
        error?: { code: string; message: string }
      }
      expect(r.error?.code).toBe("SEND_GUARD_MISMATCH")
      expect(r.error?.message).toContain("Nothing was sent")
    }
    const elsewhere =
      await sql`SELECT id FROM ${k("client_actions")} WHERE target_id = ${otherTarget.target_id}`
    expect(elsewhere).toHaveLength(0)
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

  it("a target whose app sends its own links is refused at the preflight and at the call, and nothing is made", async () => {
    ClientActionTargetsTestAccess.set(
      kit.targetApp,
      "appsent",
      ["sign"],
      async () => baseView(),
      "app",
    )
    try {
      const p = { ...params(), target_type: "appsent" }
      const staged = (await asAdmin((ctx) => clientActionCreatePreflight(p, ctx))) as {
        error?: { code: string; message: string }
      }
      expect(staged.error?.code).toBe("TARGET_SENT_BY_ITS_APP")
      expect(staged.error?.message).toContain("Nothing was sent")
      const r = (await asAdmin((ctx) => handleClientActionCreate(p, ctx))) as {
        error?: { code: string }
      }
      expect(r.error?.code).toBe("TARGET_SENT_BY_ITS_APP")
      const rows = await sql`SELECT id FROM ${k("client_actions")} WHERE target_id = ${p.target_id}`
      expect(rows).toHaveLength(0)
    } finally {
      ClientActionTargetsTestAccess.clear(kit.targetApp, "appsent")
    }
  })
})

describe("the document version a client request is bound to", () => {
  const staged = () => {
    const { target_sha256: _given, ...rest } = params()
    return rest
  }

  it("the preflight reads the target and pins its current hash when the caller gives none", async () => {
    kit.view = { ...baseView(), sha256: "c".repeat(64), blocksSha256: "d".repeat(64) }
    const out = (await asAdmin((ctx) => clientActionCreatePreflight(staged(), ctx))) as {
      ok?: true
      pinnedParams?: Record<string, unknown>
    }
    expect(out.ok).toBe(true)
    expect(out.pinnedParams?.target_sha256).toBe("c".repeat(64))
    expect(out.pinnedParams?.target_blocks_sha256).toBe("d".repeat(64))
  })

  it("a target that cannot be read is refused at the preflight and nothing is staged", async () => {
    kit.viewAnswers = false
    const out = (await asAdmin((ctx) => clientActionCreatePreflight(staged(), ctx))) as {
      ok?: true
      error?: { code: string; message: string }
    }
    expect(out.ok).toBeUndefined()
    expect(out.error?.code).toBe("TARGET_UNAVAILABLE")
    expect(out.error?.message).toContain("nothing was staged")
  })

  it("a target its app refuses to show is refused at the preflight with the app's own reason", async () => {
    ClientActionTargetsTestAccess.set(kit.targetApp, "unshown", ["accept"], async () => ({
      refused: "Quote Q-7 has no PDF yet.",
    }))
    try {
      const out = (await asAdmin((ctx) =>
        clientActionCreatePreflight({ ...staged(), kind: "accept", target_type: "unshown" }, ctx),
      )) as { error?: { code: string; message: string } }
      expect(out.error?.code).toBe("TARGET_UNAVAILABLE")
      expect(out.error?.message).toContain("Quote Q-7 has no PDF yet.")
    } finally {
      ClientActionTargetsTestAccess.clear(kit.targetApp, "unshown")
    }
  })

  it("an agent's request with no hash parks with the version it read, and the approved call is held to it", async () => {
    const actor = adminContext(kit.w)
    const p = { ...staged(), kind: "accept" as const }
    try {
      const r = await executeTool({
        toolName: "kernel:client_action_create",
        orgId: kit.w.orgId,
        actor,
        params: p,
        origin: "in-app-agent",
      })
      expect(r.blocked).toBeDefined()
      const [row] = await sql<{ current_payload: Record<string, unknown> }[]>`
        SELECT current_payload FROM kernel.approval_requests
         WHERE org_id = ${kit.w.orgId} AND tool_name = 'kernel:client_action_create'
           AND status = 'pending' AND current_payload->>'target_id' = ${p.target_id}`
      const payload = row?.current_payload as Record<string, unknown>
      expect(payload.target_sha256).toBe(baseView().sha256)

      // The document moved after the card was staged: the approved call makes nothing.
      kit.view = { ...baseView(), sha256: "e".repeat(64) }
      const moved = (await asAdmin((ctx) =>
        handleClientActionCreate(payload as Parameters<typeof handleClientActionCreate>[0], ctx),
      )) as { error?: { code: string } }
      expect(moved.error?.code).toBe("VERSION_CHANGED")
      const none = await sql`SELECT id FROM ${k("client_actions")} WHERE target_id = ${p.target_id}`
      expect(none).toHaveLength(0)

      // The version that was approved: the link is made.
      kit.view = baseView()
      const ok = (await asAdmin((ctx) =>
        handleClientActionCreate(payload as Parameters<typeof handleClientActionCreate>[0], ctx),
      )) as { id?: string; sent?: boolean }
      expect(ok.sent).toBe(true)
      const [made] = await sql<{ target_sha256: string }[]>`
        SELECT target_sha256 FROM ${k("client_actions")} WHERE id = ${ok.id as string}`
      expect(made?.target_sha256).toBe(baseView().sha256)
    } finally {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${kit.w.orgId}`
    }
  })

  it("an approved call that carries no pinned version is refused", async () => {
    const p = params()
    const pin = await pinned(p)
    const { target_sha256: _dropped, ...unbound } = { ...p, ...pin }
    const r = (await asAdmin((ctx) =>
      handleClientActionCreate(unbound as Parameters<typeof handleClientActionCreate>[0], ctx),
    )) as { error?: { code: string } }
    expect(r.error?.code).toBe("SEND_GUARD_MISMATCH")
    const rows = await sql`SELECT id FROM ${k("client_actions")} WHERE target_id = ${p.target_id}`
    expect(rows).toHaveLength(0)
  })
})
