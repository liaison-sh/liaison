// SPDX-License-Identifier: FSL-1.1-ALv2

import type { ThreadAnchor } from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { UUID_RE } from "~/lib/uuid"

const K = sql.raw(schemaRef("kernel"))

import {
  type DurableEventContext,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import {
  type AttentionTranslation as ManifestTranslation,
  manifestAttentionRegistry,
} from "~/modules/apps/app-registries"
import {
  type AttentionLiveItem,
  attentionTextRedacted,
  dispatchAttentionLive,
  emailEnqueue,
  isAttentionLiveGroup,
} from "~/modules/notifications/dispatch"
import { loadOnCall, orgNotificationFacts } from "~/modules/notifications/on-call"
import { defaultQuietHoursOn } from "~/modules/notifications/quiet-window"
import {
  groupOfItem,
  type RecipientContext as RouterContext,
  type RouterDecision,
  type RouterItem,
  resolveChannels,
} from "~/modules/notifications/router"
import { isSeededWrite } from "~/modules/notifications/seeded"
import { readNotificationChannels } from "~/modules/notifications/settings"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { defaultLoadScopeHolders } from "~/modules/permissions/scope-holders"
import {
  resolveThreadAnchorForReaders,
  type ThreadAnchorRef,
  threadAnchorRef,
} from "~/modules/threads/thread-anchor"
import { isMessageVisible } from "~/services/security/visibility"
import { kernelTranslations, type Translation } from "./kernel-translations"
import { evaluatePredicate } from "./predicates"
import { extractMentionUserIds, type RecipientContext, resolveRecipients } from "./recipients"
import { evaluateSubscriptionDecision, loadRulesForUsersBatch } from "./subscriptions"

const log = rootLogger.child({ module: "attention-translator" })

export interface UserPrefsSnapshot {
  digestCadence: "off" | "immediate" | "hourly" | "daily"
  workHoursStart: string
  workHoursEnd: string
  workDays: number[]
  timezone: string
  /** The stored `notification_channels` (grid + explicit work hours); absent = defaults. */
  notificationChannels?: unknown
  /** `users.timezone` (the profile's); null until set. */
  profileTimezone?: string | null
}

/** A row's insert outcome: its id, and whether it is new (not an upsert of an unread row). */
export interface InsertedAttentionRow {
  id: string
  userId: string
  app: string
  entityType: string
  entityId: string
  kind: string
  inserted: boolean
}

export interface AttentionRowInsert {
  orgId: string
  userId: string
  app: string
  entityType: string
  entityId: string
  kind: string
  urgency: number
  summary: string
  actorId: string | null
  actorType: string
  metadata: Record<string, unknown> | null
  occurredAt: Date
  isUrgent: boolean
  digestState: "pending" | "suppressed"
  digestEligibleAt: Date
}

export interface TranslatorDeps {
  loadPreferences: (userId: string, orgId: string) => Promise<UserPrefsSnapshot>
  /**
   * The words of the entity a message's thread belongs to (a task's comments),
   * per recipient under that recipient's own visibility, copied onto their rows
   * as `metadata.threadAnchor` so the inbox names the entity and opens on it.
   * Null for a recipient who may not see it: their row names nothing of it.
   * Default: `resolveThreadAnchorForReaders` (threads/thread-anchor.ts).
   */
  resolveThreadAnchors: (
    orgId: string,
    ref: ThreadAnchorRef,
    userIds: readonly string[],
  ) => Promise<Map<string, ThreadAnchor | null>>
  /** Returns the row's id and whether it is new; void counts as new (test doubles). */
  // biome-ignore lint/suspicious/noConfusingVoidType: an injected double that returns nothing counts as a new row
  insertAttentionRow: (row: AttentionRowInsert) => Promise<void | InsertedAttentionRow>
  /**
   * D2 batching: when the caller does NOT override `insertAttentionRow`, the
   * production path batches ALL rows for the event into ONE privileged
   * transaction (see `defaultInsertAttentionRowsBatch`) instead of one
   * transaction per recipient. Injected here so tests can assert the batched
   * shape without a real DB; when omitted, the production default runs.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: an injected double that returns nothing counts as a new row
  insertAttentionRowsBatch?: (rows: AttentionRowInsert[]) => Promise<void | InsertedAttentionRow[]>
  /**
   * D2 batching: batch-load preferences for every unique candidate userId in
   * ONE query, keyed by userId. When the caller overrides `loadPreferences`
   * (the common test-double shape), the translator falls back to calling it
   * once per unique user (unchanged behavior) rather than requiring tests to
   * also implement a batch loader.
   */
  loadPreferencesBatch?: (
    userIds: string[],
    orgId: string,
  ) => Promise<Map<string, UserPrefsSnapshot>>
  /** `resolveWhen` hit: mark matching unread rows read. Injectable for tests. */
  resolveAttentionRows?: (event: AppEvent, kind: string) => Promise<void>
  recipientContext?: Partial<RecipientContext>
  /**
   * Phase 16 Task A2 — per-translation, per-event subscription narrowing.
   * Receives the event's `(source, kind, axes)` plus the already-resolved
   * candidate id set, and returns the predicate the translator applies to
   * each candidate. `candidateUserIds` lets the D2 production default
   * (`makeDefaultSubscriptionFilter`) batch-load every candidate's rules in
   * ONE privileged query instead of one query per candidate — see
   * `defaultLoadSubscriptionRulesBatch`. When omitted, the translator uses
   * that default. Test deps override this to inject a synchronous matrix and
   * may ignore `candidateUserIds` entirely (back-compat).
   */
  buildSubscriptionFilter?: (args: {
    source: string
    kind: string
    axes: Record<string, string | undefined>
    candidateUserIds: string[]
  }) => Promise<(userId: string) => Promise<boolean>>
  /**
   * Who of the candidates muted, and who archived, the event's thread
   * (`kernel.user_thread_state`), for the router (rule 7: a muted thread is
   * quiet on every channel, mentions included; an archived one quiets its
   * channel posts only). ONE query per event, not per recipient. When omitted,
   * the production default (`defaultLoadThreadMuteStates`) runs; the per-row
   * test-double path defaults to none.
   */
  loadThreadMuteStates?: (
    threadId: string,
    userIds: string[],
    orgId: string,
  ) => Promise<ThreadMuteStates>
  /**
   * `Translation.requireMessageVisible` support: each candidate's own grants,
   * keyed by userId. Called only when the message carries requiredScopes. When
   * omitted, the production default (`defaultLoadUserGrants`) runs.
   */
  loadUserGrants?: (userIds: string[], orgId: string) => Promise<Map<string, string[]>>
  /**
   * Which candidates have a registered push device (the router's `no_device`).
   * Production default: one query, run only when a live (non-chat) group row
   * is being inserted. The per-row test-double path defaults to none.
   */
  loadPushDeviceUsers?: (userIds: string[], orgId: string) => Promise<Set<string>>
  /** Push + desktop for a new non-chat attention row. Default `dispatchAttentionLive`. */
  dispatchLive?: (decision: RouterDecision, item: AttentionLiveItem) => Promise<void>
  /**
   * The org's time zone (quiet-hours fallback) and its on-call people
   * (incidents interrupt only them), read once per event. Production default:
   * one privileged read; the per-row test-double path defaults to none.
   */
  loadOrgNotificationContext?: (orgId: string) => Promise<OrgNotificationContext | null>
}

export interface OrgNotificationContext {
  timezone: string | null
  /** The org set its time zone (rule 8: quiet hours never guess UTC). */
  timezoneSet?: boolean
  /** Null: nobody is on call (no list, no admin), so everyone who can read an incident is. */
  onCallUserIds: ReadonlySet<string> | null
}

async function defaultLoadOrgNotificationContext(orgId: string): Promise<OrgNotificationContext> {
  return withPrivilegedDb(orgId, "translator:load-org-notification", async (tx: PrivilegedDb) => {
    const facts = await orgNotificationFacts(tx, orgId, { onCallFor: null })
    const onCall = await loadOnCall(tx, orgId)
    return {
      timezone: facts.timezone,
      timezoneSet: facts.timezoneSet,
      onCallUserIds: onCall.source === "nobody" ? null : new Set(onCall.userIds),
    }
  })
}

/**
 * D2 pure helper: maps a resolved recipient + the translation's static fields
 * + the recipient's preferences into the final row the INSERT needs. Pure
 * (no DB, no I/O) so the fan-out DECISION logic (digest state / eligibility)
 * is unit-testable independent of how prefs/rules were fetched — the
 * equivalence tests assert this produces IDENTICAL rows to the old
 * per-recipient path on the same fixtures.
 */
export function buildAttentionRow(args: {
  event: AppEvent
  userId: string
  targetEntityType: string
  targetEntityId: string
  kind: string
  urgency: number
  summary: string
  isUrgent: boolean
  metadata: Record<string, unknown> | null
  occurredAt: Date
  /** The router's decision for this recipient: the digest enqueue reads its email channel. */
  decision: RouterDecision
}): AttentionRowInsert {
  const { event, userId, targetEntityType, targetEntityId, kind, urgency, summary, isUrgent } = args
  const email = emailEnqueue(args.decision, args.occurredAt)
  // Rule 7: a muted item stays unread in the inbox, marked quiet: the badge
  // and the digest skip it (notifications/badge.ts, digest-jobs.ts).
  const quiet = args.decision.channels.in_app.quiet === true
  const metadata = quiet ? { ...(args.metadata ?? {}), quiet: true } : args.metadata
  return {
    orgId: event.orgId,
    userId,
    app: event.app,
    entityType: targetEntityType,
    entityId: targetEntityId,
    kind,
    urgency,
    summary,
    actorId: toUuidOrNull(event.actorId),
    actorType: event.actorType ?? "system",
    metadata,
    occurredAt: args.occurredAt,
    // A critical incident for someone not on call is not urgent for them: it
    // waits for their digest like any other row (rule 9).
    isUrgent: isUrgent && args.decision.urgent,
    digestState: email.digestState,
    digestEligibleAt: email.digestEligibleAt,
  }
}

/**
 * The router's view of one recipient, built from the translator's batched
 * preferences load. Per-app rules and thread mute are already applied by the
 * translator above (same evaluator, same `user_thread_state` read), so they
 * read as none here; the grid, the cadence and the work hours come from the
 * stored row.
 */
export function routerContextFromPrefs(
  prefs: UserPrefsSnapshot,
  hasPushDevice: boolean,
  extra: {
    orgTimezone?: string | null
    orgTimezoneSet?: boolean
    onCall?: boolean
    threadMuted?: boolean
    threadArchived?: boolean
  } = {},
): RouterContext {
  const stored = readNotificationChannels(prefs.notificationChannels ?? null)
  return {
    grid: stored.grid,
    mutedGroups: stored.mutedGroups,
    orgTimezone: extra.orgTimezone ?? null,
    orgTimezoneSet: extra.orgTimezoneSet === true,
    timezoneSet: stored.timezoneSet,
    profileTimezone: prefs.profileTimezone ?? null,
    defaultQuietHours: defaultQuietHoursOn(),
    ...(extra.onCall !== undefined ? { onCall: extra.onCall } : {}),
    digestCadence: prefs.digestCadence,
    workHours: {
      workHoursStart: prefs.workHoursStart,
      workHoursEnd: prefs.workHoursEnd,
      workDays: prefs.workDays,
      timezone: prefs.timezone,
    },
    workHoursExplicit: stored.workHoursExplicit,
    appRules: [],
    threadMuted: extra.threadMuted === true,
    threadArchived: extra.threadArchived === true,
    hasPushDevice,
  }
}

const DEFAULT_PREFS: UserPrefsSnapshot = {
  digestCadence: "daily",
  workHoursStart: "09:00",
  workHoursEnd: "17:00",
  workDays: [1, 2, 3, 4, 5],
  timezone: "UTC",
}

/**
 * High-signal attention kinds that must always reach their recipients,
 * regardless of the user's subscription narrowing rules. A user cannot
 * accidentally mute a direct mention or a system alert via a broad
 * source/kind rule — they must opt out at the individual-item level.
 */
// A routine run waiting for its owner's mailbox is a decision only the owner
// can make (routine-mailbox-wait.ts): a broad rule must not silence it either.
const HIGH_SIGNAL_KINDS = new Set<string>(["mention", "system_alert", "routine_mailbox_wait"])

function normalizeTime(value: string | null | undefined): string {
  if (!value) return "09:00"
  return value.slice(0, 5)
}

// `attention_events.actor_id` is a nullable `uuid` FK column, but `AppEvent.actorId`
// also carries non-UUID sentinels for non-user actors — most commonly the literal
// string `"system"` (webhook/system-originated events set `actorId: "system"` in the
// sandbox RPC bridge; see `modules/apps/sandbox/rpc-bridge.ts`). Passing that straight
// through made the INSERT throw `invalid input syntax for type uuid: "system"` on
// EVERY webhook-sourced event, and because attention-row insert failures are
// deliberately propagated (I-EVT-2, so a durable-consumer failure retries via the
// outbox rather than silently dropping the notification), that exception blocked
// `_publishEventInternal` for the WHOLE event — not just the notification, the event
// itself never reached its live subscribers (e.g. the Shopify order:created →
// invoicing auto-issue cross-app subscription) and the outbox retried it until
// dead-lettering. Normalize any non-UUID actor id to `null` here so a legitimate
// system/webhook actor degrades to "no actor" on the attention row instead of
// poisoning delivery of the underlying event to every other subscriber.
function toUuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null
}

