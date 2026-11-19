// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `studio-cr-accepted`: the client scenario's live event. The fixed-price
// client approves the change request the visitor sent her (the card approved
// on the beat before minted its link).
//
// The client is fictional, so nobody opens the link. As the app would hear a
// real answer: the action is resolved from the world's named change request in
// this workspace (never an id from a request), and the demo decide records the
// decision with its signature event as a stand-in (level `demo`, "no signature
// took place"), written in the decision's transaction once the decide's guards
// passed, and queues the decided event. A demo box only: elsewhere the beat
// refuses, and a refused decide leaves no stand-in behind. The agreements
// app's own handler hears it, finds the stand-in event, accepts the change
// request and runs its effects (the contract total, the timebox, the task, the
// planned billing line); the seal records a stand-in and nothing else: no seal
// key, no signed copy, no timestamp, no copy mail.
//
// Once per run: the registry's mark keeps a second click from running it, and
// an action already decided is left as it is.
import { STUDIO_CR_ACCEPTED_INJECTOR } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { decideDemoClientAction } from "~/modules/client-actions/demo-decide"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import type { WorldInjector, WorldInjectorContext } from "~/modules/demo/world/registry"
import { seedContext } from "~/seed/context"
import { studioAgreements, writeStandInSignatureEvent } from "~/seed/worlds/studio/agreements"

const K = () => sql.raw(schemaRef("kernel"))
const A = () => sql.raw(schemaRef("app_agreements"))

/** The client action of the world's change request, as the approved card minted it. */
export interface ChangeRequestAction {
  actionId: string
  agreementId: string
  versionId: string
  decided: boolean
  signOrder: number | null
  contactId: string | null
  invitedEmail: string
  invitedName: string
  senderName: string
  documentSha256: string
}

/**
 * The newest live client action on the world's named change request in `orgId`: the change
 * request the card sent, under the signed statement of work it amends. Null before the card is
 * approved (no change request was sent).
 */
export async function worldChangeRequestAction(orgId: string): Promise<ChangeRequestAction | null> {
  const cr = studioAgreements(new Date()).changeRequest
  const parentId = seedContext({ orgId, now: new Date() }).id("agreement", `studio:${cr.parent}`)
  const [row] = await withPrivilegedDb(orgId, "demo-studio-cr-action", async (tx) =>
    extractRows<{
      action_id: string
      agreement_id: string
      version_id: string
      decided: boolean
      sign_order: number | null
      contact_id: string | null
      invited_email: string
      invited_name: string
      sender_name: string | null
      target_sha256: string
    }>(
      await tx.execute(sql`
        SELECT a.id::text AS action_id, g.id::text AS agreement_id, v.id::text AS version_id,
               (a.decided_at IS NOT NULL) AS decided, a.sign_order, a.contact_id::text AS contact_id,
               a.invited_email, a.invited_name, u.name AS sender_name, a.target_sha256
          FROM ${K()}.client_actions a
          JOIN ${A()}.agreement_versions v ON v.id = a.target_id AND v.org_id = a.org_id
          JOIN ${A()}.agreements g ON g.id = v.agreement_id AND g.org_id = a.org_id
          LEFT JOIN ${K()}.users u ON u.id = a.created_by_user_id AND u.org_id = a.org_id
         WHERE a.org_id = ${orgId}::uuid
           AND a.target_app = 'agreements' AND a.target_type = 'agreement_version'
           AND a.revoked_at IS NULL
           AND g.kind = 'change_request' AND g.parent_agreement_id = ${parentId}::uuid
           AND g.title = ${cr.title}
         ORDER BY a.created_at DESC
         LIMIT 1`),
    ),
  )
  if (!row) return null
  return {
    actionId: row.action_id,
    agreementId: row.agreement_id,
    versionId: row.version_id,
    decided: row.decided,
    signOrder: row.sign_order,
    contactId: row.contact_id,
    invitedEmail: row.invited_email,
    invitedName: row.invited_name,
    senderName: row.sender_name ?? "",
    documentSha256: row.target_sha256,
  }
}

/**
 * The client's answer: the demo decide, which writes the stand-in signature event in the
 * decision's own transaction once every guard has passed. A refused decide leaves no stand-in.
 */
export async function acceptWorldChangeRequest(orgId: string): Promise<ChangeRequestAction> {
  // A stand-in answer is a demo box's only: a year or self-hosted box seeds this world too.
  if (!isDemoModeEnabled()) {
    throw new Error(
      "This server is not a demo server: the client's answer is not played here. Nothing was accepted.",
    )
  }
  const action = await worldChangeRequestAction(orgId)
  if (!action) {
    throw new Error(
      "The change request has not been sent: approve its card first. Nothing was accepted.",
    )
  }
  // Answered already (a replay of this run): nothing more to write.
  if (action.decided) return action
  const ctx = seedContext({ orgId, now: new Date() })
  const decided = await decideDemoClientAction({
    orgId,
    actionId: action.actionId,
    target: { app: "agreements", type: "agreement_version" },
    standIn: (tx) =>
      writeStandInSignatureEvent(tx, {
        id: ctx.id("signature_event", `studio:cr-accepted:${action.actionId}`),
        orgId,
        versionId: action.versionId,
        clientActionId: action.actionId,
        signerOrder: action.signOrder,
        signerContactId: action.contactId,
        signerUserId: null,
        invitedEmail: action.invitedEmail,
        invitedBy: action.senderName,
        typedName: action.invitedName,
        capacity: "",
        documentSha256: action.documentSha256,
        at: new Date(),
      }),
  })
  if (!decided.ok) {
    // Decided meanwhile by another pass: the decision stands, once.
    const now = await worldChangeRequestAction(orgId)
    if (now?.actionId === action.actionId && now.decided) return now
    throw new Error(decided.message)
  }
  return { ...action, decided: true }
}

export const studioCrAcceptedInjector: WorldInjector = {
  id: STUDIO_CR_ACCEPTED_INJECTOR,
  world: "studio",
  // The app's handler runs; no agent turn and no routine: nothing spends.
  spends: false,
  async injectWorldEvent(ctx: WorldInjectorContext) {
    await acceptWorldChangeRequest(ctx.orgId)
  },
  async entityOf(ctx: WorldInjectorContext) {
    return (await worldChangeRequestAction(ctx.orgId))?.agreementId ?? null
  },
}
