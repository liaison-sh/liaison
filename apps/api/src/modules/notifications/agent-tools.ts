// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent tools over the user's OWN notification settings (S17, D5):
 * `notifications_get`, `notifications_set`, `notification_rules_set`,
 * `thread_mute_set`.
 *
 * - Self only: no tool takes a user id; every read and write is keyed on the
 *   turn's human user (`ctx.userId`) under that user's RLS.
 * - Only in a live turn a person started: refused in a routine tick, any
 *   background run (sub-run, job-driven re-invocation), an `agents_ask`
 *   (coordinated) turn, and outside any agent turn.
 * - No approval gate (D5). Instead each write that changes something queues
 *   ONE `notification_settings:update` kernel event: the durable audit consumer
 *   records it with the before/after diff, and the attention translator turns
 *   it into a `system_alert` feed item ("Your agent changed your notification
 *   settings: ..."), which no per-app rule narrows and whose in-app channel
 *   cannot be switched off.
 * - Every result is a small digest (the agentic-digest rule).
 */
import {
  APPROVAL_REMINDER_FREQUENCIES,
  type ApprovalReminderFrequency,
  isNotificationGroupId,
  NOTIFICATION_GROUP_IDS,
  NOTIFICATION_GROUPS,
  type ShippedLocale,
} from "@liaison/shared"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { attentionSubscriptions, userThreadState } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { currentRunContext, isPersonClientFrame } from "~/modules/agent/runtime/run-context"
import { serverT } from "~/modules/i18n/server-i18n"
import { recipientLocale } from "~/modules/push/fanout-consumer"
import { queueReadState } from "~/modules/threads/read-state-broadcast"
import { updateThreadState } from "~/modules/threads/thread-state"
import { DAY_KEYS, describeQuietHours, quietHoursToWorkWindow } from "./quiet-hours"
import {
  DIGEST_CADENCES,
  getNotificationSettings,
  type NotificationSettings,
  NotificationSettingsError,
  type NotificationSettingsPatch,
  updateNotificationSettings,
} from "./settings"

const K = sql.raw(schemaRef("kernel"))

export interface NotificationToolContext {
  userId: string
  orgId: string
  db: RlsClient
  actorType: "user" | "agent" | "mcp"
  originRoutineId?: string
  agentId?: string | null
}

export type ToolRefusal = { error: { code: string; message: string } }

const SWITCHABLE_CHANNELS = ["desktop", "push", "email"] as const
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

// ---------------------------------------------------------------------------
// Context guard
// ---------------------------------------------------------------------------

/**
 * Null when the call may run; otherwise the refusal to return. Read off the run
 * frame the tool bridge runs under.
 *
 * A CHANGE runs only in a live agent turn a person started. A READ of the
 * person's own settings runs wherever that person is the caller: a live turn,
 * a direct call with no agent run around it (their MCP client), or their own
 * question relayed from an external app. It is still refused where someone
 * else is asking: a routine, another agent's question, a background run. The
 * refusal copy (REFUSAL) says "read or changed", true for both operations.
 */
export function refuseOutsideInteractiveTurn(
  ctx: NotificationToolContext,
  op: "read" | "change" = "change",
): ToolRefusal | null {
  const frame = currentRunContext()
  const read = op === "read"
  let message: string | null = null
  if (ctx.originRoutineId || frame?.routineId) message = REFUSAL.routine
  // A person's own external client (no agent bound) reads as no frame did (rule 14).
  else if (!frame || isPersonClientFrame(frame)) message = read ? null : REFUSAL.outsideTurn
  // An agent-bound MCP connection: the person may read their own settings
  // (as with their own MCP client), but nothing proves a person asked for a
  // change, so a change is refused.
  else if (frame.mcpGateway) message = read ? null : REFUSAL.gateway
  else if (frame.coordinated) {
    // The person's own question relayed from their external app: they are the
    // caller, so they may read; a colleague agent's question may not.
    if (frame.coordinatedBy === "external-app") message = read ? null : REFUSAL.externalApp
    else message = REFUSAL.agentAsk
  } else if (frame.background || frame.nestingDepth > 0) message = REFUSAL.background
  if (!message) return null
  return { error: { code: "E_INTERACTIVE_ONLY", message } }
}

/**
 * What the model is told, per reason. Each one says WHY in terms that are
 * true for this turn and WHAT the person can do next, because the model turns
 * it into the reply. The earlier single sentence called a person's own
 * question, relayed from an external app into their chat with the agent, "a
 * question from another agent", and told them to "ask in their own chat"
 * while they were in it: the agent repeated both to the person, in the wrong
 * language, and then tried to ask itself.
 */
const SETTINGS_PATH = "Settings > Notifications"
const REPLY_RULE =
  "Say it in the language of the person's message, in plain words, without naming a tool."
export const REFUSAL = {
  externalApp: `Notification settings can only be read or changed when the person writes to you inside Liaison, and this request was relayed from an external app. Tell the person they can see and change them in ${SETTINGS_PATH}, or send you this same request from the Liaison app (web or mobile), where you can do it. Do not ask another agent for it, yourself included. ${REPLY_RULE}`,
  agentAsk: `Notification settings can only be read or changed when the person writes to you directly, and this turn is answering a question another agent asked you. Say that the person can see and change them in ${SETTINGS_PATH}, or ask you directly in Liaison. Do not ask another agent for it. ${REPLY_RULE}`,
  routine: `Notification settings can only be read or changed when the person writes to you, not in a routine run. Note that the person can change them in ${SETTINGS_PATH}. ${REPLY_RULE}`,
  background: `Notification settings can only be read or changed in the person's live conversation with you, not in a background run. Note that the person can change them in ${SETTINGS_PATH}. ${REPLY_RULE}`,
  outsideTurn: `Notification settings can only be read or changed in the person's live conversation with an agent. They can change them in ${SETTINGS_PATH}.`,
  gateway: `Changing notification settings works from the person's chat in the Liaison web or phone app, or in ${SETTINGS_PATH}, not from this connection. Tell them so. ${REPLY_RULE}`,
} as const

// ---------------------------------------------------------------------------
// Digest helpers
// ---------------------------------------------------------------------------

type Flat = Record<string, string | boolean | null>

function flattenSettings(s: NotificationSettings): Flat {
  const out: Flat = {}
  for (const g of NOTIFICATION_GROUP_IDS) {
    for (const ch of SWITCHABLE_CHANNELS) out[`${g}.${ch}`] = s.grid[g][ch]
  }
  out.workHours = `${s.workHours.start}-${s.workHours.end}`
  out.workDays = s.workHours.days.join(",")
  out.timezone = s.workHours.timezone
  out.workHoursExplicit = s.workHours.explicit
  out.digestCadence = s.digestCadence
  out.approvalReminder = s.approvalReminder
  return out
}

export interface SettingsDiff {
  before: Flat
  after: Flat
}

export function diffFlat(a: Flat, b: Flat): SettingsDiff {
  const before: Flat = {}
  const after: Flat = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key] ?? null
    const y = b[key] ?? null
    if (x !== y) {
      before[key] = x
      after[key] = y
    }
  }
  return { before, after }
}

