// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A stand-in signature (level `demo`, written only by the demo seed) never passes as a real one.
// The two evidence reads name the level they read; on a stand-in they say so and check nothing:
// there is no evidence file to download or verify.
import type { AgreementsCtx } from "./ctx"
import { agreementEvidenceGet, agreementVerify, packageOf, type SealCtx } from "./seal"

export const STAND_IN_SENTENCE =
  "In this demo the signature, seal and timestamp are stand-ins. No signature took place."

interface Found {
  agreement: { id: string; number: string; title?: string }
  version: { id: string; number: number }
  level: string | null
}

/** The signed version an id names (a version id, or an agreement's latest signed version). */
async function levelOf(ctx: AgreementsCtx, id: unknown): Promise<Found | null> {
  if (typeof id !== "string" || id.length === 0) return null
  type V = { id: string; number: number; agreement_id: string; status?: string }
  type A = { id: string; number: string; title?: string }
  let version = (await ctx.db.findOne("agreement_versions", id)) as V | null
  let agreement: A | null = null
  if (version) agreement = (await ctx.db.findOne("agreements", version.agreement_id)) as A | null
  else {
    agreement = (await ctx.db.findOne("agreements", id)) as A | null
    if (agreement) {
      const signed = (await ctx.db.findMany("agreement_versions", {
        where: { agreement_id: agreement.id, status: "signed" },
        limit: 50,
      })) as V[]
      version = signed.sort((a, b) => b.number - a.number)[0] ?? null
    }
  }
  if (!agreement || !version) return null
  const pkg = await packageOf(ctx, version.id)
  if (!pkg) return null
  return {
    agreement: { id: agreement.id, number: agreement.number, title: agreement.title },
    version: { id: version.id, number: version.number },
    level: (pkg as { level?: string | null }).level ?? null,
  }
}

// The agreement is named as the real answer names it (`agreement.id`), so the read of a
// restricted agreement is stamped restricted on a stand-in too.
function standIn(found: Found, what: string) {
  return {
    status: "ok",
    agreement: found.agreement,
    version: found.version.number,
    level: "demo",
    result: "stand-in",
    message: `${found.agreement.number} version ${found.version.number}: stand-in. ${STAND_IN_SENTENCE} ${what}`,
  }
}

/** `agreement_verify`: the level it read; a stand-in is answered as one, never as valid. */
export async function agreementVerifyNamed(ctx: SealCtx, p: { id: string }) {
  const found = await levelOf(ctx, p?.id)
  if (found?.level === "demo")
    return standIn(found, "Nothing was checked: there is no evidence to verify.")
  const out = await agreementVerify(ctx, p)
  return found && out.status === "ok" ? { ...out, level: found.level } : out
}

/** `agreement_evidence_get`: the level it read; a stand-in has no evidence file to offer. */
export async function agreementEvidenceGetNamed(ctx: AgreementsCtx, p: { id: string }) {
  const found = await levelOf(ctx, p?.id)
  if (found?.level === "demo")
    return standIn(found, "There is no evidence file to download or check.")
  const out = await agreementEvidenceGet(ctx, p)
  if (!found || (out as { status?: string }).status !== "ok") return out
  return { ...(out as Record<string, unknown>), level: found.level }
}
