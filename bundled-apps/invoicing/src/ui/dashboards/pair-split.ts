// SPDX-License-Identifier: FSL-1.1-ALv2
import { tr } from "../i18n"
//
// Keep documents that belong together TOGETHER in the documents list. Two
// link kinds share this one adjacency/ordering mechanism:
//
// 1. SPLIT PAIRS -- the Shopify auto-flow splits a mixed order into a `goods`
//    document (physical lines; the commercial invoice customs sees) and a
//    `software` one (digital lines, which customs must never tariff). That
//    split is deliberate and the two halves must stay separate ON PAPER --
//    nothing on either PDF may hint the other exists, or the split defeats
//    itself at the border.
//
// 2. CREDIT GROUPS -- a credit note belongs next to the invoice it credits
//    (`external_refs.original_document_id`). One invoice can have several
//    credit notes; they all read as one contiguous group, invoice first.
//
// Internally both are the same problem: rows that belong together only LOOK
// adjacent until something else issues in between (INV-2026-3455 sits
// between the halves of another order on prod), and a list sorted by date,
// customer or amount scatters them entirely. An operator then has to know,
// from nothing on screen, that two (or more) documents are one thing.
//
// So: pair them in OUR list, never on the document.

export interface PairableRow {
  id: string
  number?: string | null
  shopify_order_number?: string | null
  scope?: "goods" | "software" | string | null
  /** Document type discriminator. Used to find the invoice anchoring a
   *  credit-note group ("credit_note" vs anything else). */
  type?: string | null
  /** The id of the invoice this credit note credits
   *  (`external_refs.original_document_id`). Null/absent for anything that
   *  is not a credit note, or a credit note issued before that link existed. */
  original_document_id?: string | null
  /** The visible number of the invoice this credit note credits, for the
   *  on-row "Credits INV-..." text. */
  original_document_number?: string | null
  /** Issue timestamp -- tie-break for ordering multiple credit notes against
   *  the same invoice, oldest first. */
  issued_at?: string | null
  /** Visible numbers of this document's own ISSUED credit notes, server-derived from its
   *  lifecycle_log (see reads.ts). Backs the "Credited by ..." indicator when the credit note
   *  itself is not co-resident in the current view -- see creditedIndicatorOf below. */
  credited_by_numbers?: string[] | null
}

/** Where a row sits in a group, for the visual link. A group of exactly two
 *  members only ever produces "first"/"last" (the split pair's original
 *  shape); three or more members put "middle" on everything in between. */
export type PairPosition = "first" | "middle" | "last" | null

export interface PairedRow<R> {
  row: R
  /** Stable key shared by every member, or null when the row is not paired. */
  pairKey: string | null
  position: PairPosition
  /** Which link kind produced this group, or null when unpaired. */
  kind: "split" | "credit" | null
}

interface Group<R> {
  kind: "split" | "credit"
  pairKey: string
  members: R[]
}

function splitOrderKey(r: PairableRow): string | null {
  const order = r.shopify_order_number?.trim()
  if (!order) return null
  if (r.scope !== "goods" && r.scope !== "software") return null
  return order
}

/** Only a COMPLETE goods+software pair is worth reordering for. */
function buildSplitGroups<R extends PairableRow>(rows: R[]): Map<string, Group<R>> {
  const byOrder = new Map<string, R[]>()
  for (const r of rows) {
    const order = splitOrderKey(r)
    if (!order) continue
    const list = byOrder.get(order)
    if (list) list.push(r)
    else byOrder.set(order, [r])
  }
  const groups = new Map<string, Group<R>>()
  for (const [order, list] of byOrder) {
    if (list.some((r) => r.scope === "goods") && list.some((r) => r.scope === "software")) {
      groups.set(`split:${order}`, { kind: "split", pairKey: order, members: list })
    }
  }
  return groups
}

/** A credit note only groups with its original invoice when that invoice is
 *  actually present in the current row set -- filtered out, or not on this
 *  page, and it stays exactly where it is, unpaired. Keyed on the id, never
 *  the human number and never `shopify_order_number`: credit notes exist for
 *  non-Shopify invoices too. */
function buildCreditGroups<R extends PairableRow>(rows: R[]): Map<string, Group<R>> {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const groups = new Map<string, Group<R>>()
  for (const r of rows) {
    if (r.type !== "credit_note") continue
    const origId = r.original_document_id?.trim()
    if (!origId) continue
    const invoice = byId.get(origId)
    if (!invoice) continue
    const gk = `credit:${origId}`
    let g = groups.get(gk)
    if (!g) {
      g = { kind: "credit", pairKey: origId, members: [invoice] }
      groups.set(gk, g)
    }
    g.members.push(r)
  }
  return groups
}