function daysLabel(csv: string | boolean | null): string {
  if (typeof csv !== "string" || csv === "") return ""
  return csv
    .split(",")
    .map((d) => DAY_NAMES[Number(d)] ?? d)
    .join(",")
}

/** One localized phrase per changed key, for the feed item. */
function describeChange(locale: ShippedLocale, key: string, value: Flat[string]): string | null {
  const t = (k: string, p?: Record<string, string>) =>
    serverT(locale, `kernel.agentNotificationChange.${k}`, p)
  const [group, channel] = key.split(".")
  if (channel && group && isNotificationGroupId(group)) {
    return `${t(`groups.${group}`)}: ${t(`channels.${channel}`)} ${t(value ? "on" : "off")}`
  }
  switch (key) {
    case "workHours":
      return t("workHours", { value: String(value) })
    case "workDays":
      return t("workDays", { value: daysLabel(value) })
    case "timezone":
      return t("timezone", { value: String(value) })
    case "digestCadence":
      return t("digest", { value: t(`cadence.${String(value)}`) })
    case "approvalReminder":
      return t("approvalReminder", { value: t(`approvalReminderFrequency.${String(value)}`) })
    default:
      return null
  }
}

async function userLocale(ctx: NotificationToolContext): Promise<ShippedLocale> {
  // The recipient's language as the push fan-out and the digest read it: their
  // own choice, else the org default. Organizations are not readable under a
  // user's RLS, so the fan-out's own lookup (bound to org_id and user_id)
  // answers it rather than a second privileged read here.
  try {
    return await recipientLocale(ctx.orgId, ctx.userId)
  } catch {
    return "en"
  }
}

