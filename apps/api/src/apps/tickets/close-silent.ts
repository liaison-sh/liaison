// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Close tickets when the customer stays silent", a per-inbox option, off by
// default. A ticket is silent when it waits on the customer (status
// awaiting_customer), our message is the last public one and nothing came in
// since. After `nudgeDays` of silence the job proposes the inbox's nudge (a
// fixed template, never text from a conversation); `closeDays` after the nudge,
// still silent, it proposes closing the ticket as `no_response`.
//
// Both steps go through the ordinary gated tools (tickets:nudge,
// tickets:close) as a non-human ("system" origin) call, so the org's approval
// policy decides them exactly as it decides an agent's: one approval card per
// ticket and step unless a policy auto-approves it.
//
// WHO acts. The job is an automation, so it never speaks as a person: every
// call runs inside the frame of the routine "Close silent tickets", an
// app-run routine (kernel-routine-templates.ts) owned by the person who
// switched the option on. RLS and permission checks stay that person's,
// CURRENT ones, while the approval card names the routine as requester, the
// nudge is labelled "Routine: Close silent tickets" and the audit records a
// system action of that routine. When that person is no longer active, the
// option switches off and the inbox admins are told (`inbox:close_silent_stopped`).
//
// Only tickets whose last org message came after the option was switched on
// count, so enabling it never fires on the backlog, and a run proposes at most
// `CLOSE_SILENT_MAX_PER_RUN` steps. A customer reply reopens the ticket, starts
// a new cycle (the nudge mark is cleared) and cancels a pending nudge or
// no-response close (`cancelSilentCloseOnReply`); our own public message or a
// status change away from awaiting_customer cancels the routine's cards
// (`cancelSilentCloseCards`), and an approval that comes late still refuses
// to act once the silence is broken (`silentStepRefusal`).
import { sql as drizzleSql } from "drizzle-orm"
import { ticketEmailLocale } from "~/apps/tickets/render"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { privilegedFrom, withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { UUID_RE } from "~/lib/uuid"
import { APP_RUN_TEMPLATE_PREFIX } from "~/modules/agent/routines/kernel-routine-templates"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { serverT } from "~/modules/i18n/server-i18n"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "tickets-close-silent" })

export const CLOSE_SILENT_DEFAULT_NUDGE_DAYS = 7
export const CLOSE_SILENT_DEFAULT_CLOSE_DAYS = 5
/** The most steps (nudges plus closes) one run of one org proposes. */
export const CLOSE_SILENT_MAX_PER_RUN = 20
/** Bounds the settings accept for either delay, in days. */
export const CLOSE_SILENT_MIN_DAYS = 1
export const CLOSE_SILENT_MAX_DAYS = 90
export const CLOSE_SILENT_MAX_TEXT = 5000

/** The routine the job's nudges and closes are attributed to. */
export const CLOSE_SILENT_ROUTINE_NAME = "Close silent tickets"
export const CLOSE_SILENT_ROUTINE_KEY = `${APP_RUN_TEMPLATE_PREFIX}tickets-close-silent`
/** The event that tells the inbox admins the option switched itself off. */
export const CLOSE_SILENT_STOPPED_ACTION = "close_silent_stopped"

const NUDGE_TOOL = "tickets:nudge"
const CLOSE_TOOL = "tickets:close"
const NUDGE_SCOPE = "tickets:tickets:reply"
const CLOSE_SCOPE = "tickets:tickets:close"
/** What the person who switches the option on must hold: the job nudges and closes as them. */
export const CLOSE_SILENT_REQUIRED_SCOPES: readonly string[] = [NUDGE_SCOPE, CLOSE_SCOPE]

/** Whether these scopes let their holder nudge and close tickets. */
export function canActForCloseSilent(scopes: readonly string[] | undefined): boolean {
  return CLOSE_SILENT_REQUIRED_SCOPES.every((s) => hasScope(s, [...(scopes ?? [])]))
}

