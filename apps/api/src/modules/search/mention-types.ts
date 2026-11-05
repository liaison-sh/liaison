// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Which entity kinds a mention trigger may complete.
 *
 * `@` ADDRESSES a colleague: it completes the org's members, and nothing else
 * the server holds (agents are added client-side from the agent directory,
 * which is not a searchable entity). `#` REFERENCES: a channel, a contact, an
 * approval request or any app record.
 *
 * `@` used to complete contacts, approval handles and channels as well. A
 * contact is a customer or an outside person: tagging one notifies nobody,
 * and on a bare `@` the contact rows came back ahead of the colleagues the
 * writer was reaching for. A contact is an ENTITY, referenced like a ticket or
 * a task, so it moved to `#`, and so did the approval handle and the channel,
 * which `#` already completed: `@` is people, `#` is things.
 *
 * Pure on purpose: no db, no Meili, so the rule is testable on its own.
 */
export type MentionType = "user" | "thread" | "entity" | "addressable" | "reference"

/** Entity types the `@` trigger may complete: members only. */
export const ADDRESSABLE_ENTITY_TYPES = ["user"] as const

/**
 * Entity types the `#` trigger may NOT complete: the people `@` addresses.
 * Kept as its own list rather than derived from
 * {@link ADDRESSABLE_ENTITY_TYPES}: the two triggers have overlapped before
 * (the channel sat on both), and deriving one list from the other took a kind
 * out of whichever trigger was edited last.
 */
export const NON_REFERENCE_ENTITY_TYPES = ["user"] as const

/**
 * Entity types the `#` trigger leads with. The direct-DB top-up walks
 * registrations in registry order and fills its whole quota from the first one
 * that matches, so a registry that reaches tasks before channels returned a
 * page with no channel in it at all.
 */
export const REFERENCE_LEADING_ENTITY_TYPES = ["thread"] as const

/**
 * Entity types the `#` top-up visits LAST. Contacts are registered right
 * after the channel in the kernel's own list, and an org holds far more of
 * them than of anything else: visited in registry order they filled every
 * slot the channels left, which is how a bare `#` came back as a page of
 * contacts once before.
 */
export const REFERENCE_TRAILING_ENTITY_TYPES = ["contact"] as const

/** The Meili filter clause for a mention type, or undefined for "no narrowing". */
export function mentionTypeClause(type: MentionType | undefined): string | undefined {
  if (type === "user") return `entity_type = "user"`
  if (type === "thread") return `entity_type = "thread"`
  if (type === "entity") return `entity_type != "user" AND entity_type != "thread"`
  if (type === "addressable") {
    return `(${ADDRESSABLE_ENTITY_TYPES.map((t) => `entity_type = "${t}"`).join(" OR ")})`
  }
  if (type === "reference") {
    return `(${NON_REFERENCE_ENTITY_TYPES.map((t) => `entity_type != "${t}"`).join(" AND ")})`
  }
  return undefined
}

/** The same rule for the direct-DB top-up, which filters registrations rather
 *  than documents. The two must agree or the fallback re-admits what the
 *  indexed query just excluded. */
export function matchesMentionType(type: MentionType | undefined, entityType: string): boolean {
  if (type === "user") return entityType === "user"
  if (type === "thread") return entityType === "thread"
  if (type === "entity") return entityType !== "user" && entityType !== "thread"
  if (type === "addressable") {
    return (ADDRESSABLE_ENTITY_TYPES as readonly string[]).includes(entityType)
  }
  if (type === "reference") {
    return !(NON_REFERENCE_ENTITY_TYPES as readonly string[]).includes(entityType)
  }
  return true
}

/**
 * The registrations the direct-DB top-up should visit, in the order it should
 * visit them: for `#` the channel registration leads, so a bare `#` cannot
 * spend its whole page on whatever app happens to be registered first, and
 * contacts trail, so they only fill what the records left. Everything else
 * keeps registry order. Stable, and never drops a row.
 */
export function orderRegistrationsForMentionType<T extends { entityType: string }>(
  type: MentionType | undefined,
  regs: readonly T[],
): T[] {
  if (type !== "reference") return [...regs]
  const leading = REFERENCE_LEADING_ENTITY_TYPES as readonly string[]
  const trailing = REFERENCE_TRAILING_ENTITY_TYPES as readonly string[]
  return [
    ...regs.filter((r) => leading.includes(r.entityType)),
    ...regs.filter((r) => !leading.includes(r.entityType) && !trailing.includes(r.entityType)),
    ...regs.filter((r) => trailing.includes(r.entityType)),
  ]
}