/**
 * Queue the audit + feed event for one change. `phrases` are the localized
 * change fragments the feed item lists.
 */
async function announce(
  ctx: NotificationToolContext,
  tool: string,
  diff: SettingsDiff,
  phrases: string[],
  locale: ShippedLocale,
): Promise<void> {
  const changes = phrases.join(", ")
  const summary = serverT(locale, "kernel.agentNotificationChange.changed", { changes })
  await ctx.db.queueEvent({
    app: "kernel",
    entity: "notification_settings",
    action: "update",
    entityId: ctx.userId,
    data: {
      tool,
      before: diff.before,
      after: diff.after,
      summary: summary.slice(0, 500),
      targetUserIds: [ctx.userId],
      link: { tabType: "kernel:settings", entityId: "notifications" },
    },
    actorId: ctx.userId,
    actorType: ctx.actorType,
    orgId: ctx.orgId,
    timestamp: new Date().toISOString(),
  })
}

/** Compact view of the grid: per group, the switchable channels that are on. */
function compactGrid(s: NotificationSettings): Record<string, string> {
  const out: Record<string, string> = {}
  for (const g of NOTIFICATION_GROUP_IDS) {
    const on = SWITCHABLE_CHANNELS.filter((ch) => s.grid[g][ch])
    out[g] = on.length > 0 ? on.join(",") : "in_app only"
  }
  return out
}

const CHANNEL_WORDS: Record<(typeof SWITCHABLE_CHANNELS)[number], string> = {
  push: "Phone (push)",
  desktop: "Computer (desktop)",
  email: "Email digest",
}

/**
 * The settings as plain sentences the agent can quote as they are: per channel
 * the groups that reach it, the quiet hours in the quiet form people use, the
 * digest cadence.
 */
export function settingsSummary(s: NotificationSettings): string {
  const label = (g: string) => NOTIFICATION_GROUPS.find((x) => x.id === g)?.label ?? g
  const lines = SWITCHABLE_CHANNELS.map((ch) => {
    const on = NOTIFICATION_GROUP_IDS.filter((g) => s.grid[g][ch]).map(label)
    const suffix = ch === "email" ? ` (${s.digestCadence})` : ""
    return `${CHANNEL_WORDS[ch]}${suffix}: ${on.length > 0 ? on.join("; ") : "nothing"}.`
  })
  return [
    ...lines,
    describeQuietHours(s.workHours),
    "In-app feed: always on for everything.",
    APPROVAL_REMINDER_WORDS[s.approvalReminder],
  ].join("\n")
}

const APPROVAL_REMINDER_WORDS: Record<ApprovalReminderFrequency, string> = {
  daily: "Reminders of their own requests waiting for a decision: daily.",
  every_3_days: "Reminders of their own requests waiting for a decision: every 3 days.",
  weekly: "Reminders of their own requests waiting for a decision: weekly.",
  off: "Reminders of their own requests waiting for a decision: off.",
}

