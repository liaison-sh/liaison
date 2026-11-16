// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app's doors into client actions (bridge/client-actions.ts): one person's
// decision on the app's gated send mints every signer of it, only the first
// with a link under "one after the other"; the next signer's link is opened by
// the decided handler with no card, and only once the signer before signed;
// no link is made outside a person's decision; a server that cannot seal a
// signature refuses the send before any row.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createClientActionsMethods } from "~/modules/apps/sandbox/bridge/client-actions"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { k, useClientActionWorld } from "../../../test-support/client-actions-kit"

const kit = useClientActionWorld("sendbridge", "agreement_version")
const SEND_TOOL = "send_for_signature"
const mutableEnv = env as { LIAISON_TSA_URL?: string; LIAISON_MANAGED_SIGNING_ENABLED?: boolean }
let prevTsa: string | undefined

beforeAll(() => {
  prevTsa = mutableEnv.LIAISON_TSA_URL
  mutableEnv.LIAISON_TSA_URL = "https://tsa.example.test/"
  toolRegistry.set([kit.w.orgId, kit.targetApp, SEND_TOOL], {
    appName: kit.targetApp,
    name: SEND_TOOL,
    gated: true,
    noAutoApprove: true,
    requiredScopes: [`${kit.targetApp}:docs:write`],
  } as never)
})

afterAll(() => {
  mutableEnv.LIAISON_TSA_URL = prevTsa
  _setEdition(null)
  toolRegistry.delete([kit.w.orgId, kit.targetApp, SEND_TOOL])
})

/** The bridge as a handler sees it: under an approval of the app's send, or under none. */
function bridge(opts: { approved: boolean }) {
  return createClientActionsMethods({
    appName: kit.targetApp,
    orgId: kit.w.orgId,
    userId: kit.w.admin.userId,
    approvalContext: opts.approved
      ? {
          approvalRequestId: crypto.randomUUID(),
          approvalDeciderId: kit.w.admin.userId,
          toolName: `${kit.targetApp}:${SEND_TOOL}`,
        }
      : undefined,
    bridgeOptions: undefined,
    bridgeActingAgentId: undefined,
  } as unknown as BridgeContext)
}

async function send(approved: boolean, targetId: string, order: "sequential" | "any") {
  const raw = await bridge({ approved }).client_actions_mint(
    JSON.stringify({
      send: {
        target_type: kit.targetType,
        target_id: targetId,
        sha256: kit.view.sha256,
        kind: "sign",
        expires_in_days: 7,
        order,
        company_id: kit.w.companyA,
        signers: [
          { contact_id: kit.w.clientA.contactId },
          { contact_id: kit.w.clientA2.contactId },
        ],
      },
    }),
  )
  return JSON.parse(raw) as {
    status: string
    error?: { code: string }
    actions?: Array<{ id: string; status: string; sign_order: number | null }>
  }
}

const rowsOf = async (targetId: string) =>
  (await sql`
    SELECT id, sign_order, token_hash, sent_at, decided_at FROM ${k("client_actions")}
     WHERE target_id = ${targetId} ORDER BY sign_order`) as unknown as Array<{
    id: string
    sign_order: number | null
    token_hash: string | null
    sent_at: Date | null
  }>

const mailsTo = (email: string) =>
  kit.capture.sent.filter((m) => m.to === email && m.template === "client-action.link").length

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
}