export interface ThreadMuteStates {
  muted: ReadonlySet<string>
  archived: ReadonlySet<string>
}

const NO_MUTE_STATES: ThreadMuteStates = { muted: new Set(), archived: new Set() }

/**
 * Production default for `TranslatorDeps.loadThreadMuteStates`. ONE query
 * against `kernel.user_thread_state` for every candidate userId at once,
 * mirroring `buildSubscriptionFilter`'s default construction — never one
 * query per recipient.
 */
async function defaultLoadThreadMuteStates(
  threadId: string,
  userIds: string[],
  orgId: string,
): Promise<ThreadMuteStates> {
  const uniqueIds = [...new Set(userIds)]
  if (uniqueIds.length === 0) return NO_MUTE_STATES
  try {
    return await withPrivilegedDb(
      orgId,
      "translator:load-muted-thread-users",
      async (tx: PrivilegedDb) => {
        const idList = sql.join(
          uniqueIds.map((id) => sql`${id}`),
          sql`, `,
        )
        const rows = (await tx.execute(
          sql`SELECT user_id, is_muted, is_archived FROM ${K}.user_thread_state
                WHERE thread_id = ${threadId}
                  AND user_id IN (${idList})
                  AND (is_muted OR is_archived)`,
        )) as unknown as Array<{ user_id: string; is_muted: boolean; is_archived: boolean }>
        return {
          muted: new Set(rows.filter((r) => r.is_muted).map((r) => r.user_id)),
          archived: new Set(rows.filter((r) => r.is_archived).map((r) => r.user_id)),
        }
      },
    )
  } catch (err) {
    // Mirrors makeDefaultSubscriptionFilter's resilience: fail OPEN (no
    // exclusions) rather than letting an infra blip either drop the event
    // (I-EVT-2 territory) or silently suppress a legitimate notification.
    log.warn(
      { err, threadId, userIds: uniqueIds },
      "thread mute states load failed — routing as unmuted for this event",
    )
    return NO_MUTE_STATES
  }
}