function changedLines(diff: SettingsDiff): string[] {
  return Object.keys(diff.after).map(
    (k) => `${k}: ${String(diff.before[k] ?? "none")} -> ${String(diff.after[k] ?? "none")}`,
  )
}

// ---------------------------------------------------------------------------
// notifications_get
// ---------------------------------------------------------------------------

export const notificationsGetParams = z.object({}).strict()

export async function handleNotificationsGet(
  _params: z.infer<typeof notificationsGetParams>,
  ctx: NotificationToolContext,
) {
  const refusal = refuseOutsideInteractiveTurn(ctx, "read")
  if (refusal) return refusal
  const s = await getNotificationSettings(ctx.userId, ctx.orgId, ctx.db)
  const rules = await ctx.db
    .select({
      app: attentionSubscriptions.source,
      kinds: attentionSubscriptions.kinds,
      enabled: attentionSubscriptions.enabled,
    })
    .from(attentionSubscriptions)
    .where(eq(attentionSubscriptions.userId, ctx.userId))
  const muted = (await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM ${K}.user_thread_state
         WHERE user_id = ${ctx.userId} AND is_muted`,
  )) as unknown as Array<{ n: number }>
  return {
    summary: settingsSummary(s),
    groups: Object.fromEntries(NOTIFICATION_GROUPS.map((g) => [g.id, g.label])),
    channelsOn: compactGrid(s),
    quietHours: !s.workHours.quiet
      ? "none"
      : {
          from: s.workHours.end,
          to: s.workHours.start,
          allDayOn: [0, 1, 2, 3, 4, 5, 6]
            .filter((d) => !s.workHours.days.includes(d))
            .map((d) => DAY_KEYS[d]),
          timezone: s.workHours.timezone,
          timezoneSource: s.workHours.timezoneSource,
          isDefault: !s.workHours.explicit,
        },
    mutedKinds: s.mutedGroups,
    digestCadence: s.digestCadence,
    approvalReminder: s.approvalReminder,
    appRules: rules.map((r) => ({
      app: r.app,
      enabled: r.enabled,
      kinds: r.kinds.includes("*") || r.kinds.length === 0 ? "all" : r.kinds.join(","),
    })),
    mutedThreads: muted[0]?.n ?? 0,
    note: "Quote `summary` to the user. In-app is always on. Channels: desktop, push (phone), email (digest).",
  }
}

// ---------------------------------------------------------------------------
// notifications_set
// ---------------------------------------------------------------------------

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM")

export const notificationsSetParams = z
  .object({
    cells: z
      .array(
        z
          .object({
            group: z.enum(NOTIFICATION_GROUP_IDS),
            channel: z.enum(SWITCHABLE_CHANNELS),
            on: z.boolean(),
          })
          .strict(),
      )
      // A full grid: every group times every switchable channel, so the cap follows the table.
      .max(NOTIFICATION_GROUP_IDS.length * SWITCHABLE_CHANNELS.length)
      .optional()
      .describe(
        "Grid cells to switch. push is the phone. In-app cannot be switched off. Groups: direct, replies, approvals, work, mail, agent, monitoring (monitoring incidents), system, and the computer sessions: session_needs_you (a session waits for the user), session_done, session_failed.",
      ),
    quietHours: z
      .object({
        from: HHMM.describe("When the quiet period STARTS, e.g. 21:00"),
        to: HHMM.describe("When the quiet period ENDS, e.g. 08:00 (may be the next morning)"),
        allDayOn: z
          .array(z.enum(DAY_KEYS))
          .max(7)
          .optional()
          .describe('Days that are quiet ALL DAY, e.g. ["sat","sun"]'),
        allWeekend: z.boolean().optional().describe("true = quiet all day Saturday and Sunday"),
        timezone: z.string().min(1).max(64).optional().describe("IANA name, e.g. Europe/Paris"),
      })
      .strict()
      .optional()
      .describe(
        'Use this whenever the user talks about QUIET hours ("quiet from 21:00 to 08:00, and all weekend" = {from:"21:00", to:"08:00", allWeekend:true}). The server converts it; do not convert it yourself. Do not combine with workHours or workDays.',
      ),
    workHours: z
      .object({ start: HHMM, end: HHMM })
      .strict()
      .optional()
      .describe(
        "WORK hours, only when the user states their working hours. For quiet hours use quietHours.",
      ),
    workDays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .optional()
      .describe("WORK days, 0 = Sunday ... 6 = Saturday. For quiet days use quietHours.allDayOn."),
    timezone: z.string().min(1).max(64).optional().describe("IANA name, e.g. Europe/Paris"),
    digestCadence: z.enum(DIGEST_CADENCES).optional(),
    approvalReminder: z
      .enum(APPROVAL_REMINDER_FREQUENCIES)
      .optional()
      .describe(
        'How often you remind the user of their own requests still waiting for a decision: daily (the default), every_3_days, weekly, or off. "stop reminding me about my approvals" = off; "remind me weekly" = weekly.',
      ),
  })
  .strict()

export async function handleNotificationsSet(
  params: z.infer<typeof notificationsSetParams>,
  ctx: NotificationToolContext,
) {
  const refusal = refuseOutsideInteractiveTurn(ctx)
  if (refusal) return refusal
  let quiet: { start: string; end: string; days: number[]; timezone?: string } | null = null
  if (params.quietHours) {
    if (params.workHours || params.workDays) {
      return {
        error: {
          code: "E_INVALID_SETTING",
          message:
            "Pass quietHours OR workHours/workDays, not both. For quiet hours pass quietHours only.",
        },
      }
    }
    const converted = quietHoursToWorkWindow(params.quietHours)
    if (!converted.ok) return { error: { code: "E_INVALID_SETTING", message: converted.message } }
    quiet = converted.value
  }
  const patch: NotificationSettingsPatch = {}
  if (params.cells?.length) {
    const grid: Record<string, Record<string, boolean>> = {}
    for (const c of params.cells) grid[c.group] = { ...grid[c.group], [c.channel]: c.on }
    patch.grid = grid
  }
  if (quiet) {
    patch.workHours = {
      start: quiet.start,
      end: quiet.end,
      days: quiet.days,
      ...((quiet.timezone ?? params.timezone)
        ? { timezone: quiet.timezone ?? params.timezone }
        : {}),
    }
  } else if (params.workHours || params.workDays || params.timezone) {
    patch.workHours = {
      ...(params.workHours ?? {}),
      ...(params.workDays ? { days: params.workDays } : {}),
      ...(params.timezone ? { timezone: params.timezone } : {}),
    }
  }
  if (params.digestCadence) patch.digestCadence = params.digestCadence
  if (params.approvalReminder) patch.approvalReminder = params.approvalReminder
  if (Object.keys(patch).length === 0) {
    return { error: { code: "E_NOTHING_TO_CHANGE", message: "Pass at least one setting." } }
  }

  const before = await getNotificationSettings(ctx.userId, ctx.orgId, ctx.db)
  let after: NotificationSettings
  try {
    after = await updateNotificationSettings(ctx.userId, ctx.orgId, patch, ctx.db)
  } catch (err) {
    if (err instanceof NotificationSettingsError) {
      return { error: { code: "E_INVALID_SETTING", message: err.message } }
    }
    throw err
  }
  const diff = diffFlat(flattenSettings(before), flattenSettings(after))
  const lines = changedLines(diff)
  const now = settingsSummary(after)
  if (lines.length === 0) {
    return {
      changed: [],
      now,
      note: "Already set that way, nothing changed. Tell the user it was already set, quoting `now`.",
    }
  }
  const locale = await userLocale(ctx)
  const phrases = Object.entries(diff.after)
    .map(([k, v]) => describeChange(locale, k, v))
    .filter((p): p is string => !!p)
  await announce(ctx, "notifications_set", diff, phrases, locale)
  return {
    changed: lines,
    now,
    note: "Saved. Tell the user what changed using `now` (the settings after this call), not your own words; they also got a feed item about it.",
  }
}

// ---------------------------------------------------------------------------
// notification_rules_set (per-app on/off and kinds)
// ---------------------------------------------------------------------------

export const notificationRulesSetParams = z
  .object({
    app: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/, "app name, lowercase (tickets, mail, projects, ...)")
      .describe("The app whose notifications this rule governs (tickets, mail, kernel, ...)"),
    enabled: z
      .boolean()
      .optional()
      .describe("false switches the app's notifications off EVERYWHERE, feed included"),
    everywhere: z
      .boolean()
      .optional()
      .describe(
        "Required with enabled:false or kinds: confirms the user wants this app silenced on every channel, the in-app feed included. For one channel (phone, desktop, email) use kernel__notifications_set instead.",
      ),
    kinds: z
      .array(z.string().min(1).max(128))
      .max(64)
      .optional()
      .describe("Only these kinds reach the user; omit for all kinds"),
    remove: z
      .boolean()
      .optional()
      .describe("true drops the rule: the app is back to default (all on)"),
  })
  .strict()

type RuleView = { enabled: boolean; kinds: string } | null

function ruleView(row: { enabled: boolean; kinds: string[] } | undefined): RuleView {
  if (!row) return null
  const all = row.kinds.length === 0 || row.kinds.includes("*")
  return { enabled: row.enabled, kinds: all ? "all" : row.kinds.join(",") }
}

export async function handleNotificationRulesSet(
  params: z.infer<typeof notificationRulesSetParams>,
  ctx: NotificationToolContext,
) {
  const refusal = refuseOutsideInteractiveTurn(ctx)
  if (refusal) return refusal
  if (params.remove !== true && params.enabled === undefined && params.kinds === undefined) {
    return { error: { code: "E_NOTHING_TO_CHANGE", message: "Pass enabled, kinds or remove." } }
  }
  // A per-app rule silences the app on every channel, the feed included. "Not on my phone" is a
  // grid cell (notifications_set), and a model reaching for the app rule instead removed tickets
  // from the feed on a live server (2026-09-28). Silencing is refused unless confirmed.
  if (
    params.remove !== true &&
    (params.enabled === false || params.kinds !== undefined) &&
    params.everywhere !== true
  ) {
    return {
      error: {
        code: "E_USE_CHANNEL_SETTING",
        message:
          "This rule silences the app everywhere, the in-app feed included. To stop one channel (phone, computer or email) use kernel__notifications_set with the group and channel. Only if the user asked to stop this app entirely, call again with everywhere: true.",
      },
    }
  }
  const where = and(
    eq(attentionSubscriptions.userId, ctx.userId),
    eq(attentionSubscriptions.source, params.app),
  )
  const [existing] = await ctx.db
    .select({ enabled: attentionSubscriptions.enabled, kinds: attentionSubscriptions.kinds })
    .from(attentionSubscriptions)
    .where(where)
    .for("update")
  const beforeRule = ruleView(existing)

  if (params.remove === true) {
    if (existing) await ctx.db.delete(attentionSubscriptions).where(where)
  } else {
    const kinds = params.kinds ?? existing?.kinds ?? ["*"]
    const enabled = params.enabled ?? existing?.enabled ?? true
    await ctx.db
      .insert(attentionSubscriptions)
      .values({ userId: ctx.userId, source: params.app, kinds, filters: {}, enabled })
      .onConflictDoUpdate({
        target: [attentionSubscriptions.userId, attentionSubscriptions.source],
        set: { kinds, enabled, updatedAt: new Date() },
      })
  }
  const [row] = await ctx.db
    .select({ enabled: attentionSubscriptions.enabled, kinds: attentionSubscriptions.kinds })
    .from(attentionSubscriptions)
    .where(where)
  const afterRule = ruleView(row)
  const show = (r: RuleView) => (r ? `${r.enabled ? "on" : "off"} (${r.kinds})` : "default")
  if (show(beforeRule) === show(afterRule)) {
    return { changed: [], note: "Already set that way, nothing changed." }
  }
  const key = `rule.${params.app}`
  const diff: SettingsDiff = {
    before: { [key]: beforeRule ? show(beforeRule) : null },
    after: { [key]: afterRule ? show(afterRule) : null },
  }
  const locale = await userLocale(ctx)
  const t = (k: string, p: Record<string, string>) =>
    serverT(locale, `kernel.agentNotificationChange.${k}`, p)
  const phrase = !afterRule
    ? t("appRuleRemoved", { app: params.app })
    : afterRule.enabled && afterRule.kinds !== "all"
      ? t("appRuleKinds", { app: params.app, value: afterRule.kinds })
      : t("appRule", {
          app: params.app,
          value: serverT(
            locale,
            `kernel.agentNotificationChange.${afterRule.enabled ? "on" : "off"}`,
          ),
        })
  await announce(ctx, "notification_rules_set", diff, [phrase], locale)
  return {
    changed: [`${params.app}: ${show(beforeRule)} -> ${show(afterRule)}`],
    note: "Saved. A rule silences the app everywhere, in-app included; mentions and system alerts still come through.",
  }
}

// ---------------------------------------------------------------------------
// thread_mute_set
// ---------------------------------------------------------------------------

export const threadMuteSetParams = z
  .object({
    threadId: z.string().uuid(),
    muted: z.boolean(),
  })
  .strict()

export async function handleThreadMuteSet(
  params: z.infer<typeof threadMuteSetParams>,
  ctx: NotificationToolContext,
) {
  const refusal = refuseOutsideInteractiveTurn(ctx)
  if (refusal) return refusal
  const [current] = await ctx.db
    .select({ isMuted: userThreadState.isMuted })
    .from(userThreadState)
    .where(
      and(eq(userThreadState.userId, ctx.userId), eq(userThreadState.threadId, params.threadId)),
    )
  const wasMuted = current?.isMuted ?? false
  const ok = await updateThreadState(ctx.db, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    threadId: params.threadId,
    isMuted: params.muted,
  })
  if (!ok) {
    return {
      error: {
        code: "E_NOT_A_PARTICIPANT",
        message: "The user is not in that conversation, so it cannot be muted for them.",
      },
    }
  }
  if (wasMuted === params.muted) {
    return { changed: [], note: `Already ${params.muted ? "muted" : "unmuted"}.` }
  }
  const key = `thread.${params.threadId}.muted`
  const diff: SettingsDiff = { before: { [key]: wasMuted }, after: { [key]: params.muted } }
  const locale = await userLocale(ctx)
  const phrase = serverT(
    locale,
    `kernel.agentNotificationChange.${params.muted ? "threadMuted" : "threadUnmuted"}`,
  )
  await announce(ctx, "thread_mute_set", diff, [phrase], locale)
  // The user's other devices apply the new flag live, like a mute from the UI
  // (threads PATCH /state). The handler runs inside the tool pipeline's
  // transaction, so the frame goes through the outbox: delivered after the
  // commit, never for a rolled-back mute.
  if (ok.state) {
    await queueReadState(ctx.db, ctx.orgId, ctx.userId, {
      kind: "thread_state",
      threadId: params.threadId,
      ...ok.state,
    })
  }
  return {
    changed: [`thread ${params.muted ? "muted" : "unmuted"}`],
    note: params.muted
      ? "Replies in that conversation no longer notify; a direct @mention still does."
      : "Replies in that conversation notify again.",
  }
}
