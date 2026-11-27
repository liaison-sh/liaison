// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The realistic search profile: the volume one busy small team builds up over
// months of mail, tickets and agent work, written into one org so a capacity
// run measures the search index, the database and the vector store at the size
// real workspaces reach, not at the size of a demo world.
//
// `HEAVY_SEARCH_PROFILE` is the per-kind row count of a measured workspace of
// four people after about five months (about 73k search documents, 13k of
// them with a vector). A profile at `fraction` f writes f x every count; the
// named sizes are `heavy` (1) and `typical` (TYPICAL_FRACTION).
//
// Like the bulk volume writer (`volume.ts`) this is raw multi-row SQL on
// purpose: routing 60k creates through the services would measure the
// seeder. Every row's id is the md5 of (org, kind, index), so a re-run adopts
// what an earlier one wrote. Text is generated in Postgres from a fixed
// synthetic vocabulary with a skewed word frequency, so the inverted index
// grows the way natural text makes it grow; nothing is random between runs.
//
// The search documents are the product's own: the registered entities come
// from `reindexOrg`, and the transcript kinds (message, message_window,
// brief_row, episode) from the transcript source a full rebuild uses. The
// windows are therefore derived from the messages exactly as in production
// (one per MESSAGE_WINDOW_EVERY messages). Vectors are FAKE and deterministic
// (no provider is called): a fixed share of the message and window documents
// and every brief row carry one, at the index's declared width, else the
// width the instance is configured to embed at.
//
// The invariant check fails the seed when a kind's rows or its documents in
// the index fall short of what was asked, naming the kind.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { SeedContext } from "~/seed/context"
import { rowsOf } from "~/seed/factories/people/actors"

/** The row kinds the profile writes (message_window is derived from messages). */
export const PROFILE_KINDS = [
  "message",
  "contact",
  "ticket",
  "conversation",
  "approval_request",
  "finding",
  "document",
  "thread",
  "brief_row",
  "episode",
  "task",
] as const
export type ProfileKind = (typeof PROFILE_KINDS)[number]
export type SearchProfileSpec = Record<ProfileKind, number>

/** One measured heavy workspace: four people, about five months of activity. */
export const HEAVY_SEARCH_PROFILE: SearchProfileSpec = {
  message: 31025,
  contact: 12588,
  ticket: 6151,
  conversation: 4956,
  approval_request: 3494,
  finding: 3269,
  document: 1508,
  thread: 1127,
  brief_row: 649,
  episode: 420,
  task: 336,
}

/** A typical workspace is this share of the heavy one. */
export const TYPICAL_FRACTION = 0.25

/** Share of documents of a kind that carry a vector, as measured. */
export const VECTOR_SHARE: Partial<Record<string, number>> = {
  message: 1 / 3,
  message_window: 1 / 3,
  brief_row: 1,
}

/** `heavy`, `typical`, or a fraction in (0, 4]; null when it is none of them. */
export function parseProfileSize(value: string): number | null {
  if (value === "heavy") return 1
  if (value === "typical") return TYPICAL_FRACTION
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n <= 4 ? n : null
}

export function profileSpec(fraction: number): SearchProfileSpec {
  const out = {} as SearchProfileSpec
  for (const k of PROFILE_KINDS) out[k] = Math.round(HEAVY_SEARCH_PROFILE[k] * fraction)
  return out
}

/** The marker every profile row carries, so counts find exactly them. */
const MARK = "load-profile"

const K = () => sql.raw(schemaRef("kernel"))
const T = () => sql.raw(schemaRef("app_tickets"))
const P = () => sql.raw(schemaRef("app_projects"))
const M = () => sql.raw(schemaRef("app_mail"))
const KN = () => sql.raw(schemaRef("app_knowledge"))
const S = () => sql.raw(schemaRef("app_social"))

// 32 syllables -> 32^3 = 32,768 three-syllable words, picked with a skew
// (r^3) so a few words are very common and most are rare, as in mail.
const SYLLABLES =
  "ka,lo,mi,ne,ru,sa,te,vi,do,fa,gu,he,ji,ko,la,me,no,pa,qui,ra,si,to,un,ve,wa,xe,yo,zu,bri,cla,dre,fro"
