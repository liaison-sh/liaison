// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What makes an agreement unfit for this signature, and what a person must look at first.
// Pure functions over the agreement row and its draft source.

/** Kinds of document this simple electronic signature never takes. */
export const UNFIT_TAGS = ["guarantee", "real_estate", "family", "employment"] as const

/** Kinds whose document prints a price a person set. */
export const PRICED_KINDS = ["proposal", "sow", "retainer"] as const

/** Words that make a document look like a personal guarantee or another unfit act. */
export const GUARANTEE_WORDS = [
  "caution",
  "cautionnement",
  "hypothèque",
  "hypotheque",
  "donation",
  "contrat de travail",
  "guarantee",
  "guaranty",
  "garantie personnelle",
  "mortgage",
  "employment contract",
]

/** Words naming a corporate act some readers need a higher signature level for. */
export const LAWYER_WORDS = [
  "minutes",
  "procès-verbal",
  "proces-verbal",
  "assemblée générale",
  "assemblee generale",
  "consultation écrite",
  "consultation ecrite",
  "general meeting",
  "filing",
  "dépôt au greffe",
]

export const PERSONAL_GUARANTEE_TEXT =
  "This looks like a personal guarantee or another act this signature does not fit. A person changes its kind, or says it is not one."

export const CHECK_WITH_LAWYER_TEXT =
  "Check with your lawyer first: some of these acts can need a higher signature level, which Liaison does not offer; another service can provide it."

export interface SourceBlock {
  type?: string
  text?: string
  agent_draft?: boolean
  [k: string]: unknown
}

export interface AgreementSource {
  body?: { blocks?: SourceBlock[]; [k: string]: unknown }
  data?: Record<string, unknown>
}

/** Every text an agreement's source prints, joined (headings, paragraphs, list lines, cells). */
export function sourceText(source: AgreementSource | null | undefined): string {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v)
    else if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (k !== "type" && k !== "fileId") walk(x)
    }
  }
  walk(source?.body?.blocks ?? [])
  return out.join("\n")
}

function holdsWord(text: string, words: readonly string[]): string | null {
  const t = text.toLowerCase()
  for (const w of words) {
    const re = new RegExp(
      `(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`,
      "u",
    )
    if (re.test(t)) return w
  }
  return null
}

export interface Check {
  code: string
  ok: boolean
  blocking: boolean
  message: string
}

export interface AgreementRowLike {
  number?: string | null
  kind?: string | null
  fit_tag?: string | null
  title?: string | null
  what_it_is?: string | null
  price_minor?: string | number | null
  not_a_guarantee_by_user_id?: string | null
}

/** The clauses an agent wrote that no person has read yet: their positions (1-based) and first words. */
export function agentDraftClauses(source: AgreementSource | null | undefined): string[] {
  const blocks = source?.body?.blocks ?? []
  return blocks.flatMap((b, i) =>
    b.agent_draft === true
      ? [`clause ${i + 1} "${String(b.text ?? b.type ?? "").slice(0, 40)}"`]
      : [],
  )
}

/** The checks prepare runs, in order. A failed blocking check refuses the freeze. */
export function prepareChecks(
  row: AgreementRowLike,
  source: AgreementSource | null,
  opts: { upload: boolean } = { upload: false },
): Check[] {
  const checks: Check[] = []
  const unfit = (UNFIT_TAGS as readonly string[]).includes(row.fit_tag ?? "")
  checks.push({
    code: "SIGNATURE_DOES_NOT_FIT",
    ok: !unfit,
    blocking: true,
    message: unfit
      ? `This document is tagged ${row.fit_tag}: a simple electronic signature does not fit it, so it cannot be sent for signature here.`
      : "The kind of document fits a simple electronic signature.",
  })
  if (row.kind === "other") {
    const said = (row.what_it_is ?? "").trim() !== ""
    checks.push({
      code: "WHAT_IT_IS_REQUIRED",
      ok: said,
      blocking: true,
      message: said
        ? `A person said what it is: ${row.what_it_is}.`
        : "A person must say what this document is before it can be sent (what_it_is).",
    })
  }
  const text = [row.title ?? "", row.what_it_is ?? "", sourceText(source)].join("\n")
  const word = holdsWord(text, GUARANTEE_WORDS)
  const cleared = !!row.not_a_guarantee_by_user_id
  checks.push({
    code: "PERSONAL_GUARANTEE",
    ok: word === null || cleared,
    blocking: true,
    message:
      word === null
        ? "No word of a personal guarantee or another unfit act."
        : cleared
          ? `The text holds "${word}"; a person said it is not a personal guarantee.`
          : `${PERSONAL_GUARANTEE_TEXT} (found "${word}")`,
  })
  const lawyer = holdsWord(text, LAWYER_WORDS)
  if (lawyer !== null) {
    checks.push({
      code: "CHECK_WITH_LAWYER",
      ok: true,
      blocking: false,
      message: `${CHECK_WITH_LAWYER_TEXT} (found "${lawyer}")`,
    })
  }
  if ((PRICED_KINDS as readonly string[]).includes(row.kind ?? "")) {
    const priced = row.price_minor !== null && row.price_minor !== undefined
    checks.push({
      code: "PRICE_NOT_SET",
      ok: priced,
      blocking: true,
      message: priced
        ? "A person set the price."
        : "No price yet: a person sets it in the agreement's page; an agent never does.",
    })
  }
  const drafts = agentDraftClauses(source)
  checks.push({
    code: "AGENT_TEXT_UNREAD",
    ok: drafts.length === 0,
    blocking: true,
    message:
      drafts.length === 0
        ? "Every clause was read by a person."
        : `A person must read and clear the clauses an agent wrote: ${drafts.join(", ")}.`,
  })
  if (!opts.upload) {
    // Only source.body.blocks is printed: a document with no text there is never frozen.
    const written = sourceText(source).trim() !== ""
    checks.push({
      code: "DOCUMENT_EMPTY",
      ok: written,
      blocking: true,
      message: written
        ? "The document has text."
        : "The document has no text: its clauses go in source.body.blocks (agreement_update); nothing else in source is printed.",
    })
  }
  return checks
}

/**
 * Marks the blocks an agent wrote or changed: every block of `next` that is not, word for word,
 * a block of `prev` carries `agent_draft: true`. A person's own save keeps the blocks as sent.
 */
export function markAgentBlocks(
  prev: AgreementSource | null | undefined,
  next: AgreementSource,
): AgreementSource {
  const key = (b: SourceBlock) => {
    const { agent_draft: _drop, ...rest } = b
    return JSON.stringify(rest)
  }
  const before = new Set((prev?.body?.blocks ?? []).filter((b) => b.agent_draft !== true).map(key))
  const blocks = (next.body?.blocks ?? []).map((b) =>
    before.has(key(b)) ? b : { ...b, agent_draft: true },
  )
  return { ...next, body: { ...(next.body ?? {}), blocks } }
}
