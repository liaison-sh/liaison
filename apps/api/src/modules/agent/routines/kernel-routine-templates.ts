// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine templates the kernel itself ships (S28, A37), next to the ones apps
// declare in their manifests. They live in the same routineTemplateRegistry
// under the app name "kernel", are registered with every org's kernel tools
// (so a new org has them as soon as its runtime starts), and instantiate as
// routines with source_kind 'kernel' and no app_name.
import { routineTemplateRegistry } from "~/modules/apps/app-registries"

/** The registry's app slot for kernel templates. No app is ever named "kernel". */
export const KERNEL_TEMPLATE_APP = "kernel"

export const MORNING_BRIEF_TEMPLATE_KEY = "morning-brief"

/**
 * Template keys of routines an app's own job acts through (an "app-run"
 * routine): an inbox option that nudges and closes silent tickets, say. Such a
 * routine has no agent and no tick: it exists so that what the job does is
 * attributed to "Routine {name}" (approval cards, messages, audit) while it
 * runs as its owner, under the owner's permissions. It is always disabled, is
 * never ticked, and cannot be edited: the app's setting is what switches it.
 */
export const APP_RUN_TEMPLATE_PREFIX = "app-run:"

export function isAppRunRoutine(templateKey: string | null | undefined): boolean {
  return typeof templateKey === "string" && templateKey.startsWith(APP_RUN_TEMPLATE_PREFIX)
}

/** "HH:MM" on a 24-hour clock. */
export const TEMPLATE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Put a chosen "HH:MM" into a 5-field cron's minute and hour, keeping its day
 * fields ("0 8 * * 1-5" at "07:30" is "30 7 * * 1-5"). Null when either is
 * malformed.
 */
export function cronAtTime(cron: string, time: string): string | null {
  const m = TEMPLATE_TIME_PATTERN.exec(time)
  const fields = cron.trim().split(/\s+/)
  if (!m || fields.length !== 5) return null
  return [String(Number(m[2])), String(Number(m[1])), ...fields.slice(2)].join(" ")
}

/** The "HH:MM" a plain `M H ...` cron fires at, or null for anything fancier. */
export function timeOfCron(cron: string | null | undefined): string | null {
  const [min, hour] = (cron ?? "").trim().split(/\s+/)
  if (!min || !hour || !/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null
  return `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`
}

/**
 * The Morning brief (S28, F1, F7): every weekday at the owner's chosen time, in
 * the owner's timezone, a short brief in the owner's own routine thread, and a
 * push through kernel__notify_user (a routine thread routes to `replies`, where
 * push is off by default, so the post alone would not reach the phone).
 */
const MORNING_BRIEF_PROMPT = [
  "Write my morning brief. Keep it short: three headed sections, at most 8 bullets in all, in my language.",
  "",
  "1. Overnight mail: the new mail in my mailboxes since yesterday 18:00 (mail search). One line per conversation that needs me: who, what, and what they expect. Skip newsletters and notifications.",
  "2. Waiting for my approval: the drafts and other actions waiting for me (kernel__approvals_list). One line each: what it is and for whom.",
  "3. Due: my tasks due today or overdue (projects tasks_byAssignee for me). One line each.",
  "",
  "A section with nothing in it says so in one line. Do not invent anything: only what the tools returned.",
  "Post the brief as your reply here. Then call kernel__notify_user exactly once with a one-line summary of the counts (for example: 3 new emails, 2 drafts to approve, 1 task due), so I get it on my phone.",
].join("\n")

export function registerKernelRoutineTemplates(orgId: string): void {
  routineTemplateRegistry.set([orgId, KERNEL_TEMPLATE_APP, MORNING_BRIEF_TEMPLATE_KEY], {
    description:
      "Morning brief: overnight mail, drafts waiting for your approval and tasks due, every weekday morning.",
    kind: "recurring",
    cron: "0 8 * * 1-5",
    // No timezone: the owner's own applies.
    promptTemplate: MORNING_BRIEF_PROMPT,
    scopes: [
      "mail:conversations:read",
      "kernel:approvals:read",
      "projects:tasks:read",
      // kernel__notify_user.
      "kernel:agent:memory",
    ],
    enabledByDefault: false,
    visibility: "personal",
    sourceKind: "kernel",
  })
}