async function defaultLoadPreferences(userId: string, _orgId: string): Promise<UserPrefsSnapshot> {
  return withPrivilegedDb(_orgId, "translator:load-prefs", async (tx: PrivilegedDb) => {
    const rows = (await tx.execute(
      sql`SELECT p.digest_cadence, p.work_hours_start, p.work_hours_end, p.work_days, p.timezone,
                 p.notification_channels, u.timezone AS profile_timezone
            FROM ${K}.user_preferences p
            LEFT JOIN ${K}.users u ON u.id = p.user_id
           WHERE p.user_id = ${userId} LIMIT 1`,
    )) as unknown as Array<{
      digest_cadence: string
      work_hours_start: string
      work_hours_end: string
      work_days: number[]
      timezone: string
      notification_channels: unknown
      profile_timezone: string | null
    }>
    const row = rows[0]
    if (!row) return DEFAULT_PREFS
    return {
      digestCadence: row.digest_cadence as UserPrefsSnapshot["digestCadence"],
      workHoursStart: normalizeTime(row.work_hours_start),
      workHoursEnd: normalizeTime(row.work_hours_end),
      workDays: Array.isArray(row.work_days) ? [...row.work_days] : [1, 2, 3, 4, 5],
      timezone: row.timezone ?? "UTC",
      notificationChannels: row.notification_channels ?? null,
      profileTimezone: row.profile_timezone ?? null,
    }
  })
}

/**
 * Production default for `buildSubscriptionFilter`. D2 batching: rather than
 * opening one `withPrivilegedDb` transaction PER CANDIDATE (the original
 * Phase 16 cluster 5 shape — `evaluateSubscription` querying
 * `kernel.attention_subscriptions` once per userId), this loads every
 * candidate's rules in ONE privileged transaction
 * (`loadRulesForUsersBatch`), then returns a synchronous-lookup predicate
 * that evaluates each candidate's decision in memory via the pure
 * `evaluateSubscriptionDecision` helper — zero further DB access. Still
 * queries under the privileged DB (so RLS does not hide rules the
 * translator must honour). Mirrors `defaultLoadPreferencesBatch` /
 * `defaultInsertAttentionRowsBatch`.
 */
function makeDefaultSubscriptionFilter(orgId: string) {
  return async (args: {
    source: string
    kind: string
    axes: Record<string, string | undefined>
    candidateUserIds: string[]
  }): Promise<(userId: string) => Promise<boolean>> => {
    const uniqueIds = [...new Set(args.candidateUserIds)]
    let rulesByUser: Map<string, Parameters<typeof evaluateSubscriptionDecision>[0]>
    try {
      rulesByUser = await withPrivilegedDb(
        orgId,
        "translator:subscription-filter-batch",
        (tx: PrivilegedDb) => loadRulesForUsersBatch(tx, uniqueIds, args.source),
      )
    } catch (err) {
      log.warn(
        { err, userIds: uniqueIds, source: args.source },
        "batch subscription-rules load failed — defaulting to default-on (no narrowing) for this batch",
      )
      rulesByUser = new Map()
    }
    return async (userId: string): Promise<boolean> =>
      evaluateSubscriptionDecision(rulesByUser.get(userId) ?? [], {
        kind: args.kind,
        axes: args.axes,
      })
  }
}

const RETURNING_INSERTED = sql`RETURNING id, user_id, app, entity_type, entity_id, kind,
  (xmax = 0) AS inserted`

type ReturnedRow = {
  id: string
  user_id: string
  app: string
  entity_type: string
  entity_id: string
  kind: string
  inserted: boolean
}

function toInserted(r: ReturnedRow): InsertedAttentionRow {
  return {
    id: r.id,
    userId: r.user_id,
    app: r.app,
    entityType: r.entity_type,
    entityId: r.entity_id,
    kind: r.kind,
    inserted: r.inserted === true,
  }
}

/**
 * The attention insert path: one idempotent upsert on the unread dedupe key.
 * Exported so kernel producers outside the translator (the mail producer)
 * write their rows through the same statement. Returns the row id and whether
 * the row is new, so the producer can route its live channels.
 */
export async function defaultInsertAttentionRow(
  row: AttentionRowInsert,
): Promise<InsertedAttentionRow> {
  return withPrivilegedDb(row.orgId, "translator:insert-attention", async (tx: PrivilegedDb) => {
    const out = (await tx.execute(
      sql`INSERT INTO ${K}.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary,
         actor_id, actor_type, metadata, occurred_at, is_urgent,
         digest_state, digest_eligible_at, email_only)
        VALUES (${row.orgId}, ${row.userId}, ${row.app}, ${row.entityType},
                ${row.entityId}, ${row.kind}, ${row.urgency}, ${row.summary},
                ${row.actorId}, ${row.actorType},
                ${row.metadata ? JSON.stringify(row.metadata) : null}::jsonb,
                ${row.occurredAt.toISOString()}, ${row.isUrgent},
                ${row.digestState}, ${row.digestEligibleAt.toISOString()}, false)
        ON CONFLICT (user_id, app, entity_type, entity_id, kind)
          WHERE read_at IS NULL AND email_only = false
          DO UPDATE SET
            urgency = GREATEST(EXCLUDED.urgency, ${K}.attention_events.urgency),
            occurred_at = EXCLUDED.occurred_at,
            summary = EXCLUDED.summary,
            metadata = EXCLUDED.metadata,
            digest_eligible_at = LEAST(
              EXCLUDED.digest_eligible_at, ${K}.attention_events.digest_eligible_at
            ),
            digest_state = EXCLUDED.digest_state
        ${RETURNING_INSERTED}`,
    )) as unknown as ReturnedRow[]
    return toInserted(out[0] as ReturnedRow)
  })
}

/**
 * Production default for `loadPushDeviceUsers`: the candidates holding at
 * least one `push_tokens` row in this org, in one query.
 */