/** The nudge a customer gets when the inbox keeps the default wording. */
export function defaultSilentNudgeText(
  ticketLanguage: string | null | undefined,
  orgDefaultLocale: string | null | undefined,
  closeDays: number,
): string {
  const locale = ticketEmailLocale(ticketLanguage, orgDefaultLocale)
  return serverT(locale, "tickets.closeSilent.defaultNudge", { days: closeDays })
}

export interface SilentStep {
  step: "nudge" | "close"
  ticketId: string
  inboxId: string
  /** The person the inbox's option acts as. */
  actingUserId: string
  /** The text the nudge sends (only for step "nudge"). */
  textBody?: string
}

interface CandidateRow {
  id: string
  step: "nudge" | "close"
  inbox_id: string
  language: string | null
  enabled_by: string
  close_days: number
  nudge_text: string | null
  default_locale: string | null
}

/**
 * The steps due in one org at `now`, oldest silence first, at most
 * `CLOSE_SILENT_MAX_PER_RUN`. Read-only. A ticket already holding a pending
 * approval for the step, or one decided since our last message (a rejected or
 * expired nudge is not proposed again until something new is said), is left
 * alone.
 */
export async function findSilentSteps(orgId: string, now: Date): Promise<SilentStep[]> {
  const nowIso = now.toISOString()
  const rows = await withSystemDb(`tickets-close-silent-scan:${orgId}`, async (tx) =>
    extractRows<CandidateRow>(
      await tx.execute(drizzleSql`
        WITH inb AS (
          SELECT id, close_silent_enabled_at AS enabled_at, close_silent_enabled_by AS enabled_by,
                 COALESCE(close_silent_nudge_days, ${CLOSE_SILENT_DEFAULT_NUDGE_DAYS}) AS nudge_days,
                 COALESCE(close_silent_close_days, ${CLOSE_SILENT_DEFAULT_CLOSE_DAYS}) AS close_days,
                 close_silent_nudge_text AS nudge_text
          FROM ${ticketsRel("inboxes")}
          WHERE org_id = ${orgId}
            AND close_silent_enabled = true
            AND close_silent_enabled_at IS NOT NULL
            AND close_silent_enabled_by IS NOT NULL
            AND archived_at IS NULL
        ),
        due AS (
          SELECT t.id, t.language, t.last_outbound_at,
                 CASE WHEN t.nudge_sent_at IS NULL THEN 'nudge' ELSE 'close' END AS step,
                 inb.id AS inbox_id, inb.enabled_by::text AS enabled_by,
                 inb.close_days, inb.nudge_text
          FROM ${ticketsRel("tickets")} t
          JOIN inb ON inb.id = t.source_inbox_id
          WHERE t.org_id = ${orgId}
            AND t.status = 'awaiting_customer'
            AND t.merged_into_ticket_id IS NULL
            AND t.converted_to_mail_conversation_id IS NULL
            -- Our public message is the last one and the customer said nothing since.
            AND t.last_outbound_at IS NOT NULL
            AND (t.last_inbound_at IS NULL OR t.last_inbound_at < t.last_outbound_at)
            -- No backlog: only silences that began after the option was switched on.
            AND t.last_outbound_at > inb.enabled_at
            AND (
              (t.nudge_sent_at IS NULL
                AND t.last_outbound_at <= ${nowIso}::timestamptz - make_interval(days => inb.nudge_days))
              OR (t.nudge_sent_at IS NOT NULL
                AND t.nudge_sent_at > inb.enabled_at
                AND (t.last_inbound_at IS NULL OR t.last_inbound_at < t.nudge_sent_at)
                AND t.nudge_sent_at <= ${nowIso}::timestamptz - make_interval(days => inb.close_days)
                AND t.last_outbound_at <= ${nowIso}::timestamptz - make_interval(days => inb.close_days))
            )
        )
        SELECT due.id::text AS id, due.step, due.inbox_id::text AS inbox_id, due.language,
               due.enabled_by, due.close_days, due.nudge_text, o.default_locale
        FROM due
        JOIN ${kernelRel("organizations")} o ON o.id = ${orgId}
        WHERE NOT EXISTS (
          SELECT 1 FROM ${kernelRel("approval_requests")} ar
          WHERE ar.org_id = ${orgId}
            AND ar.tool_name = CASE WHEN due.step = 'nudge' THEN ${NUDGE_TOOL} ELSE ${CLOSE_TOOL} END
            AND (ar.tool_params->>'ticketId' = due.id::text
                 OR ar.current_payload->>'ticketId' = due.id::text)
            AND (ar.status IN ('pending', 'approving') OR ar.created_at >= due.last_outbound_at)
        )
        ORDER BY due.last_outbound_at ASC, due.id ASC
        LIMIT ${CLOSE_SILENT_MAX_PER_RUN}
      `),
    ),
  )
  return rows.map((r) => ({
    step: r.step,
    ticketId: r.id,
    inboxId: r.inbox_id,
    actingUserId: r.enabled_by,
    ...(r.step === "nudge"
      ? {
          textBody:
            r.nudge_text && r.nudge_text.trim() !== ""
              ? r.nudge_text
              : defaultSilentNudgeText(r.language, r.default_locale, Number(r.close_days)),
        }
      : {}),
  }))
}

