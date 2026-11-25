// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The fingerprint of what issuing an invoice draft would write, as the person deciding it saw it:
// the draft's own content, the tax country it is billed under, the payment terms it will be due by
// when it has no due date of its own, and the amount to pay. An issue approval carries it as
// `draft_hash` from the moment it is made (the preflight pins it on a call, and a handler that parks
// the card states it), as `2:<sha256>:<amount>`.
//
// When the draft, or terms it would be due by, change while an approval waits, its card is redrawn
// with the new fingerprint (a decision on the old card is refused by its payload hash). Whatever
// path made the change, the issue refuses a draft whose fingerprint is not the one on the approval,
// and an amount that is not the one on it.
import { sha256Hex } from "../einvoicing/backfill-sha256"
import { storedTaxCountry, taxCountryOf } from "../issue"
import { utf8Bytes } from "../legal-originals/bytes"
import { paymentTermsOf } from "../payment-terms"
import { findIssuerProfile, getDraft } from "./db-helpers"
import {
  asJson,
  draftContentHash,
  draftInWords,
  type HashableDraft,
  upperFirst,
  type WithdrawCtx,
} from "./issue-handover"
import { computeLineFinancials, counterpartyFromRow } from "./lines"
import { checkDraftBuyer } from "./quote-proforma-po"
import type { DraftRow, ErrorEnvelope, MutationsCtx, PendingApprovalEnvelope } from "./shared"

type DbCtx = Pick<MutationsCtx, "db">

/** The amount issuing a draft writes, VAT included, for a customer with or without a VAT number. */
function amountOf(
  draft: DraftRow,
  issuer: { country: string },
  counterparty: Parameters<typeof taxCountryOf>[0] & { vat_id?: string | null },
): bigint {
  return computeLineFinancials(draft.lines ?? [], {
    issuer_country: issuer.country,
    counterparty_country: taxCountryOf(counterparty),
    has_vat_id: !!counterparty.vat_id,
  }).grand
}

/** The amount a draft issues at from its own columns: what a card made with the draft says. */
export async function draftAmount(ctx: DbCtx, draft: DraftRow): Promise<bigint | null> {
  const issuer = await findIssuerProfile(ctx.db, draft.issuer_profile_id)
  return issuer ? amountOf(draft, issuer, counterpartyFromRow(draft, issuer)) : null
}

/** The same, with the VAT number the issue would find for the customer: what a redrawn card says. */
async function foundAmount(ctx: MutationsCtx, draft: DraftRow): Promise<bigint | null> {
  const issuer = await findIssuerProfile(ctx.db, draft.issuer_profile_id)
  if (!issuer) return null
  const own = counterpartyFromRow(draft, issuer)
  const buyer = await checkDraftBuyer(ctx, draft, issuer, own).catch(() => null)
  return amountOf(draft, issuer, buyer?.ok ? buyer.counterparty : own)
}

async function termsOfDraft(ctx: DbCtx, draft: DraftRow): Promise<number | null> {
  if (draft.due_at || draft.type !== "invoice") return null
  return (
    await paymentTermsOf(ctx.db, {
      issuer: { id: draft.issuer_profile_id },
      contactId: draft.counterparty_contact_id,
      externalRefs: draft.external_refs,
    })
  ).days
}

async function contentOf(ctx: DbCtx, draft: DraftRow): Promise<string> {
  return sha256Hex(
    utf8Bytes(
      JSON.stringify([
        draftContentHash(draft as HashableDraft),
        storedTaxCountry(draft),
        draft.external_refs?.buyer_is_consumer === true,
        await termsOfDraft(ctx, draft),
      ]),
    ),
  )
}

/** The fingerprint of a draft shown at an amount. */
export async function issueFingerprint(
  ctx: DbCtx,
  draft: DraftRow,
  amount: bigint | number | string | null,
): Promise<string> {
  return `2:${await contentOf(ctx, draft)}:${amount === null ? "" : String(amount)}`
}

/** The amount a fingerprint was made at, or null when it names none. */
export function approvedAmount(shown: string | null | undefined): string | null {
  const m = typeof shown === "string" ? /^2:[0-9a-f]+:(-?\d+)$/.exec(shown) : null
  return m ? (m[1] as string) : null
}

/**
 * The payload of an issue approval a handler parks for a draft: the draft and its fingerprint as
 * the card shows it, so the issue refuses the draft once anything about it changes.
 */
export async function issuePayloadFor(
  ctx: DbCtx,
  draftId: string,
): Promise<{ draft_id: string; draft_hash?: string }> {
  const draft = await getDraft(ctx.db, draftId)
  return draft
    ? {
        draft_id: draftId,
        draft_hash: await issueFingerprint(ctx, draft, await draftAmount(ctx, draft)),
      }
    : { draft_id: draftId }
}

type RestageCtx = WithdrawCtx & MutationsCtx

interface WaitingCard {
  id: string
  draftId: string
  hash: unknown
}

async function waitingCards(ctx: WithdrawCtx): Promise<WaitingCard[]> {
  const pendingFor = ctx.approvals?.pendingFor
  if (!pendingFor) return []
  const raw = asJson(await pendingFor("draft_id", ["invoicing:invoice_issue"]))
  const rows = (Array.isArray(raw) ? raw : []) as Array<{
    id?: unknown
    target_id?: unknown
    payload?: unknown
  }>
  return rows.flatMap((r) =>
    typeof r.id === "string" && typeof r.target_id === "string"
      ? [
          {
            id: r.id,
            draftId: r.target_id,
            hash: (asJson(r.payload) as { draft_hash?: unknown } | null)?.draft_hash,
          },
        ]
      : [],
  )
}