describe("an app's send through the bridge", () => {
  it("one approval of a two-signer send mints every link it should, and no second card appears", async () => {
    const targetId = crypto.randomUUID()
    const before2 = mailsTo(kit.w.clientA2.email)
    const out = await send(true, targetId, "sequential")
    expect(out.status).toBe("ok")
    expect(out.actions?.map((a) => [a.sign_order, a.status])).toEqual([
      [1, "open"],
      [2, "waiting_turn"],
    ])
    const rows = await rowsOf(targetId)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.token_hash).not.toBeNull()
    // Signer 2 has no token and no mail until signer 1 signs.
    expect(rows[1]?.token_hash).toBeNull()
    expect(rows[1]?.sent_at).toBeNull()
    await waitUntil(() => mailsTo(kit.w.clientA.email) > 0)
    expect(mailsTo(kit.w.clientA2.email)).toBe(before2)
  })

  it("signer 2's link is minted by the decided handler with no card, only after signer 1 signed", async () => {
    const targetId = crypto.randomUUID()
    const out = await send(true, targetId, "sequential")
    const [first, second] = out.actions ?? []
    const early = JSON.parse(
      await bridge({ approved: false }).client_actions_mint(
        JSON.stringify({ next_turn_after: first?.id }),
      ),
    ) as { opened_id: string | null }
    expect(early.opened_id).toBeNull()
    expect((await rowsOf(targetId))[1]?.token_hash).toBeNull()

    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${first?.id ?? ""}`
    const before2 = mailsTo(kit.w.clientA2.email)
    const opened = JSON.parse(
      await bridge({ approved: false }).client_actions_mint(
        JSON.stringify({ next_turn_after: first?.id }),
      ),
    ) as { status: string; opened_id: string | null }
    expect(opened).toMatchObject({ status: "ok", opened_id: second?.id })
    expect((await rowsOf(targetId))[1]?.token_hash).not.toBeNull()
    await waitUntil(() => mailsTo(kit.w.clientA2.email) > before2)
    expect(mailsTo(kit.w.clientA2.email)).toBe(before2 + 1)
    // The same decision delivered again opens nothing more.
    const again = JSON.parse(
      await bridge({ approved: false }).client_actions_mint(
        JSON.stringify({ next_turn_after: first?.id }),
      ),
    ) as { opened_id: string | null }
    expect(again.opened_id).toBeNull()
  })

  it("no link is made outside a person's decision on the app's send", async () => {
    const targetId = crypto.randomUUID()
    const out = await send(false, targetId, "any")
    expect(out.error?.code).toBe("MINT_NEEDS_A_PERSON")
    expect(await rowsOf(targetId)).toEqual([])
  })

  it("a server with no timestamp authority refuses a signature send before any row", async () => {
    const targetId = crypto.randomUUID()
    mutableEnv.LIAISON_TSA_URL = undefined
    try {
      const out = await send(true, targetId, "any")
      expect(out.error?.code).toBe("TIMESTAMP_NOT_CONFIGURED")
    } finally {
      mutableEnv.LIAISON_TSA_URL = "https://tsa.example.test/"
    }
    expect(await rowsOf(targetId)).toEqual([])
  })

  it("the hosted edition refuses a signature send unless its operator turned signing on", async () => {
    const targetId = crypto.randomUUID()
    _setEdition("managed")
    try {
      const out = await send(true, targetId, "any")
      expect(out.error?.code).toBe("SIGNING_NOT_AVAILABLE")
      expect(await rowsOf(targetId)).toEqual([])
      mutableEnv.LIAISON_MANAGED_SIGNING_ENABLED = true
      expect((await send(true, targetId, "any")).status).toBe("ok")
    } finally {
      mutableEnv.LIAISON_MANAGED_SIGNING_ENABLED = false
      _setEdition(null)
    }
  })

  it("a newer version withdraws the old links with no decision; a void needs one", async () => {
    const targetId = crypto.randomUUID()
    await send(true, targetId, "any")
    const revoke = (approved: boolean, reason: string) =>
      bridge({ approved })
        .client_actions_revoke(
          JSON.stringify({ target_type: kit.targetType, target_id: targetId, reason }),
        )
        .then(
          (r: string) =>
            JSON.parse(r) as { status: string; error?: { code: string }; revoked_ids?: string[] },
        )
    expect((await revoke(false, "sender_voided")).error?.code).toBe("REVOKE_NEEDS_A_PERSON")
    const replaced = await revoke(false, "replaced")
    expect(replaced.revoked_ids).toHaveLength(2)
    const left = await sql`
      SELECT count(*)::int AS n FROM ${k("client_actions")}
       WHERE target_id = ${targetId} AND revoked_at IS NULL`
    expect(left[0]?.n).toBe(0)
  })
})