/** The call the job makes; the real one is `executeTool`, a test passes its own. */
export type SilentStepTool = (call: {
  toolName: string
  orgId: string
  actor: UserContext
  params: Record<string, unknown>
  origin: "system"
  priority: "background"
}) => Promise<{ blocked?: unknown }>

/** Loads the acting person as an RLS actor, or null when they are no longer active. */
export type SilentActorLoader = (orgId: string, userId: string) => Promise<UserContext | null>

export interface CloseSilentRunOptions {
  /** The run's clock. Defaults to the current time. */
  now?: Date
  runTool?: SilentStepTool
  loadActor?: SilentActorLoader
}

export interface CloseSilentRunReport {
  /** Steps proposed and parked for approval. */
  staged: number
  /** Steps a policy let through and that ran. */
  ran: number
  failed: number
  /** Steps whose inbox's acting person is gone, inactive or no longer allowed to
   *  nudge and close (the option is then switched off). */
  skipped: number
}

async function loadActingUser(orgId: string, userId: string): Promise<UserContext | null> {
  if (!UUID_RE.test(userId)) return null
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  return withPrivilegedDb(orgId, "tickets-close-silent-actor", async (pdb) => {
    const active = extractRows<{ id: string }>(
      await pdb.execute(drizzleSql`
        SELECT id FROM ${kernelRel("users")}
        WHERE id = ${userId} AND org_id = ${orgId} AND status = 'active'
        LIMIT 1`),
    )
    if (active.length === 0) return null
    const perms = await loadEffectivePermissions(pdb, userId, orgId)
    return {
      actorType: "user",
      userId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    }
  })
}

async function realRunTool(call: Parameters<SilentStepTool>[0]): Promise<{ blocked?: unknown }> {
  const { executeTool } = await import("~/modules/apps/execute-tool")
  return executeTool(call)
}

const ROUTINE_DESCRIPTION =
  "Nudges, then closes, tickets whose customer stays silent, for the inboxes where you switched that option on."
const ROUTINE_PROMPT = [
  "Run by the Tickets app, without an agent, for the inboxes where this person switched on",
  '"Close tickets when the customer stays silent". The nudges and closes it proposes are',
  "attributed to this routine. To stop it, switch the option off in the inbox's settings.",
].join(" ")

/**
 * The person's "Close silent tickets" routine, created on first use. It is an
 * app-run routine: disabled, never ticked, never edited (the inbox option is
 * its switch), shared so every approver sees its name on the cards. Should
 * the person already have a routine of that name of their own, this one takes
 * a distinct name rather than borrowing theirs.
 */
