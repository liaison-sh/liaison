// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Demo leads through the Liaison team outbox. This exists for the Liaison
// team's own demo server: it runs only when LIAISON_TEAM_FORWARD_DEMO_LEADS is
// on, demo mode is on, this server is registered with the Liaison team, and the
// lead has not opted out. A load-harness lead (an address on `.invalid`) is
// never sent. Every function here swallows and logs its failures: a lead that
// cannot be queued must never fail a signup, a verification or an opt-out
// (docs/self-hosting/liaison-team.md).
//
// Each queuing transaction takes `lockLiaisonTeam` first, the lock the switches
// take, and reads the switch and the identity under it: a switch-off that
// cancels the outbox can never be followed by a lead row queued on the strength
// of a read made before it.

import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { demoLeads } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { syntheticLead } from "~/lib/load-harness"
import { appsLogger as log } from "~/lib/logger"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { lockLiaisonTeam, readIdentity } from "./identity"
import { enqueue } from "./outbox"
import { leadData, leadUpdateData } from "./payloads"
import { readSharing } from "./settings"

const K = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)

type LeadChange = Parameters<typeof leadUpdateData>[1]

const enabled = () => env.LIAISON_TEAM_FORWARD_DEMO_LEADS && isDemoModeEnabled()

/**
 * Take the switches' lock, then check registration is on and the identity is
 * registered. Called first in each queuing transaction.
 */
async function forwardingOn(tx: PrivilegedDb): Promise<boolean> {
  await lockLiaisonTeam(tx)
  if (!(await readSharing(tx)).register) return false
  return (await readIdentity(tx))?.state === "registered"
}

/** The lead, or null when it is gone or is a load-harness lead. */
async function realLead(tx: PrivilegedDb, leadId: string) {
  const [row] = await tx
    .select({ lead: demoLeads, synthetic: drizzleSql<boolean>`${syntheticLead}` })
    .from(demoLeads)
    .where(eq(demoLeads.id, leadId))
  return row && !row.synthetic ? row.lead : null
}

/** Queue the lead of a new signup. Never throws. */
export async function forwardNewDemoLead(leadId: string): Promise<void> {
  if (!enabled()) return
  try {
    await withSystemDb("liaison-team:lead-forward", async (tx) => {
      if (!(await forwardingOn(tx))) return
      const lead = await realLead(tx, leadId)
      if (!lead || lead.optedOutAt) return
      await enqueue(tx, "lead", leadData(lead))
    })
  } catch (err) {
    log.error({ err, leadId }, "failed to queue a demo lead for the Liaison team")
  }
}

/**
 * Queue a change to a lead already sent (or about to be). It waits for the
 * lead message when that is still in the outbox. An opted-out lead sends
 * nothing but its own opt-out, and an opt-out that comes while the lead itself
 * waits unsent (never attempted, so the Liaison team cannot have it) cancels it
 * instead: neither is sent. Never throws.
 */
export async function forwardDemoLeadUpdate(leadId: string, change: LeadChange): Promise<void> {
  if (!enabled()) return
  try {
    await withSystemDb("liaison-team:lead-forward", async (tx) => {
      if (!(await forwardingOn(tx))) return
      const lead = await realLead(tx, leadId)
      if (!lead || (lead.optedOutAt && !change.optedOut)) return
      let cancelled = 0
      if (change.optedOut) {
        cancelled = extractRows(
          await tx.execute(drizzleSql`
            UPDATE ${K()}.control_plane_outbox
               SET status = 'cancelled', lease_until = NULL, last_error = 'opted_out',
                   updated_at = now()
             WHERE type = 'lead' AND data ->> 'leadId' = ${leadId} AND status = 'pending'
               AND attempts = 0
            RETURNING id`),
        ).length
      }
      const [pending] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id FROM ${K()}.control_plane_outbox
           WHERE type = 'lead' AND data ->> 'leadId' = ${leadId}
             AND status IN ('pending', 'sending', 'delivered')
           ORDER BY created_at DESC LIMIT 1`),
      )
      // Everything cancelled and nothing went out: the team never had this lead.
      if (cancelled > 0 && !pending) return
      await enqueue(tx, "lead-update", leadUpdateData(leadId, change), {
        ...(pending ? { dependsOn: pending.id } : {}),
      })
    })
  } catch (err) {
    log.error({ err, leadId }, "failed to queue a demo lead update for the Liaison team")
  }
}

/**
 * Queue the full lead again the moment its visitor is on the news list (opted in
 * AND verified). The team's copy may have dropped the name and address already,
 * because an update can arrive after its own deletion date; a copy that still
 * holds them acknowledges and changes nothing. Never throws.
 */
export async function forwardOptedInLead(leadId: string): Promise<void> {
  if (!enabled()) return
  try {
    await withSystemDb("liaison-team:lead-forward", async (tx) => {
      if (!(await forwardingOn(tx))) return
      const lead = await realLead(tx, leadId)
      if (!lead?.verifiedAt || !lead.notifyManagedAt || lead.optedOutAt) return
      if (lead.identityErasedAt) return
      await enqueue(tx, "lead", leadData(lead))
    })
  } catch (err) {
    log.error({ err, leadId }, "failed to queue an opted-in demo lead for the Liaison team")
  }
}

/**
 * The outbox holds the name and address of each lead message: an erased lead
 * leaves none behind. A lead still waiting is cancelled (what it depends on goes
 * with it), a finished one has its data emptied. A row being sent right now
 * finishes on its own and the housekeeping empties it after its 7 days.
 */
export async function dropErasedLeadsFromOutbox(
  tx: Pick<PrivilegedDb, "execute">,
  leadIds: readonly string[],
): Promise<void> {
  if (leadIds.length === 0) return
  const ids = drizzleSql.join(
    leadIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )
  await tx.execute(drizzleSql`
    UPDATE ${K()}.control_plane_outbox
       SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
           last_error = CASE WHEN status = 'pending' THEN 'identity_erased' ELSE last_error END,
           data = '{}'::jsonb, purged_at = now(), updated_at = now()
     WHERE type = 'lead' AND data ->> 'leadId' IN (${ids}) AND status <> 'sending'`)
}

/**
 * Queue the scenarios (distinct tour ids) a demo org's people played, before
 * the org and its progress are deleted. Nothing is sent for an org that played
 * none. Never throws.
 */
export async function forwardPlayedScenarios(leadId: string, orgId: string): Promise<void> {
  if (!enabled()) return
  try {
    const scenarios = await withSystemDb("liaison-team:lead-scenarios", async (tx) =>
      extractRows<{ tour_id: string }>(
        await tx.execute(drizzleSql`
          SELECT DISTINCT tour_id FROM ${K()}.tour_progress
           WHERE org_id = ${orgId}::uuid ORDER BY tour_id LIMIT 100`),
      ).map((r) => r.tour_id),
    )
    if (scenarios.length > 0) await forwardDemoLeadUpdate(leadId, { scenarios })
  } catch (err) {
    log.error({ err, leadId, orgId }, "failed to read the scenarios a demo visitor played")
  }
}
