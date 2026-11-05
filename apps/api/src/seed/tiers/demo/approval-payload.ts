// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHAT: The demo seed's approval payloads, resolved against the rows they
 * act on. Pure: `seed-support.ts` imports this, and the test imports it
 * without dragging the API's database layer in.
 *
 * WHY: Home's "Open ticket" on a `tickets:*` approval goes where the API's
 * `openTarget` points, and the API derives that from the payload's `ticketId`
 * (`apps/api/src/modules/approvals/attention.ts`). The seeded reply approval
 * carried a ticket SUBJECT and no id, so the row fell back to the agent's
 * working thread: the first Windows walk pressed "Open ticket" and landed on
 * a triage channel.
 */

export interface ResolvableApproval {
  key: string
  toolName: string
  payload: Record<string, unknown>
  /** The skill a `kernel:update_skill` edits, by name. */
  skillName?: string
  /** The ticket a `tickets:*` call acts on, by ticket spec key. */
  ticketKey?: string
}

/**
 * Every `tickets:*` approval names a ticket the seed creates. Throws with the
 * offending approval, so the seed refuses to write a row "Open ticket" cannot
 * follow. Called at the seed's load, over its own spec tables.
 */
export function assertTicketApprovalsResolve(
  approvals: readonly Pick<ResolvableApproval, "key" | "toolName" | "ticketKey">[],
  tickets: readonly { key: string }[],
): void {
  const known = new Set(tickets.map((t) => t.key))
  for (const a of approvals) {
    if (!a.toolName.startsWith("tickets:")) continue
    // A bulk action (bulkClose, bulkAssign, ...) spans many tickets and names
    // none; Home offers no "Open ticket" for it.
    if (a.toolName.startsWith("tickets:bulk")) continue
    if (!a.ticketKey) throw new Error(`approval ${a.key} (${a.toolName}) names no ticket`)
    if (!known.has(a.ticketKey)) {
      throw new Error(`approval ${a.key} names an unknown ticket ${a.ticketKey}`)
    }
  }
}