async function redraw(
  ctx: RestageCtx,
  card: WaitingCard,
  draft: DraftRow,
  hash: string,
  why: string,
): Promise<boolean> {
  if (card.hash === hash) return false
  const res = asJson(await ctx.approvals?.restagePayload?.(card.id, { draft_hash: hash }, why)) as {
    ok?: unknown
  } | null
  return res?.ok === true
}

/**
 * After a draft is edited, its issue approvals still waiting are redrawn: each gets the draft's new
 * fingerprint, so the kernel rebuilds its card from the edited draft and a decision taken on the
 * card as it was is refused. Best effort: the issue itself checks the fingerprint again.
 */
export async function restageIssueApprovals(ctx: RestageCtx, draft: DraftRow): Promise<string[]> {
  if (!ctx.approvals?.restagePayload) return []
  const done: string[] = []
  try {
    const cards = (await waitingCards(ctx)).filter((c) => c.draftId === draft.id)
    if (cards.length === 0) return []
    const hash = await issueFingerprint(ctx, draft, await foundAmount(ctx, draft))
    for (const card of cards)
      if (await redraw(ctx, card, draft, hash, `${upperFirst(draftInWords(draft))} was edited.`))
        done.push(card.id)
  } catch (err) {
    ctx.logger?.warn?.("redrawing the draft's issue approval failed", {
      draftId: draft.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return done
}

/**
 * After payment terms change (a customer's, or an issuer's default), the issue approvals waiting on
 * a draft that would be due by them are redrawn with the new terms. Best effort, as above.
 */
export async function restageForTerms(
  ctx: RestageCtx,
  whose: { contactId?: string; issuerId?: string },
): Promise<string[]> {
  if (!ctx.approvals?.restagePayload) return []
  const done: string[] = []
  try {
    for (const card of await waitingCards(ctx)) {
      const draft = await getDraft(ctx.db, card.draftId)
      if (!draft || draft.due_at) continue
      const theirs =
        whose.contactId !== undefined
          ? draft.counterparty_contact_id === whose.contactId
          : draft.issuer_profile_id === whose.issuerId
      if (!theirs) continue
      // Only the terms changed: the amount the card shows stays the one it was made at.
      const hash = await issueFingerprint(
        ctx,
        draft,
        approvedAmount(typeof card.hash === "string" ? card.hash : null) ??
          (await draftAmount(ctx, draft)),
      )
      if (
        await redraw(ctx, card, draft, hash, `The payment terms of ${draftInWords(draft)} changed.`)
      )
        done.push(card.id)
    }
  } catch (err) {
    ctx.logger?.warn?.("redrawing the issue approvals of changed terms failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return done
}

/**
 * Whether the card a call issues from was made before cards held what issuing writes: a fingerprint
 * of the older shape, or an approval with none. Nothing says its approver saw the tax country, the
 * terms or the amount, so it issues nothing and is asked again.
 */
export function olderCard(
  ctx: Pick<MutationsCtx, "approval">,
  shown: string | null | undefined,
): boolean {
  if (typeof shown === "string" && shown !== "") return !shown.startsWith("2:")
  return ctx.approval?.toolName === "invoicing:invoice_issue"
}

/**
 * The issue's own check, the one every edit path meets: a draft whose fingerprint is not the one
 * its approval carries is not issued from that card, whether it was edited through drafts_update,
 * documents_update, a Shopify sync or anything else, or the terms it would be due by changed. A
 * call with no approval and no fingerprint (a person's own) is not checked; an older card is
 * `olderCard`'s. The amount is checked by the issue itself, before a number is taken.
 */
export async function draftChangedSinceCard(
  ctx: DbCtx,
  draft: DraftRow,
  shownHash: string | null | undefined,
): Promise<ErrorEnvelope | null> {
  if (typeof shownHash !== "string" || !shownHash.startsWith("2:")) return null
  if (shownHash.split(":")[1] === (await contentOf(ctx, draft))) return null
  return {
    status: "error",
    error: {
      code: "draft_changed",
      message: `${upperFirst(draftInWords(draft))} was not issued: it changed after this request was made, or the payment terms it is due by did. Nothing was numbered. Ask for its issue again so the card shows what will be issued.`,
    },
  }
}

/**
 * The answer of an older card: nothing issued, and the request that asks again. The approval it ran
 * from is done, as a run's is whose rows ask again: the new request is the one to decide.
 */
export function askedAgain(
  draft: DraftRow,
  approvalId: string | null,
): ErrorEnvelope | PendingApprovalEnvelope {
  const why = `${upperFirst(draftInWords(draft))} was not issued: this request was made before issue requests showed the amount, the tax country and the due terms. Nothing was numbered.`
  return approvalId
    ? {
        status: "pending_approval",
        approval_id: approvalId,
        message: `${why} Its issue is asked again, showing them: decide that request.`,
      }
    : {
        status: "error",
        error: {
          code: "draft_changed",
          message: `${why} Ask for its issue again so the card shows them.`,
        },
      }
}
