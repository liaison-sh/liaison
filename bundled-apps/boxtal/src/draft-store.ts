// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Draft override store. The create path RE-DERIVES the base draft from the
// invoice snapshot (the source of truth) at create time, then MERGES any
// operator overrides made through `shipment_draft_set_package` /
// `shipment_draft_set_customs` on top. Without persistence those overrides would
// be silently discarded (the tools recompute + return a fresh draft but nothing
// stores the mutation), so an ad-hoc carton or a customs edit never reached the
// create body.
//
// Overrides are persisted in the generic `app_config` key/value store under
// `draft_override:{document_ref}` — a small JSON patch, NOT the whole draft (the
// draft is always recomputed; only the deltas survive). Parcels override the
// resolved parcel set wholesale; customs patches are keyed by line id.

import type { CustomsPatch } from "./customs"
import { isUniqueViolation } from "./db-errors"
import type { Parcel } from "./resolver"

export interface DraftOverride {
  /** Replaces the resolved parcel set wholesale (an ad-hoc carton or pack). */
  parcels?: Parcel[]
  /** Per-line customs field patches, keyed by the invoice line id. */
  customsByLineId?: Record<string, CustomsPatch>
  /** Set when a parcel override demands a re-quote before create. */
  requote?: boolean
}

export interface DraftStoreDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  delete(entity: string, id: string): Promise<void>
}

export interface DraftStoreCtx {
  db: DraftStoreDb
}

function keyFor(documentRef: string): string {
  return `draft_override:${documentRef}`
}

async function rowFor(
  ctx: DraftStoreCtx,
  documentRef: string,
): Promise<{ id: string; value: unknown } | null> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: keyFor(documentRef) },
    limit: 1,
  })) as Array<{ id: string; value: unknown }>
  return rows[0] ?? null
}

/** Load the persisted override patch for a draft (null when none). */
export async function loadDraftOverride(
  ctx: DraftStoreCtx,
  documentRef: string,
): Promise<DraftOverride | null> {
  const row = await rowFor(ctx, documentRef)
  if (!row) return null
  return (row.value as DraftOverride | null) ?? null
}

/** Persist (merge) an override patch for a draft. */
export async function saveDraftOverride(
  ctx: DraftStoreCtx,
  documentRef: string,
  patch: DraftOverride,
): Promise<DraftOverride> {
  const existing = await loadDraftOverride(ctx, documentRef)
  const merged: DraftOverride = {
    ...existing,
    ...patch,
    customsByLineId: {
      ...existing?.customsByLineId,
      ...patch.customsByLineId,
    },
  }
  // Drop an empty customs map so the stored value stays minimal.
  if (merged.customsByLineId && Object.keys(merged.customsByLineId).length === 0) {
    delete merged.customsByLineId
  }
  const row = await rowFor(ctx, documentRef)
  if (row) {
    await ctx.db.update("app_config", row.id, { value: merged })
    return merged
  }
  // No row seen → insert. But `app_config` is UNIQUE on (org_id, key), and the agent often fires the
  // per-line set_customs calls for the SAME draft CONCURRENTLY within one turn (e.g. the instrument
  // line + the accessory line). Two concurrent saves both see no row in their read, both INSERT the
  // same `draft_override:{ref}` key, and the second loses the unique race with a 23505
  // `app_config_org_id_key_key` violation — a REAL non-2xx the agent had to surface (the l502
  // "fake Boxtal API error" was THIS race, not fabrication). The save's contract is an idempotent
  // UPSERT of the override for this draft, so a lost insert race is recoverable, NOT a failure: catch
  // the unique violation, re-read the row the racing writer committed, and re-merge our patch onto it
  // via UPDATE. This is concurrency-safety for a uniquely-keyed config row, never masking — any other
  // error still throws with its real pg detail intact.
  try {
    await ctx.db.insert("app_config", { key: keyFor(documentRef), value: merged })
    return merged
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // The concurrent writer's row now exists; merge OUR patch onto the latest stored value so neither
    // writer's edit is lost (both lines' customs patches survive), then UPDATE.
    const winner = await rowFor(ctx, documentRef)
    if (!winner) throw err // genuinely gone — not a recoverable race; surface the original error
    const latest = (winner.value as DraftOverride | null) ?? null
    const remerged: DraftOverride = {
      ...latest,
      ...patch,
      customsByLineId: {
        ...latest?.customsByLineId,
        ...patch.customsByLineId,
      },
    }
    if (remerged.customsByLineId && Object.keys(remerged.customsByLineId).length === 0) {
      delete remerged.customsByLineId
    }
    await ctx.db.update("app_config", winner.id, { value: remerged })
    return remerged
  }
}

/** Clear a draft's overrides (after a successful create, or on explicit reset). */
export async function clearDraftOverride(
  ctx: DraftStoreCtx,
  documentRef: string,
): Promise<void> {
  const row = await rowFor(ctx, documentRef)
  if (row) await ctx.db.delete("app_config", row.id)
}