export async function ensureCloseSilentRoutine(
  orgId: string,
  ownerUserId: string,
): Promise<string> {
  return withPrivilegedDb(orgId, "tickets-close-silent-routine", async (pdb) => {
    const find = async () =>
      extractRows<{ id: string }>(
        await pdb.execute(drizzleSql`
          SELECT id::text AS id FROM ${kernelRel("routines")}
          WHERE org_id = ${orgId} AND owner_user_id = ${ownerUserId}
            AND template_key = ${CLOSE_SILENT_ROUTINE_KEY}
          ORDER BY created_at ASC
          LIMIT 1`),
      )[0]?.id ?? null
    for (const name of [CLOSE_SILENT_ROUTINE_NAME, `${CLOSE_SILENT_ROUTINE_NAME} (Tickets)`]) {
      const existing = await find()
      if (existing) return existing
      const inserted = extractRows<{ id: string }>(
        await pdb.execute(drizzleSql`
          INSERT INTO ${kernelRel("routines")} (
            org_id, owner_user_id, name, description, kind, cron, timezone, app_name,
            template_key, source_kind, prompt, scopes, visibility, enabled, status,
            created_by_user_id, created_by_actor_type
          ) VALUES (
            ${orgId}, ${ownerUserId}, ${name}, ${ROUTINE_DESCRIPTION}, 'recurring', '17 * * * *',
            'UTC', 'tickets', ${CLOSE_SILENT_ROUTINE_KEY}, 'kernel', ${ROUTINE_PROMPT},
            ${`{${NUDGE_SCOPE},${CLOSE_SCOPE}}`}::text[], 'shared', false, 'active',
            ${ownerUserId}, 'user'
          )
          ON CONFLICT DO NOTHING
          RETURNING id::text AS id`),
      )[0]?.id
      if (inserted) return inserted
    }
    const raced = await find()
    if (raced) return raced
    throw new Error("close-silent: could not create the routine its steps are attributed to")
  })
}

/** Why the option stopped: its person left, or no longer holds the reply and close permissions. */
type StopReason = "owner_inactive" | "owner_forbidden"

/**
 * The person who switched the option on can no longer act: switch it off on
 * every inbox they switched it on for, and tell the inbox admins (an
 * attention item for each holder of tickets:inboxes:admin), so the inbox does
 * not silently stop closing. Returns the inboxes switched off.
 */
async function stopForOwner(orgId: string, userId: string, reason: StopReason): Promise<string[]> {
  return withPrivilegedDb(orgId, "tickets-close-silent-stop", async (pdb) => {
    const stopped = extractRows<{ id: string; name: string }>(
      await pdb.execute(drizzleSql`
        UPDATE ${ticketsRel("inboxes")}
        SET close_silent_enabled = false, close_silent_enabled_at = NULL,
            close_silent_enabled_by = NULL, updated_at = now()
        WHERE org_id = ${orgId} AND close_silent_enabled = true
          AND close_silent_enabled_by = ${userId}::uuid
        RETURNING id::text AS id, name`),
    )
    for (const inbox of stopped) {
      await pdb.queueEvent({
        app: "tickets",
        entity: "inbox",
        action: CLOSE_SILENT_STOPPED_ACTION,
        entityId: inbox.id,
        data: { id: inbox.id, name: inbox.name, reason },
        actorId: null,
        actorType: "system",
        orgId,
        timestamp: new Date().toISOString(),
      })
    }
    return stopped.map((i) => i.id)
  })
}

/** A refusal for lack of permission, as `executeTool` throws it. */
function isForbidden(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const e = err as { code?: unknown; status?: unknown }
  return e.code === "forbidden" || e.status === 403
}