function compareCreditNotes<R extends PairableRow>(a: R, b: R): number {
  const ad = a.issued_at ?? ""
  const bd = b.issued_at ?? ""
  if (ad !== bd) return ad < bd ? -1 : 1
  const an = a.number ?? ""
  const bn = b.number ?? ""
  if (an !== bn) return an < bn ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Order within a group. Split: goods first (it is the document that ships,
 *  gets quoted at customs, and that an operator is usually looking for).
 *  Credit: the original invoice first, then its credit notes oldest first,
 *  with a deterministic tie-break so the order never flickers. */
function orderGroupMembers<R extends PairableRow>(g: Group<R>): R[] {
  if (g.kind === "split") {
    const goods = g.members.filter((m) => m.scope === "goods")
    const software = g.members.filter((m) => m.scope === "software")
    return [...goods, ...software]
  }
  const invoice = g.members.find((m) => m.type !== "credit_note")
  const notes = g.members
    .filter((m) => m.type === "credit_note")
    .slice()
    .sort(compareCreditNotes)
  return invoice ? [invoice, ...notes] : notes
}

/**
 * Reorder so each group (split pair or credit group) is adjacent, WITHOUT
 * otherwise disturbing the list.
 *
 * The group takes the position of whichever member came first in the
 * incoming order, so whatever the operator sorted by still governs where the
 * group appears -- it just stops the members being separated. A row whose
 * partner(s) are absent from the current view is left exactly where it was
 * and marked unpaired: showing a link to a row that is not on screen would
 * be worse than showing none.
 *
 * When a row is eligible for both link kinds (rare), the split pairing wins:
 * it is the paper-safety-critical one.
 */
export function pairSplitDocuments<R extends PairableRow>(rows: R[]): Array<PairedRow<R>> {
  const groups = new Map<string, Group<R>>([...buildSplitGroups(rows), ...buildCreditGroups(rows)])

  const keyOfRow = new Map<string, string>()
  for (const [gk, g] of groups) {
    for (const m of g.members) {
      if (!keyOfRow.has(m.id)) keyOfRow.set(m.id, gk)
    }
  }

  const out: Array<PairedRow<R>> = []
  const emitted = new Set<string>()
  for (const r of rows) {
    const gk = keyOfRow.get(r.id)
    if (!gk) {
      out.push({ row: r, pairKey: null, position: null, kind: null })
      continue
    }
    const g = groups.get(gk)!
    // A row can appear in more than one candidate group's member list (a row
    // already claimed by another group's keyOfRow entry, e.g. the split pair
    // wins over a credit group per the doc comment above). Only the members
    // this group actually WON stay in it -- otherwise a row claimed elsewhere
    // would still get emitted again here.
    const claimed = g.members.filter((m) => keyOfRow.get(m.id) === gk)
    if (claimed.length < 2) {
      // Not a pair once the claimed members are stripped down -- fall back to
      // an ordinary unpaired row, emitted exactly once, in its original slot.
      out.push({ row: r, pairKey: null, position: null, kind: null })
      continue
    }
    if (emitted.has(gk)) continue
    emitted.add(gk)
    const ordered = orderGroupMembers({ ...g, members: claimed })
    ordered.forEach((m, i) => {
      out.push({
        row: m,
        pairKey: g.pairKey,
        position: i === 0 ? "first" : i === ordered.length - 1 ? "last" : "middle",
        kind: g.kind,
      })
    })
  }
  return out
}

/** The document ids of a group, for a download-all action. */
export function pairMemberIds<R extends PairableRow>(
  paired: Array<PairedRow<R>>,
  pairKey: string,
): string[] {
  return paired.filter((p) => p.pairKey === pairKey).map((p) => p.row.id)
}

/**
 * The human-readable text for the credit link, or null when the row is not
 * part of a credit group (unpaired, or a split pair). Short enough for a
 * table cell: "Credits INV-2026-0042" on the credit note, "Credited by
 * CN-2026-0007" / "Credited by 2 credit notes" on the invoice.
 */
export function pairLabelOf<R extends PairableRow>(
  paired: Array<PairedRow<R>>,
  rowId: string,
): string | null {
  const hit = paired.find((p) => p.row.id === rowId)
  if (!hit) return null
  const row = hit.row
  // A credit note always STATES which invoice it credits, from its own `original_document_number`
  // -- even when it is not sitting in a co-resident credit group (the split-order case: the split
  // pair wins the invoice row, so a credit note against one half never groups, and on ANY order
  // the credited invoice can simply be filtered out or off-page). The adjacency bracket still
  // requires the two rows to be co-resident; the text does not -- a link to an off-screen row
  // would be worse than none, but the text is never a link, only a statement of fact.
  if (row.type === "credit_note") {
    const num = row.original_document_number?.trim()
    return num ? tr("Credits {{number}}", { number: num }) : null
  }
  if (hit.kind !== "credit" || !hit.pairKey) return null
  const notes = paired.filter((p) => p.pairKey === hit.pairKey && p.row.type === "credit_note")
  if (notes.length === 0) return null
  if (notes.length === 1) {
    const num = notes[0]?.row.number?.trim()
    return num ? tr("Credited by {{number}}", { number: num }) : tr("Credited by 1 credit note")
  }
  return tr("Credited by {{count}} credit notes", { count: notes.length })
}

/**
 * The "Credited by ..." indicator for an invoice row, derived purely from the row's OWN
 * `credited_by_numbers` (server-derived from its lifecycle_log, see reads.ts) -- independent of
 * whether the credit note itself is present in the current view. This is the FALLBACK for when
 * `pairLabelOf` finds no co-resident credit group: a credit note that is off-screen or filtered
 * out still leaves the invoice reading as credited, even though the adjacency bracket and the
 * credit note's own "Credits INV-..." text correctly stay conditional on both rows being on
 * screen (a link to an off-screen row is worse than none -- that rule is unchanged). Null for a
 * credit note row, or an invoice with no credit notes recorded.
 */
export function creditedIndicatorOf<R extends PairableRow>(row: R): string | null {
  if (row.type === "credit_note") return null
  const numbers = (row.credited_by_numbers ?? []).filter((n): n is string => Boolean(n && n.trim()))
  if (numbers.length === 0) return null
  if (numbers.length === 1) return tr("Credited by {{number}}", { number: numbers[0] ?? "" })
  return tr("Credited by {{count}} credit notes", { count: numbers.length })
}
