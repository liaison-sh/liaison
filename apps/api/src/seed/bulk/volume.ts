// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bulk volume writer: thousands of threads, contacts, tickets and projects
// in one org, for list, search and paging scale. The one place under seed/
// where raw multi-row SQL is the point: routing 10k creates through the
// services would take minutes and measure the seeder, not the product.
//
// Every row is a pure function of (org, kind, index): its id is the md5 of
// those, so a re-run adopts what an earlier run wrote (ON CONFLICT DO NOTHING)
// and two orgs never collide. Every timestamp is an offset from the tier's
// one `now`. The rows belong to one person (`owner`): creator, participant,
// project owner, ticket assignee. They are the person the load scripts sign in
// as, and the person the invariant check reads the volume back as.
//
// The invariant check is what makes the volume trustworthy, not just present:
//   1. counts: every kind holds exactly its requested number of rows;
//   2. read-back: the owner, inside a real RLS transaction with exactly their
//      role scopes, sees every one of them (a bulk row a member cannot read is
//      a row no list or search measurement will ever touch);
//   3. search: the org is re-indexed once at the end, and the index holds at
//      least the rows the writer wrote.
// Any miss fails the seed, naming the kind.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { SeedContext } from "~/seed/context"
import { actorFor, asUser, rowsOf } from "~/seed/factories/people/actors"

/** How many rows of each kind one org gets. The defaults are the A5/A6 profile. */
export interface VolumeSpec {
  threads: number
  contacts: number
  tickets: number
  projects: number
}

export const DEFAULT_VOLUME: VolumeSpec = {
  threads: 1100,
  contacts: 5000,
  tickets: 3000,
  projects: 1000,
}

export type VolumeKind = keyof VolumeSpec
const KINDS: readonly VolumeKind[] = ["threads", "contacts", "tickets", "projects"]

export interface VolumeInvariant {
  /** Rows of each kind in the org, read over the privileged connection. */
  counts: VolumeSpec
  /** Rows of each kind the owner reads back under RLS. */
  readBack: VolumeSpec
  /** Documents the end-of-run reindex wrote for the org (null: not run). */
  searchDocs: number | null
}

export interface VolumeResult {
  invariant: VolumeInvariant
  seconds: number
}

const K = () => sql.raw(schemaRef("kernel"))
const T = () => sql.raw(schemaRef("app_tickets"))
const P = () => sql.raw(schemaRef("app_projects"))

/** The bulk marker every row carries in a searchable field, so a check finds exactly them. */
const MARK = "load-bulk"

/** The rows of one kind this writer owns in `orgId`: the WHERE a count runs under. */
function ownRows(kind: VolumeKind, orgId: string) {
  switch (kind) {
    case "threads":
      return sql`SELECT count(*)::int AS n FROM ${K()}.threads
                 WHERE org_id = ${orgId}::uuid AND handle LIKE ${`${MARK}-thread-%`}`
    case "contacts":
      return sql`SELECT count(*)::int AS n FROM ${K()}.contacts
                 WHERE org_id = ${orgId}::uuid AND handle LIKE ${`@${MARK}-%`}`
    case "tickets":
      return sql`SELECT count(*)::int AS n FROM ${T()}.tickets
                 WHERE org_id = ${orgId}::uuid AND external_ref LIKE ${`${MARK}:%`}`
    case "projects":
      return sql`SELECT count(*)::int AS n FROM ${P()}.projects
                 WHERE org_id = ${orgId}::uuid AND description = ${MARK}`
  }
}

/** Write the volume (idempotent). Raw SQL by design: see the header. */
async function writeVolume(ctx: SeedContext, ownerId: string, spec: VolumeSpec): Promise<void> {
  const { orgId } = ctx
  const now = ctx.now.toISOString()
  // One statement per kind, generate_series on the server: seconds per 10k rows.
  await withPrivilegedDb(orgId, "seed-bulk:volume", async (tx) => {
    if (spec.threads > 0) {
      await tx.execute(sql`
        INSERT INTO ${K()}.threads (id, org_id, handle, title, created_by, created_at, updated_at)
        SELECT md5(${orgId} || ':bulk-thread:' || g)::uuid, ${orgId}::uuid,
               ${`${MARK}-thread-`} || g, 'Load thread ' || g, ${ownerId}::uuid,
               ${now}::timestamptz - g * interval '1 minute',
               ${now}::timestamptz - g * interval '1 minute'
        FROM generate_series(1, ${spec.threads}) AS g
        ON CONFLICT DO NOTHING`)
      await tx.execute(sql`
        INSERT INTO ${K()}.thread_participants (thread_id, user_id, org_id, participant_type, role, created_at)
        SELECT md5(${orgId} || ':bulk-thread:' || g)::uuid, ${ownerId}::uuid, ${orgId}::uuid,
               'user', 'owner', ${now}::timestamptz - g * interval '1 minute'
        FROM generate_series(1, ${spec.threads}) AS g
        ON CONFLICT DO NOTHING`)
    }
    if (spec.contacts > 0) {
      await tx.execute(sql`
        INSERT INTO ${K()}.contacts (id, org_id, handle, name, email, created_by, created_at, updated_at)
        SELECT md5(${orgId} || ':bulk-contact:' || g)::uuid, ${orgId}::uuid,
               ${`@${MARK}-`} || g, 'Load Contact ' || g, ${`${MARK}-`} || g || '@load.invalid',
               ${ownerId}::uuid, ${now}::timestamptz - g * interval '1 minute',
               ${now}::timestamptz - g * interval '1 minute'
        FROM generate_series(1, ${spec.contacts}) AS g
        ON CONFLICT DO NOTHING`)
    }
    if (spec.tickets > 0) {
      await tx.execute(sql`
        INSERT INTO ${T()}.tickets (id, org_id, handle, subject, status, priority, channel,
                                   sensitivity, reply_token, assigned_to, external_ref,
                                   sla_target_seconds, sla_deadline, created_at, updated_at)
        SELECT md5(${orgId} || ':bulk-ticket:' || g)::uuid, ${orgId}::uuid,
               'ticket-load-' || g, 'Load ticket ' || g, 'open', 'normal', 'api', 'internal',
               md5(${orgId} || ':bulk-ticket-token:' || g), ${ownerId}::uuid,
               ${`${MARK}:`} || g, 86400, ${now}::timestamptz + interval '1 day',
               ${now}::timestamptz - g * interval '1 minute',
               ${now}::timestamptz - g * interval '1 minute'
        FROM generate_series(1, ${spec.tickets}) AS g
        ON CONFLICT DO NOTHING`)
    }
    if (spec.projects > 0) {
      // A project's key is `L<n>` (the key CHECK: a capital, then 1 to 9 more).
      await tx.execute(sql`
        INSERT INTO ${P()}.projects (id, org_id, name, key, description, owner_id, created_at, updated_at)
        SELECT md5(${orgId} || ':bulk-project:' || g)::uuid, ${orgId}::uuid,
               'Load project ' || g, 'L' || g, ${MARK}, ${ownerId}::uuid,
               ${now}::timestamptz - g * interval '1 minute',
               ${now}::timestamptz - g * interval '1 minute'
        FROM generate_series(1, ${spec.projects}) AS g
        ON CONFLICT DO NOTHING`)
    }
  })
}

