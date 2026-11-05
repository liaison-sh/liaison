// SPDX-License-Identifier: FSL-1.1-ALv2
import type { MentionResult, MentionTrigger } from "~/lib/mention-service"

/**
 * The picker used to be one flat list of whatever the search returned, so a
 * query like "@support" put the agent it was reaching for above four project
 * TASKS that merely contain the word, all drawn alike. Rows are grouped by
 * KIND now, the kinds a trigger is about come first, and no kind can flood the
 * list: a secondary kind contributes at most three rows.
 */

/** The entity kind a row stands for, whichever field carries it. */
export function mentionKind(item: MentionResult): string {
  if (item.type === "entity") return item.entityType ?? "entity"
  return item.entityType ?? item.type
}

/** At most this many rows from a kind the trigger is not about. */
export const SECONDARY_KIND_CAP = 3

/** The kinds a trigger leads with, in the order they are shown. */
export function primaryKinds(trigger: MentionTrigger): string[] {
  // `@` addresses somebody: colleagues first, then agents. A contact is not
  // somebody the message reaches (tagging a customer notifies nobody), so it
  // is an entity like any other and `#` references it. `#` leads with the
  // channel, and every other kind follows.
  return trigger === "@" ? ["user", "agent"] : ["thread"]
}

export interface MentionGroup {
  kind: string
  /** i18n key for the group heading. Every group has one: a row with no kind
   *  is the row a writer cannot place. */
  labelKey: string
  items: MentionResult[]
}

const KNOWN_KIND_LABELS: Record<string, string> = {
  agent: "kernel.mentions.kindAgents",
  user: "kernel.mentions.kindPeople",
  contact: "kernel.mentions.kindContacts",
  thread: "kernel.mentions.kindChannels",
  approval_request: "kernel.mentions.kindApprovals",
  task: "kernel.mentions.kindTasks",
  ticket: "kernel.mentions.kindTickets",
}

export function mentionKindLabelKey(kind: string): string {
  return KNOWN_KIND_LABELS[kind] ?? "kernel.mentions.kindOther"
}

/**
 * Group rows by kind, primary kinds of this trigger first (in the order
 * `primaryKinds` declares), then every other kind in the order it first
 * appeared. Rows inside a group keep the server's ranking. A secondary kind is
 * capped at {@link SECONDARY_KIND_CAP} rows.
 */
export function groupMentionResults(
  results: readonly MentionResult[],
  trigger: MentionTrigger,
): MentionGroup[] {
  const primary = primaryKinds(trigger)
  const byKind = new Map<string, MentionResult[]>()
  const order: string[] = []
  for (const item of results) {
    const kind = mentionKind(item)
    let bucket = byKind.get(kind)
    if (!bucket) {
      bucket = []
      byKind.set(kind, bucket)
      order.push(kind)
    }
    bucket.push(item)
  }

  const sorted = [
    ...primary.filter((kind) => byKind.has(kind)),
    ...order.filter((kind) => !primary.includes(kind)),
  ]

  return sorted.map((kind) => {
    const items = byKind.get(kind) ?? []
    return {
      kind,
      labelKey: mentionKindLabelKey(kind),
      items: primary.includes(kind) ? items : items.slice(0, SECONDARY_KIND_CAP),
    }
  })
}

/** The grouped rows as one selectable sequence, in display order: what the
 *  arrow keys walk and what Enter picks from. */
export function flattenMentionGroups(groups: readonly MentionGroup[]): MentionResult[] {
  return groups.flatMap((g) => g.items)
}