/** One org's run: the scheduled `closeSilentCheck` job (its `runsFor` keeps it to orgs using the option). */
export async function runCloseSilentCheck(
  orgId: string,
  opts: CloseSilentRunOptions = {},
): Promise<CloseSilentRunReport> {
  const now = opts.now ?? new Date()
  const runTool = opts.runTool ?? realRunTool
  const loadActor = opts.loadActor ?? loadActingUser
  const report: CloseSilentRunReport = { staged: 0, ran: 0, failed: 0, skipped: 0 }
  const steps = await findSilentSteps(orgId, now)
  const actors = new Map<string, { actor: UserContext; routineId: string } | null>()
  // The person can no longer act: switch the option off on their inboxes and
  // tell the inbox admins, once per person and run.
  const stop = async (userId: string, reason: StopReason) => {
    const inboxes = await stopForOwner(orgId, userId, reason)
    log.warn(
      { orgId, inboxIds: inboxes, userId, reason },
      "close-silent: the person who switched the option on can no longer act; switched it off",
    )
    actors.set(userId, null)
  }
  for (const s of steps) {
    if (!actors.has(s.actingUserId)) {
      const actor = await loadActor(orgId, s.actingUserId)
      if (!actor) await stop(s.actingUserId, "owner_inactive")
      else if (!canActForCloseSilent(actor.scopes)) await stop(s.actingUserId, "owner_forbidden")
      else {
        actors.set(s.actingUserId, {
          actor,
          routineId: await ensureCloseSilentRoutine(orgId, s.actingUserId),
        })
      }
    }
    const acting = actors.get(s.actingUserId) ?? null
    if (!acting) {
      report.skipped++
      continue
    }
    const params: Record<string, unknown> =
      s.step === "nudge"
        ? { ticketId: s.ticketId, textBody: s.textBody }
        : { ticketId: s.ticketId, closedReason: "no_response" }
    try {
      // The routine's frame: what the call stages, sends and audits is the
      // routine's, while it runs as (and with the permissions of) its owner.
      const runId = crypto.randomUUID()
      const result = await runContextStore.run(
        {
          runId,
          parentRunId: null,
          rootRunId: runId,
          nestingDepth: 0,
          background: true,
          routineId: acting.routineId,
          // The job read nothing from any conversation: its call carries no
          // taint (an absent accumulator would read as "unknown" and park it).
          turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
        },
        () =>
          runTool({
            toolName: s.step === "nudge" ? NUDGE_TOOL : CLOSE_TOOL,
            orgId,
            actor: acting.actor,
            params,
            origin: "system",
            priority: "background",
          }),
      )
      if (result.blocked) report.staged++
      else report.ran++
    } catch (err) {
      // The person's permissions changed under the run: as if they had left.
      if (isForbidden(err)) {
        await stop(s.actingUserId, "owner_forbidden")
        report.skipped++
        continue
      }
      report.failed++
      log.warn(
        { err, orgId, ticketId: s.ticketId, step: s.step },
        "close-silent: the step was refused or failed",
      )
    }
  }
  if (steps.length > 0) log.info({ orgId, ...report }, "close-silent run")
  return report
}

/** The routine cards of this module: approvals raised in its routine's frame. */
const routineCard = (orgId: string) => drizzleSql`
  ar.metadata->>'originRoutineId' IN (
    SELECT r.id::text FROM ${kernelRel("routines")} r
    WHERE r.org_id = ${orgId} AND r.template_key = ${CLOSE_SILENT_ROUTINE_KEY})`

/**
 * The silence a close-silent nudge or close was proposed on is broken: the
 * routine's cards for this ticket, pending or being approved, no longer apply.
 * `customer_replied` also cancels any pending nudge, and any pending close for
 * lack of a response, whoever proposed it. `exceptApprovalId` is the approval
 * whose own execution caused the change (a nudge's own message, a close's own
 * status change), which must not cancel itself. Runs on the caller's
 * transaction when it can (`privilegedFrom`), so the cancel commits with the
 * change that caused it.
 */
export async function cancelSilentCloseCards(
  tx: Pick<RlsClient, "execute">,
  args: {
    orgId: string
    ticketId: string
    reason: "customer_replied" | "we_wrote" | "status_changed"
    exceptApprovalId?: string | null
  },
): Promise<number> {
  const { orgId, ticketId, reason } = args
  const except =
    args.exceptApprovalId && UUID_RE.test(args.exceptApprovalId) ? args.exceptApprovalId : null
  return privilegedFrom(tx, orgId, "tickets-close-silent-cancel", async (ptx) => {
    const cancelled = extractRows<{ id: string }>(
      await ptx.execute(drizzleSql`
        UPDATE ${kernelRel("approval_requests")} ar
        SET status = 'cancelled', decided_at = now(), reason = ${reason}
        WHERE ar.org_id = ${orgId}
          AND (${except}::uuid IS NULL OR ar.id <> ${except}::uuid)
          AND ar.tool_name IN (${NUDGE_TOOL}, ${CLOSE_TOOL})
          AND (
            ar.tool_params @> jsonb_build_object('ticketId', ${ticketId}::text)
            OR ar.current_payload @> jsonb_build_object('ticketId', ${ticketId}::text)
          )
          AND (
            (ar.status IN ('pending', 'approving') AND ${routineCard(orgId)})
            OR (${reason === "customer_replied"}::boolean AND ar.status = 'pending' AND (
              ar.tool_name = ${NUDGE_TOOL}
              OR COALESCE(ar.current_payload->>'closedReason', ar.tool_params->>'closedReason') = 'no_response'
            ))
          )
        RETURNING ar.id::text AS id
      `),
    )
    return cancelled.length
  })
}

