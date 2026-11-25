// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed version as Knowledge: one document per signed version, written once the version is
// sealed, from its frozen text, closed to the organization (`org_access = none`) and shared by
// name. The signed file stays the record; this copy is for finding it, and the passage a person
// or the Scope check quotes always comes from the version's own text (agreement_passage_get).
//
// Who reads the copy: the people agreements itself knows. The agreement's list, the person who
// created it, the staff who signed this version, and the reader role the settings name; the
// person who sent it for signature writes the copy and reads it as its author, and the kernel
// adds whoever enabled the Scope check routine (`routine_owners_of`). On a restricted
// agreement exactly its list, nobody else, whatever the settings say.
//
// The one caller of the ingestion (`knowledge:create`, CROSS_APP_INGESTIONS, written by the
// kernel as the sender through `client_actions_signed_copy`) is `onAgreementSigned`, run by
// the seal on its first pass and by the seal retry for a signed version whose copy was not
// written. A superseding signed version archives the copies of the
// versions before it.

import { currentShares } from "./access"
import { type AgreementsCtx, bridgeAnswer } from "./ctx"

/** The routine template whose routines' owners read an open agreement's copy (spec 6.5). */
const SCOPE_CHECK_TEMPLATE = "scope-check"

/** The client action target a signed version is (send.ts `TARGET_TYPE`; not imported: send imports the seal). */
const TARGET_TYPE = "agreement_version"

interface SignedAgreement {
  id: string
  number: string
  title: string
  org_access?: string | null
  created_by_user_id?: string | null
}

interface SignedVersion {
  id: string
  agreement_id: string
  number: number
  status: string
  sha256?: string | null
  source_text?: string | null
  knowledge_document_id?: string | null
}

export type SowCtx = AgreementsCtx

export type SowOutcome =
  | { status: "created"; document_id: string; archived: string[] }
  | { status: "exists"; document_id: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }

/** The first line of the copy: the agreement, the version and the document's fingerprint. */
export function sowHeaderLine(a: { number: string }, v: SignedVersion): string {
  return `Agreement ${a.number}, version ${v.number}, document fingerprint sha256 ${v.sha256 ?? "unknown"}.`
}

/** Who the copy is shared with, and the role, by the rule above. */
export async function sowShares(
  ctx: AgreementsCtx,
  agreement: SignedAgreement,
  versionId?: string,
): Promise<{
  restricted: boolean
  users: Array<{ userId: string; role: "viewer" }>
  roles: Array<{ roleId: string; access: "viewer" }>
}> {
  const list = await currentShares(ctx, agreement.id)
  const restricted = agreement.org_access === "none"
  const ids = new Set(list.map((s) => s.user_id))
  if (!restricted && agreement.created_by_user_id) ids.add(agreement.created_by_user_id)
  if (!restricted && versionId) {
    // Staff who signed this version (a member signs on their own session).
    const events = (await ctx.db.findMany("signature_events", {
      where: { version_id: versionId },
      limit: 200,
    })) as Array<{ signer_user_id?: string | null }>
    for (const e of events) if (e.signer_user_id) ids.add(e.signer_user_id)
  }
  const roles: Array<{ roleId: string; access: "viewer" }> = []
  if (!restricted) {
    const [settings] = (await ctx.db.findMany("agreements_settings", { limit: 1 })) as Array<{
      sow_reader_role_id?: string | null
    }>
    if (settings?.sow_reader_role_id)
      roles.push({ roleId: settings.sow_reader_role_id, access: "viewer" })
  }
  return {
    restricted,
    users: [...ids].sort().map((userId) => ({ userId, role: "viewer" as const })),
    roles,
  }
}

/**
 * Write the Knowledge copy of one signed version, once. Never throws: a copy that could not be
 * written is tried again by the seal retry (the version keeps no document id until it is).
 *
 * The copy is written by the kernel as the person who sent the version for signature, under
 * their own row security (`client_actions_signed_copy`): the decided handler and the seal retry
 * run as the app, which Knowledge does not let write a person's closed document. When that
 * person is no longer active, can no longer write Knowledge, or (restricted) is off the list,
 * no copy is made, the seal goes on, and the agreement's activity says so.
 */
export async function onAgreementSigned(
  ctx: SowCtx,
  /** `announce: false` (the seal retry): a copy still not made is not said again. */
  input: { versionId: string; announce?: boolean },
): Promise<SowOutcome> {
  try {
    const version = (await ctx.db.findOne(
      "agreement_versions",
      input.versionId,
    )) as SignedVersion | null
    if (!version || version.status !== "signed")
      return { status: "skipped", reason: "The version is not signed." }
    if (version.knowledge_document_id)
      return { status: "exists", document_id: version.knowledge_document_id }
    const agreement = (await ctx.db.findOne(
      "agreements",
      version.agreement_id,
    )) as SignedAgreement | null
    if (!agreement) return { status: "skipped", reason: "No agreement holds this version." }
    if (typeof ctx.client_actions_signed_copy !== "function")
      return { status: "failed", reason: "Knowledge is not reachable on this run." }

    const shares = await sowShares(ctx, agreement, version.id)
    const body = `${sowHeaderLine(agreement, version)}\n\n${version.source_text ?? ""}`
    // The versions this one supersedes: their copies are archived once it is written.
    const older = (await ctx.db.findMany("agreement_versions", {
      where: { agreement_id: agreement.id },
      limit: 200,
    })) as SignedVersion[]
    const archiveIds = older
      .filter((v) => v.id !== version.id && v.number < version.number && v.knowledge_document_id)
      .map((v) => v.knowledge_document_id as string)
    const answer = bridgeAnswer<{
      status: string
      document_id?: string
      archived?: string[]
      code?: string
      message?: string
    }>(
      await ctx.client_actions_signed_copy({
        target_type: TARGET_TYPE,
        target_id: version.id,
        create: {
          documentScope: "organization",
          title: `${agreement.number} version ${version.number}: ${agreement.title}`,
          summary: `Signed text of ${agreement.number}, version ${version.number}. The signed file is the record.`,
          body,
          sensitivity: "internal",
          orgAccess: "none",
          shareWithUsers: shares.users,
          ...(shares.roles.length > 0 ? { shareWithRoles: shares.roles } : {}),
          idempotencyKey: `agreements:sow:${version.id}`,
        },
        archive_ids: archiveIds,
        ...(shares.restricted
          ? { readers_only: shares.users.map((u) => u.userId) }
          : { routine_owners_of: [SCOPE_CHECK_TEMPLATE] }),
      }),
    )
    if (answer.status !== "ok" || typeof answer.document_id !== "string") {
      const reason = answer.message ?? answer.code ?? "The Knowledge copy was not made."
      if (answer.status === "not_made" && input.announce !== false)
        await ctx.emit?.({
          entity: "agreement",
          action: "knowledge_copy_not_made",
          entityId: agreement.id,
          data: {
            number: agreement.number,
            version: version.number,
            code: answer.code ?? null,
            reason,
          },
        })
      return { status: "failed", reason }
    }
    await ctx.db.update("agreement_versions", version.id, {
      knowledge_document_id: answer.document_id,
    })
    return { status: "created", document_id: answer.document_id, archived: answer.archived ?? [] }
  } catch (err) {
    return { status: "failed", reason: (err as Error)?.message ?? "the copy was not written" }
  }
}
