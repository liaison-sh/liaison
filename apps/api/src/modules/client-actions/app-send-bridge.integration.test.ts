// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app's doors into client actions (bridge/client-actions.ts): one person's
// decision on the app's gated send mints every signer of it, only the first
// with a link under "one after the other"; the next signer's link is opened by
// the decided handler with no card, and only once the signer before signed;
// no link is made outside a person's decision; a server that cannot seal a
// signature refuses the send before any row.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as dsql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  createClientActionsMethods,
  decidedActionFor,
} from "~/modules/apps/sandbox/bridge/client-actions"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { SignedCopyTestAccess } from "~/modules/client-actions/signed-copy"
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

async function send(
  approved: boolean,
  targetId: string,
  order: "sequential" | "any",
  extra: Record<string, unknown> = {},
) {
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
        ...extra,
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

  it("a pinned send check that does not cover every signer's address makes no link", async () => {
    const targetId = crypto.randomUUID()
    const at = new Date().toISOString()
    const guard = {
      v: 1,
      applies: true,
      mode: "plain",
      since: at,
      stagedAt: at,
      addresses: [kit.w.clientA.email],
      contactIds: [kit.w.clientA.contactId],
      refs: [],
      classification: "service",
    }
    const out = await send(true, targetId, "any", { send_guard: guard })
    expect(out.error?.code).toBe("SEND_GUARD_MISMATCH")
    expect(await rowsOf(targetId)).toEqual([])
    const both = await send(true, targetId, "any", {
      send_guard: {
        ...guard,
        addresses: [kit.w.clientA.email, kit.w.clientA2.email],
        contactIds: [kit.w.clientA.contactId, kit.w.clientA2.contactId],
      },
    })
    expect(both.status).toBe("ok")
    expect(await rowsOf(targetId)).toHaveLength(2)
  })

  it("a reminder mails each named open link with a fresh token; a waiting signer gets nothing", async () => {
    const targetId = crypto.randomUUID()
    const out = await send(true, targetId, "sequential")
    const [first] = out.actions ?? []
    await waitUntil(() => mailsTo(kit.w.clientA.email) > 0)
    const [before] = (await sql`
      SELECT token_hash FROM ${k("client_actions")} WHERE id = ${first?.id ?? ""}`) as unknown as Array<{
      token_hash: string
    }>
    const mailsA = mailsTo(kit.w.clientA.email)
    const mailsA2 = mailsTo(kit.w.clientA2.email)
    const remind = (approved: boolean) =>
      bridge({ approved })
        .client_actions_mint(
          JSON.stringify({ remind: { ids: (out.actions ?? []).map((a) => a.id) } }),
        )
        .then(
          (r: string) =>
            JSON.parse(r) as {
              status: string
              error?: { code: string }
              reminded?: Array<{ id: string }>
            },
        )
    expect((await remind(false)).error?.code).toBe("MINT_NEEDS_A_PERSON")
    const done = await remind(true)
    expect(done.reminded?.map((r: { id: string }) => r.id)).toEqual([first?.id])
    const [after] = (await sql`
      SELECT token_hash, prior_token_hashes FROM ${k("client_actions")}
       WHERE id = ${first?.id ?? ""}`) as unknown as Array<{
      token_hash: string
      prior_token_hashes: string[]
    }>
    expect(after?.token_hash).not.toBe(before?.token_hash)
    expect(after?.prior_token_hashes).toContain(before?.token_hash)
    await waitUntil(() => mailsTo(kit.w.clientA.email) > mailsA)
    expect(mailsTo(kit.w.clientA.email)).toBe(mailsA + 1)
    expect(mailsTo(kit.w.clientA2.email)).toBe(mailsA2)
  })

  it("a new link after a decline made without the code takes the signer's place; one after a proved decline is refused", async () => {
    const targetId = crypto.randomUUID()
    const out = await send(true, targetId, "any")
    const [first, second] = out.actions ?? []
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'declined'
               WHERE id = ${first?.id ?? ""}`
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'declined',
               code_verified_at = now() WHERE id = ${second?.id ?? ""}`
    const newLink = (approved: boolean, after: string, email?: string) =>
      bridge({ approved })
        .client_actions_mint(JSON.stringify({ new_link: { after, email } }))
        .then(
          (r: string) =>
            JSON.parse(r) as {
              status: string
              error?: { code: string }
              replaced_id?: string
              action?: { id: string; status: string; invited_email: string }
            },
        )
    expect((await newLink(false, first?.id ?? "")).error?.code).toBe("MINT_NEEDS_A_PERSON")
    const corrected = `fixed-${kit.w.clientA.email}`
    const made = await newLink(true, first?.id ?? "", corrected)
    expect(made.status).toBe("ok")
    expect(made.replaced_id).toBe(first?.id)
    expect(made.action?.status).toBe("open")
    expect(made.action?.invited_email).toBe(corrected)
    const [row] = (await sql`
      SELECT group_id, contact_id FROM ${k("client_actions")} WHERE id = ${made.action?.id ?? ""}`) as unknown as Array<{
      group_id: string
      contact_id: string
    }>
    const [orig] = (await sql`
      SELECT group_id FROM ${k("client_actions")} WHERE id = ${first?.id ?? ""}`) as unknown as Array<{
      group_id: string
    }>
    expect(row?.group_id).toBe(orig?.group_id)
    // A corrected address is not the contact's: the new signer is tied to no contact.
    expect(row?.contact_id).toBeNull()
    expect((await newLink(true, second?.id ?? "")).error?.code).toBe("DECLINED_BY_SIGNER")
  })

  it("a new link on a restricted record keeps its list: a member off the list sees neither the new link nor its decision", async () => {
    const targetId = crypto.randomUUID()
    const list = [kit.w.admin.userId]
    const out = await send(true, targetId, "any", { visible_to: list })
    const [first] = out.actions ?? []
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'declined'
               WHERE id = ${first?.id ?? ""}`
    const made = JSON.parse(
      await bridge({ approved: true }).client_actions_mint(
        JSON.stringify({ new_link: { after: first?.id ?? "" } }),
      ),
    ) as { status: string; action?: { id: string } }
    expect(made.status).toBe("ok")
    const newId = made.action?.id ?? ""
    const [row] = (await sql`
      SELECT visible_to FROM ${k("client_actions")} WHERE id = ${newId}`) as unknown as Array<{
      visible_to: string[] | null
    }>
    expect(row?.visible_to).toEqual(list)
    const seen = async (userId: string) =>
      withRlsContext(
        {
          actorType: "user",
          userId,
          orgId: kit.w.orgId,
          scopes: ["*"],
          dimensionGrants: {},
        } as UserContext,
        async (tx) =>
          extractRows<{ id: string }>(
            await tx.execute(
              dsql`SELECT id FROM ${dsql.raw(schemaRef("kernel"))}.client_actions WHERE id = ${newId}`,
            ),
          ).length,
      )
    expect(await seen(kit.w.member.userId)).toBe(0)
    expect(await seen(kit.w.admin.userId)).toBe(1)
  })

  it("a call chained from a decision acts as the approver of the decided link, never of a send that failed or of another person's link", async () => {
    const { peopleOfSignedTarget } = SignedCopyTestAccess
    const targetId = crypto.randomUUID()
    const admin = kit.w.admin.userId
    const member = kit.w.member.userId
    // A first send that failed and was withdrawn, approved by the member.
    const failed = (await send(true, targetId, "any")).actions ?? []
    await sql`UPDATE ${k("client_actions")} SET revoked_at = now(), revoke_reason = 'withdrawn', approved_by_user_id = ${member}
               WHERE id IN ${sql(failed.map((a) => a.id))}`
    // The send that was decided: its first signer approved under the admin, a later link under
    // the member.
    const [a1, a2] = (await send(true, targetId, "any")).actions ?? []
    await sql`UPDATE ${k("client_actions")} SET decision = 'signed', decided_at = now() - interval '1 minute',
               approved_by_user_id = ${admin} WHERE id = ${a1?.id ?? ""}`
    await sql`UPDATE ${k("client_actions")} SET decision = 'signed', decided_at = now(),
               approved_by_user_id = ${member} WHERE id = ${a2?.id ?? ""}`
    const base = {
      orgId: kit.w.orgId,
      targetApp: kit.targetApp,
      targetType: kit.targetType,
      targetId,
    }
    expect((await peopleOfSignedTarget(base))?.approver).toBe(admin)
    expect((await peopleOfSignedTarget({ ...base, decidedActionId: a2?.id }))?.approver).toBe(
      member,
    )
    // A link that was not decided positively names nobody.
    expect(await peopleOfSignedTarget({ ...base, decidedActionId: failed[0]?.id })).toBeNull()
  })

  it("only the decided handler's own event, or the app's job naming a link, runs on the approver's act", () => {
    const id = crypto.randomUUID()
    const other = crypto.randomUUID()
    const handler = { jobsAttributedToSystem: true, decidedActionId: id }
    expect(decidedActionFor({ bridgeOptions: handler, approved: false, named: other })).toBe(id)
    // Another event's handler (no decided event) gets none, whatever the app names.
    expect(
      decidedActionFor({
        bridgeOptions: { jobsAttributedToSystem: true },
        approved: false,
        named: id,
      }),
    ).toBeNull()
    expect(
      decidedActionFor({ bridgeOptions: { currentJob: {} }, approved: false, named: id }),
    ).toBe(id)
    // An agent's, a routine's, an approval's or a person's own run: none.
    expect(
      decidedActionFor({ bridgeOptions: handler, actorType: "agent", approved: false, named: id }),
    ).toBeNull()
    expect(
      decidedActionFor({
        bridgeOptions: { currentJob: {} },
        routineId: "r",
        approved: false,
        named: id,
      }),
    ).toBeNull()
    expect(decidedActionFor({ bridgeOptions: handler, approved: true, named: id })).toBeNull()
    expect(
      decidedActionFor({ bridgeOptions: { origin: "human-ui" }, approved: false, named: id }),
    ).toBeNull()
  })

  it("an app lists the links of its own target with each signer's turn and state", async () => {
    const targetId = crypto.randomUUID()
    await send(true, targetId, "sequential")
    const listed = JSON.parse(
      await bridge({ approved: false }).client_actions_record(
        JSON.stringify({ target_type: kit.targetType, target_id: targetId }),
      ),
    ) as { links: Array<{ invited_email: string; sign_order: number; state: string }> }
    expect(listed.links.map((l) => [l.invited_email, l.sign_order, l.state])).toEqual([
      [kit.w.clientA.email, 1, "open"],
      [kit.w.clientA2.email, 2, "waiting_turn"],
    ])
    expect(JSON.stringify(listed)).not.toContain("token")
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
    // The app's own event handler closes a link made beside a void; it withdraws for no other reason,
    // and neither a job nor a tool run is one.
    const asRun = async (bridgeOptions: object, reason: string) =>
      JSON.parse(
        await createClientActionsMethods({
          appName: kit.targetApp,
          orgId: kit.w.orgId,
          userId: kit.w.admin.userId,
          actorType: "system",
          bridgeOptions,
        } as unknown as BridgeContext).client_actions_revoke(
          JSON.stringify({ target_type: kit.targetType, target_id: crypto.randomUUID(), reason }),
        ),
      ) as { status: string; error?: { code: string } }
    const handler = { jobsAttributedToSystem: true }
    expect((await asRun(handler, "sender_voided")).status).toBe("ok")
    for (const reason of ["withdrawn", "access_ended", "person_removed"])
      expect((await asRun(handler, reason)).error?.code).toBe("REVOKE_NEEDS_A_PERSON")
    for (const run of [{ currentJob: { name: "j" } }, { origin: "human-ui" }])
      expect((await asRun(run, "sender_voided")).error?.code).toBe("REVOKE_NEEDS_A_PERSON")
    const replaced = await revoke(false, "replaced")
    expect(replaced.revoked_ids).toHaveLength(2)
    const left = await sql`
      SELECT count(*)::int AS n FROM ${k("client_actions")}
       WHERE target_id = ${targetId} AND revoked_at IS NULL`
    expect(left[0]?.n).toBe(0)
  })
})