/** A customer wrote back: see `cancelSilentCloseCards`. */
export function cancelSilentCloseOnReply(
  tx: Pick<RlsClient, "execute">,
  orgId: string,
  ticketId: string,
): Promise<number> {
  return cancelSilentCloseCards(tx, { orgId, ticketId, reason: "customer_replied" })
}

/** The refusal of a step that no longer applies. Final: approving it again cannot pass. */
export const SILENT_STEP_NO_LONGER_APPLIES = {
  code: "no_longer_applicable",
  retryable: false,
  final: true,
  message:
    "Nothing was sent or closed: the ticket is no longer waiting on a silent customer (someone wrote, or its status changed, since this was proposed).",
} as const

/**
 * Execute time, for a call made in the close-silent routine's frame (the job's
 * own, or one approved later): refuse unless the silence it was proposed on
 * still holds. The ticket must still be awaiting the customer, our public
 * message the last one, and, for an approved card, nothing sent or received
 * since the card was created. A refused card is marked no longer applicable.
 * Null when the call is not the routine's or the step still applies.
 */
export async function silentStepRefusal(args: {
  orgId: string
  routineId: string | null | undefined
  ticketId: string
  approvalRequestId?: string | null
}): Promise<typeof SILENT_STEP_NO_LONGER_APPLIES | null> {
  const { orgId, routineId, ticketId } = args
  if (!routineId || !UUID_RE.test(routineId) || !UUID_RE.test(ticketId)) return null
  const approvalId =
    args.approvalRequestId && UUID_RE.test(args.approvalRequestId) ? args.approvalRequestId : null
  return withPrivilegedDb(orgId, "tickets-close-silent-recheck", async (pdb) => {
    const [row] = extractRows<{ routine: boolean; applies: boolean | null }>(
      await pdb.execute(drizzleSql`
        SELECT
          EXISTS (
            SELECT 1 FROM ${kernelRel("routines")}
            WHERE id = ${routineId}::uuid AND org_id = ${orgId}
              AND template_key = ${CLOSE_SILENT_ROUTINE_KEY}
          ) AS routine,
          (
            SELECT t.status = 'awaiting_customer'
              AND t.last_outbound_at IS NOT NULL
              AND (t.last_inbound_at IS NULL OR t.last_inbound_at < t.last_outbound_at)
              AND (ar.created_at IS NULL OR (
                t.last_outbound_at < ar.created_at
                AND (t.last_inbound_at IS NULL OR t.last_inbound_at < ar.created_at)))
            FROM ${ticketsRel("tickets")} t
            LEFT JOIN ${kernelRel("approval_requests")} ar
              ON ar.id = ${approvalId}::uuid AND ar.org_id = ${orgId}
            WHERE t.id = ${ticketId}::uuid AND t.org_id = ${orgId}
          ) AS applies`),
    )
    if (!row?.routine || row.applies === true) return null
    if (approvalId) {
      await pdb.execute(drizzleSql`
        UPDATE ${kernelRel("approval_requests")}
        SET reason = ${SILENT_STEP_NO_LONGER_APPLIES.code}
        WHERE id = ${approvalId}::uuid AND org_id = ${orgId}`)
    }
    return SILENT_STEP_NO_LONGER_APPLIES
  })
}