const VOCAB_CTE = sql.raw(`vocab AS (
  SELECT array_agg(a || b || c ORDER BY a, b, c) AS w
  FROM unnest('{${SYLLABLES}}'::text[]) a, unnest('{${SYLLABLES}}'::text[]) b, unnest('{${SYLLABLES}}'::text[]) c)`)

/** A uniform number in [0, 1) from md5(seed). */
function unit(seed: ReturnType<typeof sql>) {
  return sql`(('x' || lpad(substr(md5(${seed}), 1, 8), 16, '0'))::bit(64)::bigint / 4294967296.0)`
}

/** `words` generated words for the row keyed by `seed` (needs the vocab CTE as `v`). */
function text(seed: ReturnType<typeof sql>, words: ReturnType<typeof sql>) {
  return sql`(SELECT string_agg(v.w[1 + floor(power(${unit(sql`${seed} || ':' || k`)}, 3) * cardinality(v.w))::int], ' ')
              FROM generate_series(1, ${words}) AS k)`
}

/** Rows a kind's writer owns in the org. */
function ownRows(kind: ProfileKind, orgId: string) {
  switch (kind) {
    case "message":
      return sql`SELECT count(*)::int AS n FROM ${K()}.messages WHERE org_id = ${orgId}::uuid AND external_ref LIKE ${`${MARK}:%`}`
    case "thread":
      return sql`SELECT count(*)::int AS n FROM ${K()}.threads WHERE org_id = ${orgId}::uuid AND handle LIKE ${`${MARK}-thread-%`}`
    case "contact":
      return sql`SELECT count(*)::int AS n FROM ${K()}.contacts WHERE org_id = ${orgId}::uuid AND handle LIKE ${`@${MARK}-%`}`
    case "ticket":
      return sql`SELECT count(*)::int AS n FROM ${T()}.tickets WHERE org_id = ${orgId}::uuid AND external_ref LIKE ${`${MARK}:%`}`
    case "conversation":
      return sql`SELECT count(*)::int AS n FROM ${M()}.conversations WHERE org_id = ${orgId}::uuid AND external_thread_id LIKE ${`${MARK}:%`}`
    case "approval_request":
      return sql`SELECT count(*)::int AS n FROM ${K()}.approval_requests WHERE org_id = ${orgId}::uuid AND handle LIKE ${`${MARK}-%`}`
    case "finding":
      return sql`SELECT count(*)::int AS n FROM ${S()}.finding WHERE org_id = ${orgId}::uuid AND external_id LIKE ${`${MARK}:%`}`
    case "document":
      return sql`SELECT count(*)::int AS n FROM ${KN()}.documents WHERE org_id = ${orgId}::uuid AND external_ref LIKE ${`${MARK}:%`}`
    case "brief_row":
      return sql`SELECT count(*)::int AS n FROM ${K()}.thread_briefs WHERE org_id = ${orgId}::uuid AND key LIKE ${`${MARK}:%`}`
    case "episode":
      return sql`SELECT count(*)::int AS n FROM ${K()}.thread_episodes WHERE org_id = ${orgId}::uuid AND title LIKE ${`${MARK} %`}`
    case "task":
      return sql`SELECT count(*)::int AS n FROM ${P()}.tasks WHERE org_id = ${orgId}::uuid AND external_ref LIKE ${`${MARK}:%`}`
  }
}

/** The id of row `g` (an SQL expression) of `kind` in the org. */
function rowId(orgId: string, kind: string, g: ReturnType<typeof sql>) {
  return sql`md5(${orgId} || ${`:${MARK}:${kind}:`} || ${g})::uuid`
}

