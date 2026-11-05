// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The public-safe view of a turn's withheld capabilities.
//
// `computeEffectiveScopeForTurn` and `delegateToAgent` return `withheld` as raw
// scope strings. Those names are private to the requester: in a room with two
// humans, the name of a withheld scope reveals which scope the OTHER human
// lacks. The raw list therefore stays on the requester-only side and is never
// handed to whatever builds a reply shared into the room. What a public reply
// may carry is the output of `describeWithheldCapabilities`: a capability
// category ("finance data"), never a tool name, a scope name, a member name or
// a data value.

import { WITHHELD_CAPABILITY_LABELS } from "~/modules/agent/scopes/withheld-capability-labels"

/** Label used for a withheld scope whose app has no category label. */
export const GENERIC_WITHHELD_LABEL = "a capability"

/**
 * Maps each withheld scope to the category label of its app (the text before
 * the first `:`), deduplicated in first-seen order. An app with no label maps
 * to `GENERIC_WITHHELD_LABEL`, never to its raw prefix or scope string.
 *
 * The map DEFAULTS to the shipped labels. Every call site used to pass `{}`,
 * so every card in the product said "a capability" and named nothing at all;
 * an explicit map still wins, and an explicit empty one still means "label
 * nothing", which is what the privacy cases pin.
 */
export function describeWithheldCapabilities(
  withheldScopes: string[],
  categoryLabels: Record<string, string> = WITHHELD_CAPABILITY_LABELS,
): string[] {
  const labels = new Set<string>()
  for (const scope of withheldScopes) {
    const colon = scope.indexOf(":")
    const app = colon === -1 ? scope : scope.slice(0, colon)
    const label = Object.hasOwn(categoryLabels, app) ? categoryLabels[app] : undefined
    labels.add(label ?? GENERIC_WITHHELD_LABEL)
  }
  return [...labels]
}

/** One withheld capability as the requester's private card reads it. */
export interface WithheldItem {
  /** The category label. The only field the card ever renders. */
  label: string
  /** An admin closed the scope: re-running would refuse, so Share anyway is off. */
  nonDisclosable?: boolean
  /** The turn read scope-tainted context: a re-run is refused the same way. */
  scopeTainted?: boolean
}

/**
 * The withheld block stored on the agent reply's metadata.
 *
 * `requesterId` is the one person this block belongs to. It is stored on a row
 * the whole room can read, so the READ PATH strips the block for everybody
 * else (`projectMessageMetadataForViewer`): the card is per user, and the raw
 * scope names in it are private to the requester (A14).
 */
export interface WithheldMessageMetadata {
  requesterId: string
  /** The requester's message whose turn withheld: what Share anyway reruns. */
  turnId: string | null
  items: WithheldItem[]
}

/**
 * Groups the raw withheld scopes into the card's items, one per DISTINCT
 * label, in first-seen order.
 *
 * No raw scope name appears on an item at ANY point. The persisted block used
 * to strip one that was built here, which left a private scope string alive in
 * memory and in this function's return value for anything else to start
 * reading; there is no scope-request transport that wants it (A14). An item is
 * `nonDisclosable` when ANY scope behind its label is closed, because Share
 * anyway is refused as a whole and the card must not offer what would be
 * refused.
 */
export function buildWithheldItems(
  withheldScopes: string[],
  options: {
    categoryLabels?: Record<string, string>
    nonDisclosableScopes?: string[]
    scopeTainted?: boolean
  } = {},
): WithheldItem[] {
  const labels = options.categoryLabels ?? WITHHELD_CAPABILITY_LABELS
  const closed = new Set(options.nonDisclosableScopes ?? [])
  const byLabel = new Map<string, WithheldItem>()
  for (const scope of withheldScopes) {
    const [label] = describeWithheldCapabilities([scope], labels)
    const existing = byLabel.get(label)
    if (existing) {
      if (closed.has(scope)) existing.nonDisclosable = true
      continue
    }
    const item: WithheldItem = { label }
    if (closed.has(scope)) item.nonDisclosable = true
    // Scope taint is a property of the TURN, not of one withheld scope: the
    // turn read scoped data and a write was refused, so a rerun is refused the
    // same way whatever the requester asks to see. Every item carries it.
    if (options.scopeTainted) item.scopeTainted = true
    byLabel.set(label, item)
  }
  return [...byLabel.values()]
}

/**
 * The `withheld` block to store, or undefined when the turn withheld nothing:
 * a turn that left nothing out writes no metadata at all, so the absence of
 * the key is what "nothing was withheld" means on every read.
 */
export function buildWithheldMessageMetadata(params: {
  requesterId: string
  turnId: string | null
  withheldScopes: string[]
  categoryLabels?: Record<string, string>
  nonDisclosableScopes?: string[]
  scopeTainted?: boolean
}): WithheldMessageMetadata | undefined {
  const items = buildWithheldItems(params.withheldScopes, {
    categoryLabels: params.categoryLabels,
    nonDisclosableScopes: params.nonDisclosableScopes,
    ...(params.scopeTainted ? { scopeTainted: params.scopeTainted } : {}),
  })
  if (items.length === 0) return undefined
  return {
    requesterId: params.requesterId,
    turnId: params.turnId,
    // The labels and the two flags the card needs to decide what it may offer.
    // This block is stored on a message row the whole ROOM can read, so a raw
    // scope name must never have been on it: `buildWithheldItems` no longer
    // produces one at all (A14).
    items,
  }
}

/**
 * Every key a stored withheld item may carry that is a RAW SCOPE NAME. Rows
 * written before A14 put one on each item; `buildWithheldItems` stopped
 * producing them, but the rows are still there and still read.
 */
const RAW_SCOPE_ITEM_KEYS = ["scopeName", "scope", "scopes"]

/** One stored item with every raw scope name taken off it. */
function stripRawScopeNames(item: unknown): unknown {
  if (typeof item !== "object" || item === null) return item
  const record = item as Record<string, unknown>
  if (!RAW_SCOPE_ITEM_KEYS.some((key) => key in record)) return item
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!RAW_SCOPE_ITEM_KEYS.includes(key)) clean[key] = value
  }
  return clean
}

/**
 * The metadata a VIEWER may read. The withheld block is private to the
 * requester who saw the card, so anybody else gets the same metadata with the
 * key removed entirely (not emptied: an empty `items` array would still tell
 * the room that something was withheld).
 *
 * The requester's own copy is not handed back verbatim either. A14 keeps raw
 * scope names off the card ENTIRELY, on the requester's screen included: there
 * is no scope-request transport that wants one, so a name on a legacy row is a
 * private string with no reader and one more place to leak from. New rows
 * never carry one, so this only ever fires on history -- and it copies rather
 * than edits, because the stored row is not this function's to rewrite.
 */
export function projectMessageMetadataForViewer(metadata: unknown, viewerUserId: string): unknown {
  if (typeof metadata !== "object" || metadata === null) return metadata
  const record = metadata as Record<string, unknown>
  const withheld = record.withheld as { requesterId?: unknown; items?: unknown } | undefined
  if (withheld === undefined) return metadata
  if (typeof withheld === "object" && withheld !== null && withheld.requesterId === viewerUserId) {
    if (!Array.isArray(withheld.items)) return metadata
    const items = withheld.items.map(stripRawScopeNames)
    if (items.every((item, i) => item === (withheld.items as unknown[])[i])) return metadata
    return { ...record, withheld: { ...withheld, items } }
  }
  const { withheld: _stripped, ...rest } = record
  return rest
}