export async function defaultLoadPushDeviceUsers(
  userIds: string[],
  orgId: string,
): Promise<Set<string>> {
  const unique = [...new Set(userIds)]
  if (unique.length === 0) return new Set()
  return withPrivilegedDb(orgId, "translator:load-push-devices", async (tx: PrivilegedDb) => {
    const idList = sql.join(
      unique.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = (await tx.execute(
      sql`SELECT DISTINCT user_id FROM ${K}.push_tokens
          WHERE org_id = ${orgId} AND user_id IN (${idList})`,
    )) as unknown as Array<{ user_id: string }>
    return new Set(rows.map((r) => r.user_id))
  })
}

/**
 * D2 batching — production default for `loadPreferencesBatch`: ONE query for
 * every unique candidate userId (`user_id = ANY($ids)`) instead of one
 * `defaultLoadPreferences` transaction per user. Users with no preferences
 * row (never opened Settings → Attention) are absent from the result set;
 * the caller falls back to `DEFAULT_PREFS` for those, matching
 * `defaultLoadPreferences`'s single-user behavior exactly.
 */
export async function defaultLoadPreferencesBatch(
  userIds: string[],
  orgId: string,
): Promise<Map<string, UserPrefsSnapshot>> {
  const out = new Map<string, UserPrefsSnapshot>()
  if (userIds.length === 0) return out
  await withPrivilegedDb(orgId, "translator:load-prefs-batch", async (tx: PrivilegedDb) => {
    // `= ANY(${userIds})` binds the JS array as a single parameter, which
    // postgres.js does not coerce into a Postgres array literal — it fails with
    // "malformed array literal" (confirmed live: this batch load threw on every
    // translation, silently falling back to DEFAULT_PREFS for every user). Expand
    // to an `IN (...)` list where each id is its own bound parameter — the
    // established pattern in this codebase (see defaultMarkRowsSent, files/service).
    const idList = sql.join(
      userIds.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = (await tx.execute(
      sql`SELECT p.user_id, p.digest_cadence, p.work_hours_start, p.work_hours_end, p.work_days,
                 p.timezone, p.notification_channels, u.timezone AS profile_timezone
            FROM ${K}.user_preferences p
            LEFT JOIN ${K}.users u ON u.id = p.user_id
           WHERE p.user_id IN (${idList})`,
    )) as unknown as Array<{
      user_id: string
      digest_cadence: string
      work_hours_start: string
      work_hours_end: string
      work_days: number[]
      timezone: string
      notification_channels: unknown
      profile_timezone: string | null
    }>
    for (const row of rows) {
      out.set(row.user_id, {
        digestCadence: row.digest_cadence as UserPrefsSnapshot["digestCadence"],
        workHoursStart: normalizeTime(row.work_hours_start),
        workHoursEnd: normalizeTime(row.work_hours_end),
        workDays: Array.isArray(row.work_days) ? [...row.work_days] : [1, 2, 3, 4, 5],
        timezone: row.timezone ?? "UTC",
        notificationChannels: row.notification_channels ?? null,
        profileTimezone: row.profile_timezone ?? null,
      })
    }
  })
  return out
}

/**
 * D2 batching — the multi-row `INSERT ... ON CONFLICT DO UPDATE` in
 * `defaultInsertAttentionRowsBatch` targets the SAME conflict key the table's
 * partial unique arbiter uses: `(user_id, app, entity_type, entity_id, kind)`.
 * Postgres rejects a multi-row `ON CONFLICT DO UPDATE` if two rows in the
 * SAME statement share that key ("ON CONFLICT DO UPDATE command cannot
 * affect row a second time") — which two translations matched on the same
 * event CAN produce (e.g. both a `mention` and a `participants` translation
 * targeting the same user+entity+kind). Dedup by the conflict key here,
 * last-writer-wins (later translations run later in `matched`, so a later
 * row is presumed more current), before building the VALUES list — this is
 * the in-memory analog of what the DB's ON CONFLICT DO UPDATE already does
 * across STATEMENTS (upsert), just applied within one statement's own batch.
 */
export function dedupeAttentionRowsForBatchInsert(
  rows: AttentionRowInsert[],
): AttentionRowInsert[] {
  const byKey = new Map<string, AttentionRowInsert>()
  for (const row of rows) {
    const key = `${row.userId}\u0000${row.app}\u0000${row.entityType}\u0000${row.entityId}\u0000${row.kind}`
    byKey.set(key, row) // last-writer-wins: a later duplicate overwrites the earlier one
  }
  return [...byKey.values()]
}

/**
 * D2 batching — production default for `insertAttentionRowsBatch`: ONE
 * privileged transaction per EVENT (not per recipient), with a single
 * multi-row `INSERT ... ON CONFLICT` covering every row the event produced
 * across every matched translation. Empty input is a no-op (never an
 * empty-VALUES SQL error).
 */
async function defaultInsertAttentionRowsBatch(
  rowsIn: AttentionRowInsert[],
): Promise<InsertedAttentionRow[]> {
  if (rowsIn.length === 0) return []
  const rows = dedupeAttentionRowsForBatchInsert(rowsIn)
  const orgId = rows[0]!.orgId
  return withPrivilegedDb(orgId, "translator:insert-attention-batch", async (tx: PrivilegedDb) => {
    const values = sql.join(
      rows.map(
        (row) => sql`(
          ${row.orgId}, ${row.userId}, ${row.app}, ${row.entityType},
          ${row.entityId}, ${row.kind}, ${row.urgency}, ${row.summary},
          ${row.actorId}, ${row.actorType},
          ${row.metadata ? JSON.stringify(row.metadata) : null}::jsonb,
          ${row.occurredAt.toISOString()}, ${row.isUrgent},
          ${row.digestState}, ${row.digestEligibleAt.toISOString()}, false
        )`,
      ),
      sql`, `,
    )
    const out = (await tx.execute(
      sql`INSERT INTO ${K}.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary,
         actor_id, actor_type, metadata, occurred_at, is_urgent,
         digest_state, digest_eligible_at, email_only)
        VALUES ${values}
        ON CONFLICT (user_id, app, entity_type, entity_id, kind)
          WHERE read_at IS NULL AND email_only = false
          DO UPDATE SET
            urgency = GREATEST(EXCLUDED.urgency, ${K}.attention_events.urgency),
            occurred_at = EXCLUDED.occurred_at,
            summary = EXCLUDED.summary,
            metadata = EXCLUDED.metadata,
            digest_eligible_at = LEAST(
              EXCLUDED.digest_eligible_at, ${K}.attention_events.digest_eligible_at
            ),
            digest_state = EXCLUDED.digest_state
        ${RETURNING_INSERTED}`,
    )) as unknown as ReturnedRow[]
    return out.map(toInserted)
  })
}

function readPath(payload: unknown, path: string): unknown {
  const parts = path.split(".")
  let cur: unknown = payload
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g

// Human-facing templates must never interpolate raw minor-unit money fields
// ("2015800 minor EUR" reached the live attention feed this way). Apps carry a
// pre-formatted `*_display` twin (formatMoneyMinor / currencyExponent) for
// every money field, so a `*_minor`/`*_cents` placeholder is always a template
// bug. The manifest oracle (human-templates-no-minor-money.test.ts) blocks
// in-repo manifests at CI time; this tripwire covers third-party manifests at
// render time: drop the raw value (an absent amount beats a 100x-wrong one)
// and log at error level so the watchdog surfaces it.
function isRawMinorMoneyPath(path: string): boolean {
  const leaf = path.split(".").pop() ?? path
  return leaf.endsWith("_minor") || leaf.endsWith("_cents")
}

function renderTemplate(
  template: string,
  ctx: { actor: { name: string; id: string | null }; payload: unknown },
): string {
  return template.replace(TEMPLATE_RE, (_match, expr: string) => {
    const trimmed = expr.trim()
    if (isRawMinorMoneyPath(trimmed)) {
      log.error(
        { placeholder: trimmed, template: template.slice(0, 120) },
        "attention template interpolates a raw minor-unit money field -- use the *_display twin",
      )
      return ""
    }
    let value: unknown
    if (trimmed === "actor.name") value = ctx.actor.name
    else if (trimmed === "actor.id") value = ctx.actor.id
    else if (trimmed.startsWith("payload."))
      value = readPath(ctx.payload, trimmed.slice("payload.".length))
    // Manifest translations address the event directly ({{data.x}},
    // {{metadata.x}}) — resolve those against the payload so they don't
    // silently render as "" (every shipped manifest uses this form).
    else value = readPath(ctx, trimmed) ?? readPath(ctx.payload, trimmed)
    if (value === undefined || value === null) return ""
    return typeof value === "string" ? value : String(value)
  })
}

function eventMatches(translation: Translation, event: AppEvent): boolean {
  const expected = `${event.entity}:${event.action}`
  if (translation.event !== expected) return false
  if (translation.app && event.app !== translation.app) return false
  return true
}

/** Combine kernel built-ins with any manifest translations registered for the org/app. */
function collectMatchingTranslations(event: AppEvent): Translation[] {
  const matches: Translation[] = []
  for (const t of kernelTranslations) {
    if (eventMatches(t, event)) matches.push(t)
  }
  const manifestSet = manifestAttentionRegistry.get([event.orgId, event.app]) as
    | ManifestTranslation[]
    | undefined
  if (Array.isArray(manifestSet)) {
    for (const t of manifestSet) {
      const adapted = adaptManifestTranslation(t, event.app)
      if (adapted && eventMatches(adapted, event)) matches.push(adapted)
    }
  }
  return matches
}

function adaptManifestTranslation(t: ManifestTranslation, app: string): Translation | null {
  let recipients: Translation["recipients"]
  if (t.recipients.kind === "field") {
    recipients = { kind: "field", path: t.recipients.path } as const
  } else if (t.recipients.kind === "participants") {
    recipients = { kind: "participants", path: t.recipients.path } as const
  } else if (t.recipients.kind === "mentions") {
    recipients = { kind: "mentions", path: t.recipients.path } as const
  } else if (t.recipients.kind === "scope_holders") {
    recipients = {
      kind: "scope_holders",
      scope: t.recipients.scope,
      ...(t.recipients.dimensionFilter ? { dimensionFilter: t.recipients.dimensionFilter } : {}),
    } as const
  } else if (t.recipients.kind === "actor") {
    recipients = { kind: "actor" } as const
  } else {
    return null
  }
  return {
    event: t.event,
    app,
    kind: t.kind as Translation["kind"],
    urgency: t.urgency,
    isUrgent: t.isUrgent,
    summary: t.summary,
    when: t.when,
    recipients,
    excludeActor: t.recipients.kind === "participants" ? Boolean(t.recipients.excludeActor) : false,
    resolveWhen: t.resolveWhen,
  }
}

/**
 * Does this event trigger its translation's resolution?
 *
 * `{ always: true }` resolves unconditionally — the translation only matches
 * events that ARE the resolution (order:fulfilled, invoice:paid), so there is
 * nothing further to test. `{ field, equals }` resolves on a payload match, for
 * translations that see BOTH the alerting and the resolving shape of one event
 * (the unfulfilled digest: count > 0 upserts, count === 0 resolves).
 *
 * Exported for the translator tests, which pin both forms.
 */
export function resolveWhenHit(
  rule: NonNullable<Translation["resolveWhen"]>,
  event: AppEvent,
): boolean {
  if ("always" in rule) return rule.always === true
  const data = (event.data ?? {}) as Record<string, unknown>
  // The field must actually be PRESENT. Without this, a rule whose `equals` is
  // undefined (a malformed third-party manifest — the in-repo schema requires a
  // string/number/boolean, but nothing validates a runtime-registered one)
  // matched any payload lacking the field, silently marking rows read that
  // nothing had resolved. An absent field is never a resolution.
  if (!Object.hasOwn(data, rule.field)) return false
  return data[rule.field] === rule.equals
}

/** `resolveWhen` hit: mark every matching UNREAD row read (org-wide — resolution
 *  clears the row for all recipients, not just those the event would notify). */
async function resolveAttentionRows(event: AppEvent, kind: string): Promise<void> {
  await withPrivilegedDb(event.orgId, "translator:resolve-rows", async (tx: PrivilegedDb) => {
    await tx.execute(sql`
      UPDATE ${K}.attention_events
      SET read_at = now()
      WHERE org_id = ${event.orgId}
        AND app = ${event.app}
        AND entity_type = ${event.entity}
        AND entity_id = ${event.entityId}
        AND kind = ${kind}
        AND read_at IS NULL
    `)
  })
}

/**
 * `Translation.requireMessageVisible`: keep only the recipients who can see the
 * message, each judged with their own grants by `isMessageVisible`, the
 * app-level mirror of the messages SELECT policy. An untagged message (`[]`)
 * is visible to every participant, so no grants are loaded for it. A missing
 * requiredScopes array fails the scope branch for everyone (fail closed).
 */
async function filterByMessageVisibility(
  event: AppEvent,
  recipients: string[],
  loadUserGrants: (userIds: string[], orgId: string) => Promise<Map<string, string[]>>,
): Promise<string[]> {
  const orgId = event.orgId
  if (!orgId) return []
  const data = (event.data ?? {}) as Record<string, unknown>
  const requiredScopes = data.requiredScopes
  if (Array.isArray(requiredScopes) && requiredScopes.length === 0) return recipients
  const message = {
    requiredScopes: requiredScopes as string[],
    disclosureList: Array.isArray(data.disclosureList) ? (data.disclosureList as string[]) : null,
  }
  const grants = await loadUserGrants(recipients, orgId)
  return recipients.filter((userId) =>
    isMessageVisible(message, { userId, grants: grants.get(userId) ?? [] }),
  )
}

/** Each user's effective scopes, from the loader the request path uses. */
async function defaultLoadUserGrants(
  userIds: string[],
  orgId: string,
): Promise<Map<string, string[]>> {
  return withPrivilegedDb(orgId, "attention-recipient-grants", async (tx) => {
    const grants = new Map<string, string[]>()
    for (const userId of userIds) {
      grants.set(userId, (await loadEffectivePermissions(tx, userId, orgId)).scopes)
    }
    return grants
  })
}

/** Process a single durable event, writing zero or more attention rows. */
export async function processTranslationEvent(
  event: AppEvent,
  deps: Partial<TranslatorDeps> = {},
): Promise<void> {
  if (event.ephemeral) return
  if (!event.orgId) return
  // A seed's rows are history, not news (notifications/seeded.ts).
  if (isSeededWrite((event.data as { metadata?: unknown } | undefined)?.metadata)) return

  // D2 batching: when the caller injects a per-row `insertAttentionRow` (the
  // existing unit-test double shape), preserve exact per-row-call semantics —
  // tests assert on the SEQUENCE/CONTENT of individual insert calls. Only when
  // running with the PRODUCTION default does the translator batch every row
  // for the event into one privileged transaction (real perf fix; see
  // `defaultInsertAttentionRowsBatch`). Same split for preferences: an
  // injected `loadPreferences` double is called once per unique user
  // (unchanged); the production default batches into one query.
  const usingDefaultInsert = !deps.insertAttentionRow
  const loadPreferences = deps.loadPreferences ?? defaultLoadPreferences
  const loadPreferencesBatch = deps.loadPreferencesBatch ?? defaultLoadPreferencesBatch
  const insertAttentionRow = deps.insertAttentionRow ?? defaultInsertAttentionRow
  const insertAttentionRowsBatch = deps.insertAttentionRowsBatch ?? defaultInsertAttentionRowsBatch
  // Cluster 5 fix: the production narrowing must run, not only when a test
  // injects deps.buildSubscriptionFilter. Fall back to the privileged-DB
  // default so a user who disables a source / filters an axis stops receiving
  // non-matching items.
  const buildSubscriptionFilter =
    deps.buildSubscriptionFilter ?? makeDefaultSubscriptionFilter(event.orgId)

  const matched = collectMatchingTranslations(event)
  if (matched.length === 0) return

  const actorName =
    (event.metadata && typeof event.metadata === "object"
      ? ((event.metadata as Record<string, unknown>).actorName as string | undefined)
      : undefined) ?? "Someone"
  const occurredAt = event.timestamp ? new Date(event.timestamp) : new Date()
  const entityId = event.entityId ?? ""
  // A message in an entity's thread: the entity's words, read per recipient
  // under their own visibility (one batched call per recipient set, cached for
  // the event) and carried on that recipient's rows (`metadata.threadAnchor`).
  const anchorRef =
    event.app === "kernel" && event.entity === "message"
      ? threadAnchorRef(
          (event.data as { threadAnchor?: unknown } | undefined)?.threadAnchor,
          event.orgId,
        )
      : null
  const anchorByUser = new Map<string, ThreadAnchor | null>()
  async function loadAnchors(userIds: readonly string[]): Promise<void> {
    if (!anchorRef) return
    const missing = [...new Set(userIds)].filter((id) => !anchorByUser.has(id))
    if (missing.length === 0) return
    const found = await (deps.resolveThreadAnchors ?? resolveThreadAnchorForReaders)(
      event.orgId,
      anchorRef,
      missing,
    )
    for (const id of missing) anchorByUser.set(id, found.get(id) ?? null)
  }
  /** A row's metadata for one recipient: the anchor only when they may see it. */
  function metadataFor(
    userId: string,
    metadata: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const threadAnchor = anchorByUser.get(userId) ?? null
    return threadAnchor && metadata?.messageId !== undefined
      ? { ...metadata, threadAnchor }
      : metadata
  }
  // Phase 16 Task A2 — derive axes from event.metadata once per event; passed
  // into the subscription evaluator alongside the translation's kind. Keys in
  // metadata that aren't declared as `filters` on any rule are ignored by the
  // evaluator, so passing the full metadata is safe (and avoids coupling the
  // translator to the per-app `filterableAxes` declaration).
  const axes: Record<string, string | undefined> = {}
  if (event.metadata && typeof event.metadata === "object") {
    for (const [k, v] of Object.entries(event.metadata as Record<string, unknown>)) {
      if (typeof v === "string") axes[k] = v
      else if (typeof v === "number" || typeof v === "boolean") axes[k] = String(v)
    }
  }
  const recipientCtx: RecipientContext = {
    orgId: event.orgId,
    // Default to the real, hierarchical scope-holder lookup so `scope_holders`
    // recipients actually deliver (previously this was undefined → silently []).
    // Repairs the Shopify/invoicing manifests too. `perTranslationCtx` below
    // spreads `recipientCtx`, so this default propagates automatically.
    loadScopeHolders: deps.recipientContext?.loadScopeHolders ?? defaultLoadScopeHolders,
  }

  // null = the preferences could not be read: the router degrades (in_app
  // kept, email left pending for the digest to decide, push/desktop off).
  const prefsCache = new Map<string, UserPrefsSnapshot | null>()
  async function prefsFor(userId: string): Promise<UserPrefsSnapshot | null> {
    if (prefsCache.has(userId)) return prefsCache.get(userId) ?? null
    try {
      const p = await loadPreferences(userId, event.orgId)
      prefsCache.set(userId, p)
      return p
    } catch (err) {
      log.warn({ err, userId }, "preferences load failed — routing degraded")
      prefsCache.set(userId, null)
      return null
    }
  }

  const dispatchLive = deps.dispatchLive ?? ((d, i) => dispatchAttentionLive(d, i))
  const eventThreadId = (() => {
    const data = (event.data ?? {}) as Record<string, unknown>
    const id = (data.threadId as string | undefined) ?? (data.thread_id as string | undefined)
    return typeof id === "string" ? id : null
  })()

  // D14 FOR ATTENTION ITEMS. An event written by a tainted turn (notify_user) carries
  // the turn's read scopes as `data.requiredScopes`. Its rows record them (the email
  // digest reads them) and its live dispatch is told, so push, desktop and web push
  // carry no text derived from it; the in-app row keeps its summary. A kernel
  // message's own `requiredScopes` is governed by the message visibility gate (A18)
  // and its push by the message fanout, so it is not re-read here.
  const itemRequiredScopes: string[] | null = (() => {
    if (event.app === "kernel" && event.entity === "message") return null
    const raw = ((event.data ?? {}) as Record<string, unknown>).requiredScopes
    if (!attentionTextRedacted(raw)) return null
    return Array.isArray(raw) && raw.every((s) => typeof s === "string")
      ? [...(raw as string[])]
      : ["__unreadable__"]
  })()

  function routerItemFor(c: {
    kind: string
    isUrgent: boolean
    targetEntityType: string
    targetEntityId: string
  }): RouterItem {
    return {
      kind: c.kind,
      app: event.app,
      entityType: c.targetEntityType,
      entityId: c.targetEntityId,
      threadId: eventThreadId,
      isUrgent: c.isUrgent,
      isMention: c.kind === "mention",
      axes,
    }
  }

  // Etiquette rules 7-9: the org's clock and on-call people (once per event)
  // and who muted the event's thread (cached per recipient).
  const loadOrgCtx =
    deps.loadOrgNotificationContext ??
    (usingDefaultInsert ? defaultLoadOrgNotificationContext : async () => null)
  let orgCtxPromise: Promise<OrgNotificationContext | null> | null = null
  function orgCtx(): Promise<OrgNotificationContext | null> {
    orgCtxPromise ??= loadOrgCtx(event.orgId).catch((err) => {
      log.warn({ err }, "org notification context load failed — no on-call or org clock")
      return null
    })
    return orgCtxPromise
  }
  const loadMutedForRouting =
    deps.loadThreadMuteStates ??
    (usingDefaultInsert ? defaultLoadThreadMuteStates : async () => NO_MUTE_STATES)
  const mutedByUser = new Map<string, { muted: boolean; archived: boolean }>()
  async function loadMutedFor(userIds: readonly string[]): Promise<void> {
    if (!eventThreadId) return
    const missing = [...new Set(userIds)].filter((id) => !mutedByUser.has(id))
    if (missing.length === 0) return
    const states = await loadMutedForRouting(eventThreadId, missing, event.orgId)
    for (const id of missing) {
      mutedByUser.set(id, { muted: states.muted.has(id), archived: states.archived.has(id) })
    }
  }

  async function route(
    userId: string,
    item: RouterItem,
    prefs: UserPrefsSnapshot | null,
    hasPushDevice: boolean,
  ): Promise<RouterDecision> {
    const org = await orgCtx()
    await loadMutedFor([userId])
    const incident = groupOfItem(item) === "monitoring"
    return resolveChannels({ userId, orgId: event.orgId }, item, {
      now: occurredAt,
      loadContext: async () => {
        if (!prefs) throw new Error("preferences unavailable")
        return routerContextFromPrefs(prefs, hasPushDevice, {
          orgTimezone: org?.timezone ?? null,
          ...(incident && org
            ? { onCall: org.onCallUserIds === null || org.onCallUserIds.has(userId) }
            : {}),
          orgTimezoneSet: org?.timezoneSet === true,
          threadMuted: mutedByUser.get(userId)?.muted === true,
          threadArchived: mutedByUser.get(userId)?.archived === true,
        })
      },
    })
  }

  /** Push + desktop for a NEW row of a non-chat group (an upsert of an unread row stays quiet). */
  async function goLive(
    decision: RouterDecision,
    c: { kind: string; targetEntityType: string; targetEntityId: string; summary: string },
    stored: InsertedAttentionRow | undefined | null,
  ): Promise<void> {
    if (!isAttentionLiveGroup(decision.group)) return
    if (stored && !stored.inserted) return
    await dispatchLive(decision, {
      notifyId: stored
        ? `attention:${stored.id}`
        : `attention:${decision.userId}:${event.app}:${c.targetEntityType}:${c.targetEntityId}:${c.kind}`,
      summary: c.summary,
      app: event.app,
      entityType: c.targetEntityType,
      entityId: c.targetEntityId,
      threadId: eventThreadId,
      ...(itemRequiredScopes ? { requiredScopes: itemRequiredScopes } : {}),
    })
  }

  // D2 batching (production path only): accumulate every recipient candidate
  // across every matched translation FIRST (no DB calls), then resolve prefs
  // for the union of unique userIds in ONE query, then insert every row in
  // ONE transaction. Each candidate carries everything `buildAttentionRow`
  // needs except the resolved prefs.
  interface Candidate {
    userId: string
    targetEntityType: string
    targetEntityId: string
    kind: string
    urgency: number
    summary: string
    isUrgent: boolean
    metadata: Record<string, unknown> | null
  }
  const candidates: Candidate[] = []

  for (const t of matched) {
    try {
      if (t.when && !evaluatePredicate(t.when, event)) continue
      // Resolution path: the event REPORTS the tracked condition is gone
      // (e.g. an unfulfilled-orders digest with count 0, or an order:fulfilled
      // that ends its order:created row's reason to exist). Clear the unread
      // row(s) instead of upserting a nonsense "0 items need you" row.
      if (t.resolveWhen && resolveWhenHit(t.resolveWhen, event)) {
        await (deps.resolveAttentionRows ?? resolveAttentionRows)(event, t.kind)
        continue
      }
      // D2 batching: resolve the CANDIDATE set first, with NO subscription
      // filter applied, so the filter builder can see every candidate id up
      // front and batch-load their subscription rules in ONE query instead of
      // evaluating (and therefore querying) one candidate at a time. High-signal
      // kinds (mention, system_alert) bypass subscription narrowing entirely so
      // a broad rule cannot accidentally silence a direct user mention.
      const unfilteredCtx: RecipientContext = {
        ...recipientCtx,
        applySubscriptionFilter: undefined,
      }
      let candidateIds = await resolveRecipients(t.recipients, event, unfilteredCtx)
      if (!HIGH_SIGNAL_KINDS.has(t.kind) && candidateIds.length > 0) {
        // Build the per-translation subscription filter (uses the *translation's*
        // kind, not the event name, since attention rules are keyed by display
        // kind such as `shopify:order.created`), now scoped to the known
        // candidate ids so the production default can batch-load their rules.
        const filter = await buildSubscriptionFilter({
          source: event.app,
          kind: t.kind,
          axes,
          candidateUserIds: candidateIds,
        })
        const allowed: string[] = []
        for (const id of candidateIds) {
          if (await filter(id)) allowed.push(id)
        }
        candidateIds = allowed
      }
      let recipients = candidateIds
      if (
        t.excludeActor &&
        event.actorId &&
        !(t.keepActorWhen && evaluatePredicate(t.keepActorWhen, event))
      ) {
        recipients = recipients.filter((id) => id !== event.actorId)
      }
      if (t.excludeMentioned) {
        const mentioned = new Set(
          extractMentionUserIds((event.data as Record<string, unknown> | undefined)?.mentions),
        )
        if (mentioned.size > 0) {
          recipients = recipients.filter((id) => !mentioned.has(id))
        }
      }
      if (t.excludeFollowers) {
        const followerIds = (event.data as Record<string, unknown> | undefined)?.followerIds
        if (Array.isArray(followerIds) && followerIds.length > 0) {
          const followers = new Set(followerIds.filter((id) => typeof id === "string"))
          recipients = recipients.filter((id) => !followers.has(id))
        }
      }
      if (t.requireMessageVisible && recipients.length > 0) {
        recipients = await filterByMessageVisibility(
          event,
          recipients,
          deps.loadUserGrants ?? defaultLoadUserGrants,
        )
      }
      if (recipients.length === 0) continue

      // Per-event urgency override — gated so it cannot silently change
      // message:create etc. Only `agent_notification` honours a payload urgency.
      let effectiveUrgency = t.urgency
      if (t.kind === "agent_notification") {
        const dataUrgency = (event.data as Record<string, unknown> | undefined)?.urgency
        if (typeof dataUrgency === "number" && Number.isFinite(dataUrgency)) {
          effectiveUrgency = Math.max(0, Math.min(100, Math.round(dataUrgency)))
        }
      }

      // An agent's own say-so orders the inbox and never makes an item urgent
      // (etiquette rule 2): only the system marks urgent, so a payload urgency
      // cannot carry a note past quiet time.
      const isUrgent =
        t.kind === "agent_notification" ? false : (t.isUrgent ?? effectiveUrgency >= 70)
      const summary = renderTemplate(t.summary, {
        actor: { name: actorName, id: event.actorId ?? null },
        payload: event,
      })

      // For kernel `message:create`, attention rows must target the thread
      // (so Home opens the thread and POST /mark-read on the thread clears the
      // row). The originating message id is preserved in `metadata.messageId`.
      let targetEntityType = event.entity
      let targetEntityId = entityId
      let extraMetadata: Record<string, unknown> | null = null
      if (event.app === "kernel" && event.entity === "message") {
        const data = (event.data ?? {}) as Record<string, unknown>
        const threadId =
          (data.threadId as string | undefined) ?? (data.thread_id as string | undefined)
        if (threadId) {
          targetEntityType = "thread"
          targetEntityId = threadId
          extraMetadata = { messageId: entityId }
        }
      }

      // A kind keyed on a sub-entity the event names (see `targetFromData`).
      if (t.targetFromData) {
        const id = ((event.data ?? {}) as Record<string, unknown>)[t.targetFromData.idField]
        if (typeof id === "string" && id.length > 0) {
          targetEntityType = t.targetFromData.entityType
          targetEntityId = id
        }
      }

      // Generic declarative `event.data.*` → row metadata copy. Absent keys are
      // skipped so a no-link notification yields no `metadata.link`.
      if (t.metadataFromData && t.metadataFromData.length > 0) {
        const data = (event.data ?? {}) as Record<string, unknown>
        for (const key of t.metadataFromData) {
          if (data[key] !== undefined) {
            extraMetadata = { ...(extraMetadata ?? {}), [key]: data[key] }
          }
        }
      }

      if (itemRequiredScopes) {
        extraMetadata = { ...(extraMetadata ?? {}), requiredScopes: itemRequiredScopes }
      }

      await loadAnchors(recipients)

      if (usingDefaultInsert) {
        // Production path: no DB write here — just record the candidate. Prefs
        // + insert happen once, after every translation has been evaluated.
        for (const userId of recipients) {
          candidates.push({
            userId,
            targetEntityType,
            targetEntityId,
            kind: t.kind,
            urgency: effectiveUrgency,
            summary,
            isUrgent,
            metadata: metadataFor(userId, extraMetadata),
          })
        }
      } else {
        // Test-double path: preserve the EXACT per-row call sequence/shape
        // existing unit tests assert on (one insertAttentionRow call per
        // recipient, in recipient order, per translation).
        const pushUsers = deps.loadPushDeviceUsers
          ? await deps.loadPushDeviceUsers(recipients, event.orgId)
          : new Set<string>()
        const shape = {
          kind: t.kind,
          isUrgent,
          targetEntityType,
          targetEntityId,
          summary,
        }
        for (const userId of recipients) {
          const prefs = await prefsFor(userId)
          const decision = await route(userId, routerItemFor(shape), prefs, pushUsers.has(userId))
          if (!decision.channels.in_app.deliver) continue
          // Propagate insert failures (I-EVT-2). The insert is an idempotent
          // upsert keyed on (user_id, app, entity_type, entity_id, kind), so
          // letting a transient failure bubble to the outbox — which retries
          // and eventually dead-letters — cannot duplicate notifications. The
          // previous swallow dropped the attention row forever on any blip.
          const stored = await insertAttentionRow(
            buildAttentionRow({
              event,
              userId,
              targetEntityType,
              targetEntityId,
              kind: t.kind,
              urgency: effectiveUrgency,
              summary,
              isUrgent,
              metadata: metadataFor(userId, extraMetadata),
              occurredAt,
              decision,
            }),
          )
          await goLive(decision, shape, stored ?? null)
        }
      }
    } catch (err) {
      // Re-throw so the durable consumer fails and the outbox retries the whole
      // event. Re-processing is safe (idempotent upserts above). A genuinely
      // poison event dead-letters after MAX_ATTEMPTS rather than silently
      // dropping notifications (I-EVT-2).
      log.warn(
        { err, kind: t.kind, event: `${event.entity}:${event.action}` },
        "translation failed — propagating for outbox retry",
      )
      throw err
    }
  }

  // D2 batching finale (production path only): resolve prefs for the union of
  // unique candidate userIds in ONE query, build every row via the pure
  // `buildAttentionRow` helper, and insert them all in ONE transaction.
  if (usingDefaultInsert && candidates.length > 0) {
    const uniqueUserIds = [...new Set(candidates.map((c) => c.userId))]
    let prefsByUser: Map<string, UserPrefsSnapshot>
    let prefsFailed = false
    try {
      prefsByUser = await loadPreferencesBatch(uniqueUserIds, event.orgId)
    } catch (err) {
      log.warn({ err, userIds: uniqueUserIds }, "batch preferences load failed — routing degraded")
      prefsByUser = new Map()
      prefsFailed = true
    }
    // Devices matter only to a row that goes live from here (non-chat group).
    let pushUsers = new Set<string>()
    const liveUsers = candidates
      .filter((c) => isAttentionLiveGroup(groupOfItem(routerItemFor(c))))
      .map((c) => c.userId)
    if (liveUsers.length > 0) {
      try {
        pushUsers = await (deps.loadPushDeviceUsers ?? defaultLoadPushDeviceUsers)(
          liveUsers,
          event.orgId,
        )
      } catch (err) {
        log.warn({ err }, "push device load failed — no push for this event")
      }
    }
    const routed: Array<{ c: Candidate; decision: RouterDecision }> = []
    const rows: AttentionRowInsert[] = []
    await loadMutedFor(uniqueUserIds)
    for (const c of candidates) {
      const prefs = prefsFailed ? null : (prefsByUser.get(c.userId) ?? DEFAULT_PREFS)
      const decision = await route(c.userId, routerItemFor(c), prefs, pushUsers.has(c.userId))
      if (!decision.channels.in_app.deliver) continue
      routed.push({ c, decision })
      rows.push(
        buildAttentionRow({
          event,
          userId: c.userId,
          targetEntityType: c.targetEntityType,
          targetEntityId: c.targetEntityId,
          kind: c.kind,
          urgency: c.urgency,
          summary: c.summary,
          isUrgent: c.isUrgent,
          metadata: c.metadata,
          occurredAt,
          decision,
        }),
      )
    }
    // Propagate insert failures (I-EVT-2) — same idempotent-upsert retry
    // contract as the per-row path, just one transaction for the whole event.
    const stored = await insertAttentionRowsBatch(rows)
    const byKey = new Map<string, InsertedAttentionRow>()
    for (const r of stored ?? []) {
      byKey.set(
        `${r.userId}\u0000${r.app}\u0000${r.entityType}\u0000${r.entityId}\u0000${r.kind}`,
        r,
      )
    }
    const seen = new Set<string>()
    for (const { c, decision } of routed) {
      const key = `${c.userId}\u0000${event.app}\u0000${c.targetEntityType}\u0000${c.targetEntityId}\u0000${c.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      await goLive(decision, c, stored ? (byKey.get(key) ?? { ...NOT_NEW }) : null)
    }
  }
}

/** A row the batch did not return (deduped away): treated as not new. */
const NOT_NEW: InsertedAttentionRow = {
  id: "",
  userId: "",
  app: "",
  entityType: "",
  entityId: "",
  kind: "",
  inserted: false,
}

async function translatorDurableHandler(ctx: DurableEventContext): Promise<void> {
  // Let errors propagate so the outbox keeps the event unprocessed and retries
  // (then dead-letters). The translation work is idempotent (see upsert above),
  // so at-least-once delivery cannot duplicate attention rows (I-EVT-2).
  await processTranslationEvent(ctx.event)
}

let registered = false
export function registerTranslatorConsumer(): void {
  if (registered) return
  registered = true
  registerDurableEventConsumer("attention-translator", translatorDurableHandler)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const AttentionTranslatorTestAccess = {
  resetRegistration(): void {
    registered = false
  },
}
