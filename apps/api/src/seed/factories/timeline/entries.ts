// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The timeline factory: the change history an entity's Activity tab reads
// (`kernel.timeline_entries`): created, a field changed from one value to
// another, in the shape `modules/audit/timeline.ts` writes for an event.
//
// Privileged raw insert, by category: history. The timeline is written by the
// event pipeline as each change happens; a ticket that changed hands last week
// has no other writer. Deterministic ids, so a re-run rewrites nothing.
import { withPrivilegedDb } from "~/db/privileged"
import { timelineEntries } from "~/db/schema/kernel/timeline-entries"
import type { SeedContext } from "~/seed/context"

export type TimelineEntrySeed = {
  key: string
  app: string
  entityType: string
  entityId: string
  actorId: string | null
  actorType: "user" | "agent" | "system"
  at: Date
} & (
  | { action: "created" }
  | { action: "field_changed"; field: string; before: string | null; after: string }
)

export async function seedTimelineEntries(
  ctx: SeedContext,
  entries: readonly TimelineEntrySeed[],
): Promise<string[]> {
  if (entries.length === 0) return []
  const rows = entries.map((e) => ({
    id: ctx.id("timeline-entry", e.key),
    orgId: ctx.orgId,
    app: e.app,
    entityType: e.entityType,
    entityId: e.entityId,
    actorId: e.actorId,
    actorType: e.actorType,
    action: e.action,
    summary:
      e.action === "created"
        ? `created ${e.entityType}`
        : `changed ${e.field} from ${e.before} to ${e.after}`,
    actionLabel: null,
    fieldChanges:
      e.action === "created" ? null : { [e.field]: { before: e.before, after: e.after } },
    createdAt: e.at,
    eventId: null,
  }))
  await withPrivilegedDb(ctx.orgId, "seed-timeline-entries", async (tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      await tx
        .insert(timelineEntries)
        .values(rows.slice(i, i + 200))
        .onConflictDoNothing({ target: timelineEntries.id })
    }
  })
  return rows.map((r) => r.id)
}
