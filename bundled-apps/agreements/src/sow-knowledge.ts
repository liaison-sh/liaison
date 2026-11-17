// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A signed version as Knowledge: one document per signed version, written once the version is
// sealed, from its frozen text, closed to the organization (`org_access = none`) and shared by
// name. The signed file stays the record; this copy is for finding it, and the passage a person
// or the Scope check quotes always comes from the version's own text (agreement_passage_get).
//
// Who reads the copy: the agreement's list and the person who created it, and the reader role
// the settings name. On a restricted agreement exactly its list, nobody else, whatever the
// settings say.
//
// The one caller of the ingestion (`knowledge:create`, CROSS_APP_INGESTIONS) is
// `onAgreementSigned`, run by the seal on its first pass and by the seal retry for a signed
// version whose copy was not written. A superseding signed version archives the copies of the
// versions before it.

import { currentShares } from "./access"
import type { AgreementsCtx } from "./ctx"

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
): Promise<{
  restricted: boolean
  users: Array<{ userId: string; role: "viewer" }>
  roles: Array<{ roleId: string; access: "viewer" }>
}> {
  const list = await currentShares(ctx, agreement.id)
  const restricted = agreement.org_access === "none"
  const ids = new Set(list.map((s) => s.user_id))
  if (!restricted && agreement.created_by_user_id) ids.add(agreement.created_by_user_id)
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
 */
export async function onAgreementSigned(
  ctx: SowCtx,
  input: { versionId: string },
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
    if (typeof ctx.executeTool !== "function")
      return { status: "failed", reason: "Knowledge is not reachable on this run." }

    const shares = await sowShares(ctx, agreement)
    const readers = shares.users.map((u) => u.userId)
    const owner =
      agreement.created_by_user_id && readers.includes(agreement.created_by_user_id)
        ? agreement.created_by_user_id
        : (readers[0] ?? null)
    const body = `${sowHeaderLine(agreement, version)}\n\n${version.source_text ?? ""}`
    const env = await ctx.executeTool("knowledge:create", {
      documentScope: "organization",
      title: `${agreement.number} version ${version.number}: ${agreement.title}`,
      summary: `Signed text of ${agreement.number}, version ${version.number}. The signed file is the record.`,
      body,
      sensitivity: "internal",
      orgAccess: "none",
      // Written in the name of a person who reads it: the creator when on the list, else the
      // first person on it (a system run has no person of its own).
      ...(owner ? { ownerUserId: owner } : {}),
      shareWithUsers: shares.users,
      ...(shares.roles.length > 0 ? { shareWithRoles: shares.roles } : {}),
      idempotencyKey: `agreements:sow:${version.id}`,
    })
    if (env.status !== "completed")
      return {
        status: "failed",
        reason:
          env.status === "error"
            ? `${env.error.code}: ${env.error.message}`
            : "The Knowledge copy waits on an approval it should never need.",
      }
    const documentId = (env.result as { id?: unknown } | null)?.id
    if (typeof documentId !== "string" || documentId === "")
      return { status: "failed", reason: "Knowledge answered without a document id." }
    await ctx.db.update("agreement_versions", version.id, { knowledge_document_id: documentId })

    // The versions this one supersedes: their copies are archived.
    const older = (await ctx.db.findMany("agreement_versions", {
      where: { agreement_id: agreement.id },
      limit: 200,
    })) as SignedVersion[]
    const archived: string[] = []
    for (const v of older) {
      if (v.id === version.id || v.number >= version.number || !v.knowledge_document_id) continue
      const out = await ctx.executeTool("knowledge:archive", { id: v.knowledge_document_id })
      if (out.status === "completed") archived.push(v.knowledge_document_id)
    }
    return { status: "created", document_id: documentId, archived }
  } catch (err) {
    return { status: "failed", reason: (err as Error)?.message ?? "the copy was not written" }
  }
}