async function writeProfile(ctx: SeedContext, ownerId: string, spec: SearchProfileSpec) {
  const { orgId } = ctx
  const now = ctx.now.toISOString()
  // Rows spread over the last 150 days, newest first.
  const at = (n: number) =>
    sql`${now}::timestamptz - (g::float8 / ${Math.max(n, 1)}) * interval '150 days'`
  const threads = Math.max(spec.thread, 1)
  const threadOf = (g: ReturnType<typeof sql>) =>
    rowId(orgId, "thread", sql`(1 + (${g} % ${threads}))`)
  const g = sql`g`

  await withPrivilegedDb(orgId, "seed-bulk:search-profile", async (tx) => {
    const run = async (label: string, q: ReturnType<typeof sql>) => {
      const t0 = performance.now()
      await tx.execute(q)
      ctx.log(`profile: ${label} in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    }
    // Threads always exist (messages, approvals, briefs and episodes hang off them).
    await run(
      `${threads} threads`,
      sql`INSERT INTO ${K()}.threads (id, org_id, handle, title, created_by, created_at, updated_at)
          SELECT ${rowId(orgId, "thread", g)}, ${orgId}::uuid, ${`${MARK}-thread-`} || g,
                 'Thread ' || g, ${ownerId}::uuid, ${at(threads)}, ${at(threads)}
          FROM generate_series(1, ${threads}) AS g ON CONFLICT DO NOTHING`,
    )
    await tx.execute(sql`
      INSERT INTO ${K()}.thread_participants (thread_id, user_id, org_id, participant_type, role, created_at)
      SELECT ${rowId(orgId, "thread", g)}, ${ownerId}::uuid, ${orgId}::uuid, 'user', 'owner', ${now}::timestamptz
      FROM generate_series(1, ${threads}) AS g ON CONFLICT DO NOTHING`)
    if (spec.message > 0) {
      // 40 to 239 words a message (about 900 characters on average).
      await run(
        `${spec.message} messages`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${K()}.messages (id, thread_id, org_id, author_id, content, required_scopes, external_ref, created_at)
            SELECT ${rowId(orgId, "message", g)}, ${threadOf(g)}, ${orgId}::uuid, ${ownerId}::uuid,
                   ${text(sql`'m' || g`, sql`40 + (g * 37) % 200`)}, '{}'::text[], ${`${MARK}:`} || g, ${at(spec.message)}
            FROM generate_series(1, ${spec.message}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
    if (spec.contact > 0) {
      await run(
        `${spec.contact} contacts`,
        sql`INSERT INTO ${K()}.contacts (id, org_id, handle, name, email, created_by, created_at, updated_at)
            SELECT ${rowId(orgId, "contact", g)}, ${orgId}::uuid, ${`@${MARK}-`} || g, 'Contact ' || g,
                   ${`${MARK}-`} || g || '@load.invalid', ${ownerId}::uuid, ${at(spec.contact)}, ${at(spec.contact)}
            FROM generate_series(1, ${spec.contact}) AS g ON CONFLICT DO NOTHING`,
      )
    }
    if (spec.ticket > 0) {
      await run(
        `${spec.ticket} tickets`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${T()}.tickets (id, org_id, handle, subject, status, priority, channel, sensitivity,
                                       reply_token, assigned_to, external_ref, sla_target_seconds, sla_deadline,
                                       created_at, updated_at)
            SELECT ${rowId(orgId, "ticket", g)}, ${orgId}::uuid, 'ticket-profile-' || g,
                   ${text(sql`'t' || g`, sql`8`)}, CASE WHEN g % 20 = 0 THEN 'open' ELSE 'closed' END,
                   'normal', 'email', 'internal', md5(${orgId} || ':profile-ticket-token:' || g),
                   ${ownerId}::uuid, ${`${MARK}:`} || g, 86400, ${now}::timestamptz + interval '1 day',
                   ${at(spec.ticket)}, ${at(spec.ticket)}
            FROM generate_series(1, ${spec.ticket}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
    if (spec.conversation > 0) {
      const account = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${M()}.accounts WHERE org_id = ${orgId}::uuid AND disconnected_at IS NULL ORDER BY created_at LIMIT 1`,
        ),
      )[0]
      if (!account) {
        throw new Error("search profile: the org has no mail account to file conversations under")
      }
      await run(
        `${spec.conversation} mail conversations`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${M()}.conversations (id, org_id, account_id, owner_type, external_thread_id, subject,
                                             snippet, from_email, status, labels, is_read, is_starred,
                                             last_message_at, message_count, created_at, updated_at)
            SELECT ${rowId(orgId, "conversation", g)}, ${orgId}::uuid, ${account.id}::uuid, 'org',
                   ${`${MARK}:`} || g, ${text(sql`'cs' || g`, sql`8`)}, ${text(sql`'cn' || g`, sql`30`)},
                   'sender-' || (g % 997) || '@load.invalid', 'archived', '[]'::jsonb, true, false,
                   ${at(spec.conversation)}, 1 + g % 6, ${at(spec.conversation)}, ${at(spec.conversation)}
            FROM generate_series(1, ${spec.conversation}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
    if (spec.approval_request > 0) {
      await run(
        `${spec.approval_request} approval requests`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${K()}.approval_requests (id, org_id, handle, thread_id, originating_thread_id, tool_name,
                                                 tool_params, current_payload, expires_at, requested_by, status,
                                                 decided_by, decided_at, created_at)
            SELECT ${rowId(orgId, "approval", g)}, ${orgId}::uuid, ${`${MARK}-`} || g, ${threadOf(g)}, ${threadOf(g)},
                   'tickets:reply', jsonb_build_object('text', ${text(sql`'a' || g`, sql`60`)}),
                   jsonb_build_object('text', ${text(sql`'a' || g`, sql`60`)}),
                   ${at(spec.approval_request)} + interval '7 days', ${ownerId}::uuid, 'approved',
                   ${ownerId}::uuid, ${at(spec.approval_request)} + interval '1 hour', ${at(spec.approval_request)}
            FROM generate_series(1, ${spec.approval_request}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
    if (spec.finding > 0) {
      await run(
        `${spec.finding} social findings`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${S()}.finding (id, org_id, platform, external_id, relation, author_handle, content_text,
                                       occurred_at, status, created_at, updated_at)
            SELECT ${rowId(orgId, "finding", g)}, ${orgId}::uuid,
                   (ARRAY['facebook','instagram','youtube'])[1 + g % 3], ${`${MARK}:`} || g, 'mention',
                   'author' || (g % 1499), ${text(sql`'f' || g`, sql`20 + g % 60`)},
                   ${at(spec.finding)}, 'dismissed', ${at(spec.finding)}, ${at(spec.finding)}
            FROM generate_series(1, ${spec.finding}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
    if (spec.document > 0) {
      // 100 to 899 words a page.
      await run(
        `${spec.document} knowledge documents`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${KN()}.documents (id, org_id, title, body, document_scope, sensitivity, team,
                                          review_status, revision, created_by, org_access, acl_user_ids,
                                          acl_role_ids, required_scopes, external_ref, created_at, updated_at)
            SELECT ${rowId(orgId, "document", g)}, ${orgId}::uuid, ${text(sql`'dt' || g`, sql`6`)},
                   ${text(sql`'db' || g`, sql`100 + (g * 53) % 800`)}, 'organization', 'internal', '[]'::jsonb,
                   'unverified', 1, ${ownerId}::uuid, 'viewer', '[]'::jsonb, '[]'::jsonb, '{}'::text[],
                   ${`${MARK}:`} || g, ${at(spec.document)}, ${at(spec.document)}
            FROM generate_series(1, ${spec.document}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
    const firstMessage = (g: ReturnType<typeof sql>) =>
      rowId(orgId, "message", sql`(1 + (${g} % ${Math.max(spec.message, 1)}))`)
    if (spec.brief_row > 0) {
      await run(
        `${spec.brief_row} brief rows`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${K()}.thread_briefs (id, org_id, thread_id, kind, key, value, status, message_ids,
                                             first_message_id, created_at, updated_at)
            SELECT ${rowId(orgId, "brief", g)}, ${orgId}::uuid, ${threadOf(g)},
                   (ARRAY['decision','open_loop','identifier','procedure'])[1 + g % 4], ${`${MARK}:`} || g,
                   ${text(sql`'b' || g`, sql`40`)}, 'current', ARRAY[${firstMessage(g)}], ${firstMessage(g)},
                   ${at(spec.brief_row)}, ${at(spec.brief_row)}
            FROM generate_series(1, ${spec.brief_row}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
    if (spec.episode > 0) {
      await run(
        `${spec.episode} episodes`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${K()}.thread_episodes (id, org_id, thread_id, title, body, message_ids, created_at)
            SELECT ${rowId(orgId, "episode", g)}, ${orgId}::uuid, ${threadOf(g)}, ${`${MARK} `} || g,
                   ${text(sql`'e' || g`, sql`120`)}, ARRAY[${firstMessage(g)}], ${at(spec.episode)}
            FROM generate_series(1, ${spec.episode}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
    if (spec.task > 0) {
      const project = rowId(orgId, "project", sql`'1'`)
      const status = rowId(orgId, "project-status", sql`'1'`)
      await tx.execute(sql`
        INSERT INTO ${P()}.projects (id, org_id, name, key, description, owner_id, created_at, updated_at)
        VALUES (${project}, ${orgId}::uuid, 'Operations', 'OPSLOAD', ${MARK}, ${ownerId}::uuid, ${now}::timestamptz, ${now}::timestamptz)
        ON CONFLICT DO NOTHING`)
      await tx.execute(sql`
        INSERT INTO ${P()}.project_statuses (id, org_id, project_id, label, "order", terminal, created_at, updated_at)
        VALUES (${status}, ${orgId}::uuid, ${project}, 'Done', 1, true, ${now}::timestamptz, ${now}::timestamptz)
        ON CONFLICT DO NOTHING`)
      await run(
        `${spec.task} tasks`,
        sql`WITH ${VOCAB_CTE}
            INSERT INTO ${P()}.tasks (id, org_id, project_id, status_id, title, description, priority, position,
                                     blocked, thread_id, created_by, external_ref, number, created_at, updated_at)
            SELECT ${rowId(orgId, "task", g)}, ${orgId}::uuid, ${project}, ${status},
                   ${text(sql`'kt' || g`, sql`8`)}, ${text(sql`'kd' || g`, sql`60`)}, 'normal', g, false,
                   ${threadOf(g)}, ${ownerId}::uuid, ${`${MARK}:`} || g, g, ${at(spec.task)}, ${at(spec.task)}
            FROM generate_series(1, ${spec.task}) AS g, vocab v ON CONFLICT DO NOTHING`,
      )
    }
  })
}

/** A deterministic unit vector of `dims` for document `id` (xorshift32 seeded from the id). */
export function fakeVector(id: string, dims: number): number[] {
  let s = 2166136261
  for (let i = 0; i < id.length; i++) s = Math.imul(s ^ id.charCodeAt(i), 16777619) >>> 0
  if (s === 0) s = 1
  const v = new Array<number>(dims)
  let norm = 0
  for (let i = 0; i < dims; i++) {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    const x = s / 4294967296 - 0.5
    v[i] = x
    norm += x * x
  }
  const k = 1 / Math.sqrt(norm)
  for (let i = 0; i < dims; i++) v[i] = Number(((v[i] as number) * k).toFixed(6))
  return v
}

/** True when document `id` of `entityType` carries a fake vector. */
export function carriesVector(id: string, entityType: string): boolean {
  const share = VECTOR_SHARE[entityType] ?? 0
  if (share >= 1) return true
  if (share <= 0) return false
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0
  return h % 1000 < share * 1000
}

export interface SearchProfileResult {
  spec: SearchProfileSpec
  /** Profile rows of each kind in the org. */
  rows: SearchProfileSpec
  /** The org's documents in the index, by entity type (every source, not only the profile's). */
  index: Record<string, number>
  vectors: number
  vectorDims: number
  seconds: number
}

/** The org's document count per entity type in the live index. */
export async function indexMix(orgId: string): Promise<Record<string, number>> {
  const { effectiveIndexName, getMeili } = await import("~/infra/search/client")
  const res = await getMeili()
    .index(effectiveIndexName())
    .search("", { filter: `org_id = "${orgId}"`, facets: ["entity_type"], limit: 0 })
  return (res.facetDistribution?.entity_type ?? {}) as Record<string, number>
}

/** Every way the result falls short of its spec, one line each (empty: it holds). */
export function profileShortfalls(
  spec: SearchProfileSpec,
  rows: SearchProfileSpec,
  index: Record<string, number>,
): string[] {
  const out: string[] = []
  for (const k of PROFILE_KINDS) {
    if (rows[k] !== spec[k]) out.push(`${k}: ${rows[k]} rows, expected ${spec[k]}`)
    if ((index[k] ?? 0) < spec[k])
      out.push(`${k}: ${index[k] ?? 0} documents in the index, expected at least ${spec[k]}`)
  }
  const windows = Math.floor(spec.message / 8)
  if ((index.message_window ?? 0) < windows) {
    out.push(`message_window: ${index.message_window ?? 0} documents, expected at least ${windows}`)
  }
  return out
}

/** The vector width: the index's declared memory embedder, else the instance's configured width. */
async function vectorWidth(): Promise<number> {
  const { effectiveIndexName, getMeili } = await import("~/infra/search/client")
  const { MEMORY_EMBEDDER_NAME } = await import("~/modules/search/message-indexer")
  const { configuredEmbeddingDimensions } = await import("~/modules/search/embedding-dimensions")
  try {
    const settings = (await getMeili().index(effectiveIndexName()).getSettings()) as {
      embedders?: Record<string, { dimensions?: number }> | null
    }
    const declared = settings.embedders?.[MEMORY_EMBEDDER_NAME]?.dimensions
    if (declared) return declared
  } catch {
    // No index yet: the width this instance embeds at.
  }
  return configuredEmbeddingDimensions()
}

/**
 * Write the profile at `fraction` of the heavy workspace into the org as
 * `ownerId`'s, index it (entities and transcript, fake vectors), and check
 * the invariant. Throws, naming every shortfall, when it does not hold.
 */
export async function seedSearchProfile(
  ctx: SeedContext,
  input: { ownerId: string; fraction: number; vectorDims?: number },
): Promise<SearchProfileResult> {
  const started = performance.now()
  const spec = profileSpec(input.fraction)
  await writeProfile(ctx, input.ownerId, spec)

  const { registerTicketsSearchEnrichment } = await import("~/apps/tickets/search-enrichment")
  const { registerMailSearchEnrichment } = await import("~/apps/mail/search-enrichment")
  const { registerKnowledgeSearchEnrichment } = await import("~/apps/knowledge/search-enrichment")
  const { reindexOrg, rebuildOrgRuntime } = await import("~/modules/search/reindex")
  const { indexSources } = await import("~/modules/search/index-sources")
  const { ensureMemoryEmbedderSettings, MEMORY_EMBEDDER_NAME } = await import(
    "~/modules/search/message-indexer"
  )
  const { finalizeDocuments, sendIndexWrite, waitForIndexTasks } = await import(
    "~/modules/search/index-writer"
  )
  registerTicketsSearchEnrichment()
  registerMailSearchEnrichment()
  registerKnowledgeSearchEnrichment()

  const release = await rebuildOrgRuntime(ctx.orgId)
  const dims = input.vectorDims ?? (await vectorWidth())
  let vectors = 0
  try {
    const t0 = performance.now()
    const entities = await reindexOrg(ctx.orgId)
    ctx.log(
      `profile: ${entities.docs} entity documents indexed in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    )
    await ensureMemoryEmbedderSettings(dims)
    const source = indexSources().find(([name]) => name === "kernel-transcript")?.[1]
    if (!source) throw new Error("search profile: the transcript index source is not registered")
    const t1 = performance.now()
    const queued: number[] = []
    await source(ctx.orgId, async (docs) => {
      for (const doc of docs) {
        if (carriesVector(String(doc.id), String(doc.entity_type))) {
          doc._vectors = { [MEMORY_EMBEDDER_NAME]: fakeVector(String(doc.id), dims) }
          vectors++
        }
      }
      // Small batches: a page of 3072-wide vectors is tens of MB of JSON.
      for (let i = 0; i < docs.length; i += 250) {
        queued.push(...(await sendIndexWrite({ docs: finalizeDocuments(docs.slice(i, i + 250)) })))
        while (queued.length > 4) await waitForIndexTasks([queued.shift() as number])
      }
    })
    await waitForIndexTasks(queued)
    ctx.log(
      `profile: transcript indexed (${vectors} vectors of ${dims}) in ${((performance.now() - t1) / 1000).toFixed(1)}s`,
    )
  } finally {
    await release()
  }

  const rows = {} as SearchProfileSpec
  await withPrivilegedDb(ctx.orgId, "seed-bulk:search-profile:count", async (tx) => {
    for (const k of PROFILE_KINDS) {
      rows[k] = Number(rowsOf<{ n: number }>(await tx.execute(ownRows(k, ctx.orgId)))[0]?.n)
    }
  })
  const index = await indexMix(ctx.orgId)
  const shortfalls = profileShortfalls(spec, rows, index)
  if (shortfalls.length > 0) {
    throw new Error(
      `search profile invariant failed for org ${ctx.orgId}: ${shortfalls.join("; ")}`,
    )
  }
  const seconds = (performance.now() - started) / 1000
  const total = Object.values(index).reduce((a, b) => a + b, 0)
  ctx.log(`profile: ${total} search documents, ${vectors} vectors, in ${seconds.toFixed(1)}s`)
  return { spec, rows, index, vectors, vectorDims: dims, seconds }
}