/** Counts of every kind, privileged (`counts`) and as the owner under RLS (`readBack`). */
export async function countVolume(
  ctx: SeedContext,
  ownerId: string,
): Promise<{ counts: VolumeSpec; readBack: VolumeSpec }> {
  const counts = { threads: 0, contacts: 0, tickets: 0, projects: 0 }
  const readBack = { ...counts }
  await withPrivilegedDb(ctx.orgId, "seed-bulk:count", async (tx) => {
    for (const kind of KINDS) {
      counts[kind] = Number(rowsOf<{ n: number }>(await tx.execute(ownRows(kind, ctx.orgId)))[0]?.n)
    }
  })
  const owner = await actorFor(ctx, ownerId)
  await asUser(owner, async (tx) => {
    for (const kind of KINDS) {
      const result = await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
        ownRows(kind, ctx.orgId),
      )
      readBack[kind] = Number(rowsOf<{ n: number }>(result)[0]?.n)
    }
  })
  return { counts, readBack }
}

/** Every way `invariant` falls short of `spec`, one line each (empty: it holds). */
export function volumeShortfalls(spec: VolumeSpec, invariant: VolumeInvariant): string[] {
  const out: string[] = []
  for (const kind of KINDS) {
    if (invariant.counts[kind] !== spec[kind]) {
      out.push(`${kind}: ${invariant.counts[kind]} rows, expected ${spec[kind]}`)
    }
    if (invariant.readBack[kind] !== invariant.counts[kind]) {
      out.push(
        `${kind}: the owner reads back ${invariant.readBack[kind]} of ${invariant.counts[kind]} under RLS`,
      )
    }
  }
  const total = KINDS.reduce((n, k) => n + spec[k], 0)
  if (invariant.searchDocs !== null && invariant.searchDocs < total) {
    out.push(
      `search: the reindex wrote ${invariant.searchDocs} documents, fewer than the ${total} bulk rows`,
    )
  }
  return out
}

/**
 * Write `spec` rows into the org as `ownerId`'s, re-index the org's search
 * documents once (`reindex`, default on), then check the invariant. Throws,
 * naming every shortfall, when it does not hold.
 */
export async function seedVolume(
  ctx: SeedContext,
  input: { ownerId: string; spec?: VolumeSpec; reindex?: boolean },
): Promise<VolumeResult> {
  const spec = input.spec ?? DEFAULT_VOLUME
  const started = performance.now()
  await writeVolume(ctx, input.ownerId, spec)
  let searchDocs: number | null = null
  if (input.reindex !== false) {
    const { registerTicketsSearchEnrichment } = await import("~/apps/tickets/search-enrichment")
    const { registerMailSearchEnrichment } = await import("~/apps/mail/search-enrichment")
    const { reindexOrg } = await import("~/modules/search/reindex")
    registerTicketsSearchEnrichment()
    registerMailSearchEnrichment()
    searchDocs = (await reindexOrg(ctx.orgId)).docs
  }
  const { counts, readBack } = await countVolume(ctx, input.ownerId)
  const invariant: VolumeInvariant = { counts, readBack, searchDocs }
  const shortfalls = volumeShortfalls(spec, invariant)
  if (shortfalls.length > 0) {
    throw new Error(`bulk volume invariant failed for org ${ctx.orgId}: ${shortfalls.join("; ")}`)
  }
  const seconds = (performance.now() - started) / 1000
  ctx.log(
    `bulk: ${KINDS.map((k) => `${counts[k]} ${k}`).join(", ")} in ${seconds.toFixed(1)}s` +
      (searchDocs === null ? "" : `; ${searchDocs} search documents`),
  )
  return { invariant, seconds }
}
