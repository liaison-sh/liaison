// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * APPROVAL WORDS IN THE READER'S LANGUAGE.
 *
 * An approval is written once, at request time, by the server, in English:
 * the action badge ("Kpi: kpi propose edit"), the row title ("Stalled:
 * Remediation: delete rgpd customer", "Edit role \"support\" (-1 scope)") and
 * the summarizer's lines ("REVOKE these scopes from the role:"). A French
 * reviewer read all of it in English on Home (second French walk,
 * 2026-09-23).
 *
 * Where the data allows it the words are rebuilt from STRUCTURE: the gated
 * tool id names the action (`kernel.approvalActions.<app>.<tool>`), the feed
 * says how the title was made (`titleKind`, `titleDetail`, `baseTitle`) and
 * whether the row is stalled. What is stored only as English prose (a
 * summarizer's own title and lines, from rows already in the database) is
 * matched against the known server templates and translated at display time;
 * anything else is data and is shown as written.
 *
 * English readers keep the server's own words byte for byte, except a time
 * the server wrote in UTC, which every reader gets in their own time zone.
 */
import { englishDictionaries, REF_FILLED_LATER, REF_OUTPUT_WORDS } from "@liaison/shared"
import { formatDateTime } from "~/lib/relative-time"
import type { Translate } from "~/modules/i18n/i18n-context"

export interface ApprovalCopyContext {
  t: Translate
  locale: string
}

function catalogHas(path: string[]): boolean {
  let node: unknown = englishDictionaries().kernel
  for (const part of path) {
    if (!node || typeof node !== "object") return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === "string"
}

function splitTool(toolName: string): { app: string; tool: string } {
  const idx = toolName.indexOf(":")
  return idx === -1
    ? { app: toolName, tool: "" }
    : { app: toolName.slice(0, idx), tool: toolName.slice(idx + 1).replace(/\./g, "_") }
}

export function appName(app: string, t: Translate): string {
  if (catalogHas(["capabilities", "apps", app])) return t(`kernel.capabilities.apps.${app}`)
  return app
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/**
 * A server label written before the kernel's actions were named after the
 * workspace ("Kernel: edit role") reads with the catalog's app name instead.
 */
function withAppDisplayName(
  toolName: string,
  serverLabel: string | null,
  t: Translate,
): string | null {
  if (!serverLabel) return serverLabel
  const { app } = splitTool(toolName)
  if (app !== "kernel" || !serverLabel.startsWith("Kernel: ")) return serverLabel
  return `${appName(app, t)}: ${serverLabel.slice("Kernel: ".length)}`
}

/** The action's own words ("proposer une modification"), or null when unknown. */
function actionPhrase(toolName: string, t: Translate): string | null {
  const { app, tool } = splitTool(toolName)
  if (!tool || !catalogHas(["approvalActions", app, tool])) return null
  return t(`kernel.approvalActions.${app}.${tool}`)
}

/**
 * The action badge: "<App> : <action>" ("KPI : proposer une modification").
 * An English reader, and a tool the catalog does not know, keep the server's
 * label.
 */
export function approvalActionLabel(
  toolName: string | null | undefined,
  serverLabel: string | null,
  ctx: ApprovalCopyContext,
): string | null {
  if (!toolName) return serverLabel
  if (ctx.locale === "en") return withAppDisplayName(toolName, serverLabel, ctx.t)
  const phrase = actionPhrase(toolName, ctx.t)
  if (!phrase) return serverLabel
  return `${appName(splitTool(toolName).app, ctx.t)}${ctx.t("kernel.capabilities.separator")}${phrase}`
}

/**
 * The card header's kind label: "<App>: <action>" ("Tickets : répondre") in
 * the reader's language, from the catalog in EVERY locale (the card has no
 * server label to fall back to, only the raw summary kind). A tool the
 * catalog does not know gets the humanized tool id, never the raw kind.
 */
export function approvalKindLabel(
  toolName: string | null | undefined,
  rawKind: string | null | undefined,
  ctx: ApprovalCopyContext,
): string {
  if (!toolName) return rawKind ?? ""
  const { app, tool } = splitTool(toolName)
  const phrase = actionPhrase(toolName, ctx.t)
  const action = phrase ?? tool.split(/_+/).filter(Boolean).join(" ")
  return action
    ? `${appName(app, ctx.t)}${ctx.t("kernel.capabilities.separator")}${action}`
    : appName(app, ctx.t)
}

/**
 * The deciding scope as a person reads it: "invoicing:approve" -> "needs Invoicing approval"
 * ("requiert l'approbation Facturation"). The raw scope stays on the chip's tooltip.
 */
export function approvalScopeLabel(scope: string, ctx: ApprovalCopyContext): string {
  const parts = scope.split(":").filter(Boolean)
  const app = appName(parts[0] ?? scope, ctx.t)
  return parts[parts.length - 1] === "approve"
    ? ctx.t("kernel.approvalsUi.needsAppApproval", { app })
    : ctx.t("kernel.approvalsUi.needsAppPermission", { app })
}

const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export interface ApprovalTitleSource {
  summary: string
  metadata?: Record<string, unknown> | null
}

/** The row title an approval item carries, in the reader's language. */
export function approvalRowTitle(item: ApprovalTitleSource, ctx: ApprovalCopyContext): string {
  const md = item.metadata ?? {}
  const wedged = md.wedged === true
  // A bundle head is named after its outcome step (attention.ts).
  const named = typeof md.outcomeToolName === "string" ? md.outcomeToolName : md.toolName
  const toolName = typeof named === "string" ? named : null
  let base =
    typeof md.baseTitle === "string" && md.baseTitle.length > 0 ? md.baseTitle : item.summary
  // An older cached item has no baseTitle: the prefix is on the summary.
  if (wedged && base === item.summary && base.startsWith("Stalled: ")) {
    base = base.slice("Stalled: ".length)
  }
  if (ctx.locale === "en") return wedged ? `Stalled: ${base}` : base

  let title = base
  const detail = typeof md.titleDetail === "string" ? md.titleDetail : null
  const phrase = toolName ? actionPhrase(toolName, ctx.t) : null
  if (md.titleKind === "action" && toolName) {
    title =
      approvalActionLabel(
        toolName,
        typeof md.actionLabel === "string" ? md.actionLabel : base,
        ctx,
      ) ?? base
  } else if (md.titleKind === "derived" && detail && phrase) {
    title = `${sentence(phrase)}${ctx.t("kernel.capabilities.separator")}${detail}`
  } else {
    title = localizeApprovalText(base, ctx)
  }
  return wedged ? ctx.t("kernel.approvalsUi.stalledTitle", { title }) : title
}

type Template = { re: RegExp; key: string; names: string[] }

const T = (re: RegExp, key: string, ...names: string[]): Template => ({
  re,
  key: `kernel.approvalsUi.tpl.${key}`,
  names,
})

/** The server's English templates (summarizers, admin tools), newest first. */
const TEMPLATES: Template[] = [
  // coordination-tools.ts summarizeAgentsInvite: an agent asking to add another one.
  T(/^(.+) wants to add (.+) to this discussion$/, "agentWantsToAdd", "caller", "agent"),
  T(/^Edit role "(.+)" \((.+)\)$/, "editRole", "name", "changes"),
  // files/attach.ts: a file an earlier step of a sequence makes, pending until it runs.
  T(/^📎 (.+) \(attached once that step has run\)$/, "attachedAfterStep", "file"),
  T(/^Delete role "(.+)"$/, "deleteRole", "name"),
  T(/^Invite (\S+) as (.+)$/, "inviteAs", "email", "role"),
  T(/^Assign (\S+) to (.+)$/, "assignTo", "email", "role"),
  T(/^Remove (\S+) from (.+)$/, "removeFrom", "email", "role"),
  T(/^Create skill (.+)$/, "createSkill", "name"),
  T(/^Delete skill (.+)$/, "deleteSkill", "name"),
  T(/^Create routine (.+)$/, "createRoutine", "name"),
  T(/^Update routine (.+)$/, "updateRoutine", "name"),
  T(/^Delete routine (.+)$/, "deleteRoutine", "name"),
  T(/^Run routine (.+) now$/, "runRoutine", "name"),
  T(/^Set auto-approve policy for (.+)$/, "autoApprovePolicy", "tool"),
  T(/^Tighten approval policy for (.+)$/, "tightenPolicy", "tool"),
  T(/^Merge contacts → keep (.+), delete (.+)$/, "mergeContacts", "survivor", "deleted"),
  T(/^Edit the contact (.+)$/, "editContact", "contact"),
  T(/^Create the contact (.+)$/, "createContact", "contact"),
  T(/^Connect external MCP server "(.+)" at (.+)$/, "connectMcp", "name", "url"),
  T(/^Delete: (.+)$/, "deleteTask", "title"),
  T(/^Merge "(.+)" into "(.+)"$/, "mergeTasks", "source", "target"),
  T(/^Create task: (.+)$/, "createTask", "title"),
  // The projects summarizer's lines (projects/summarizers.ts); its subtitle is
  // localizedApprovalSubtitle's, where a bare "In <project>" cannot be a description.
  T(/^Priority: (.+)$/, "priorityLine", "value"),
  T(/^Assignee: (.+)$/, "assigneeLine", "name"),
  T(/^Status: (.+)$/, "statusLine", "value"),
  T(/^Due: (.+)$/, "dueLine", "date"),
  T(/^\(no description\)$/, "noDescription"),
  T(/^Add status column: (.+)$/, "addStatusColumn", "label"),
  T(/^Reply to (.+) on (ticket-\S+)$/, "replyOn", "to", "handle"),
  T(/^Nudge (.+) on (ticket-\S+)$/, "nudgeOn", "to", "handle"),
  T(/^Add internal note on (.+)$/, "addNoteOn", "handle"),
  T(/^Edit internal note on (.+)$/, "editNoteOn", "handle"),
  T(/^Delete internal note on (.+)$/, "deleteNoteOn", "handle"),
  T(/^Close (ticket-\S+)$/, "closeTicket", "handle"),
  T(/^Reply to (.+) via (\S+)$/, "replyVia", "to", "account"),
  T(/^Forward to (.+) via (\S+)$/, "forwardVia", "to", "account"),
  T(/^Compose via (\S+)$/, "composeVia", "account"),
  // The ticket summarizers' current subtitles: the action + the customer, the
  // ticket id having moved to the card's `ref` chip. After every "... on
  // ticket-N" / "... via <account>" form above, which they would also match.
  T(/^Reply to (.+)$/, "replyTo", "to"),
  T(/^Nudge (?!stale ticket )(.+)$/, "nudgeTo", "to"),
  T(/^Close$/, "closeAction"),
  // The ticket summarizers' "Last message: <date>" line and "Open ticket" link.
  T(/^Last message: (.+)$/, "lastMessage", "when"),
  T(/^Open ticket$/, "openTicket"),
  T(/^Add internal note$/, "addNote"),
  T(/^Edit internal note$/, "editNote"),
  T(/^Delete internal note$/, "deleteNote"),
  T(/^REVOKE these scopes from the role:$/, "revokeScopes"),
  T(/^GRANT these scopes to the role:$/, "grantScopes"),
  T(
    /^Every current and future member of this role inherits the resulting scope set\.$/,
    "everyMemberInherits",
  ),
  T(/^Rename to "(.+)"\.$/, "renameTo", "name"),
  T(/^Set description: (.+)$/, "setDescription", "text"),
]

/** An instant with a time and a zone; a bare date is not one. */
const ISO_INSTANT =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})(?![\w:])/g

/** The ticket summarizers' "Last message: YYYY-MM-DD HH:MM" line, written in UTC. */
const LAST_MESSAGE_UTC = /^Last message: (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/

/** "rename, -1 scope" -> "renommage, -1 portée". Unknown parts stay as written. */
function localizeRoleChanges(changes: string, t: Translate): string {
  return changes
    .split(/,\s*/)
    .map((part) => {
      if (part === "rename") return t("kernel.approvalsUi.tpl.change.rename")
      if (part === "re-describe") return t("kernel.approvalsUi.tpl.change.redescribe")
      if (part === "no change") return t("kernel.approvalsUi.tpl.change.noChange")
      const m = /^([+-])(\d+) scopes?$/.exec(part)
      if (!m) return part
      const n = Number(m[2])
      const key = m[1] === "+" ? "add" : "remove"
      return n === 1
        ? t(`kernel.approvalsUi.tpl.change.${key}One`)
        : t(`kernel.approvalsUi.tpl.change.${key}Many`, { n })
    })
    .join(", ")
}

/** "the quote PDF from step 2" (refs.ts), and "[quote number from step 2]" as
 *  summaries stored before the bracket was dropped still carry. */
const REF_PHRASE = /\[([^\]]+?) from step (\d+)\]|\bthe ([^,.;:()[\]]+?) from step (\d+)\b/g
/** "the tracking number from an earlier step": a token whose step was not known. */
const REF_EARLIER = /\bthe ([^,.;:()[\]]+?) from an earlier step\b/g

/** The output key whose English words end `what` ("quote PDF" -> pdf_file_id). */
function refOutputKey(what: string): string | null {
  const lower = what.toLowerCase()
  let best: string | null = null
  let bestLen = 0
  for (const [key, words] of Object.entries(REF_OUTPUT_WORDS)) {
    const w = words.toLowerCase()
    if ((lower === w || lower.endsWith(` ${w}`)) && w.length > bestLen) {
      best = key
      bestLen = w.length
    }
  }
  return best
}

/**
 * The earlier-step phrases a sequenced step's text carries, in the reader's
 * language: "the quote PDF from step 2" -> "le PDF de l'étape 2". The output is
 * named from the catalog; an output it does not know keeps its words, quoted.
 * English readers get the text as written.
 */
export function localizeRefPhrases(text: string, ctx: ApprovalCopyContext): string {
  if (ctx.locale === "en") return text
  const outputWords = (what: string) => {
    const key = refOutputKey(what)
    return key && catalogHas(["approvalsUi", "refOutput", key])
      ? ctx.t(`kernel.approvalsUi.refOutput.${key}`)
      : `« ${what} »`
  }
  const out = text
    .replace(REF_EARLIER, (_m, what: string) =>
      ctx.t("kernel.approvalsUi.refFromEarlierStep", { what: outputWords(what.trim()) }),
    )
    .split(REF_FILLED_LATER)
    .join(ctx.t("kernel.approvalsUi.refFilledLater"))
  if (!out.includes(" from step ")) return out
  return out.replace(
    REF_PHRASE,
    (_m, inWhat?: string, inStep?: string, wholeWhat?: string, wholeStep?: string) => {
      const phrase = ctx.t("kernel.approvalsUi.refFromStep", {
        what: outputWords((inWhat ?? wholeWhat ?? "").trim()),
        n: inStep ?? wholeStep ?? "",
      })
      return inWhat !== undefined ? `[${phrase}]` : phrase
    },
  )
}

/**
 * One stored English line or title, in the reader's language when it is one
 * of the server's known templates; any other text is data and comes back as
 * written. An English reader gets the text as written, its UTC times aside.
 */
export function localizeApprovalText(raw: string, ctx: ApprovalCopyContext): string {
  if (!raw) return raw
  // Any instant written as ISO-8601 ("Starts: 2026-10-22T12:44:50.603Z")
  // reads as a date and time in the reader's zone and language.
  const text = raw.replace(ISO_INSTANT, (iso) => formatDateTime(iso, ctx.locale) || iso)
  // A time the server wrote is an instant in UTC; every reader, English
  // included, reads it in their own zone, as the rest of the UI shows times.
  const lastMessage = LAST_MESSAGE_UTC.exec(text)
  if (lastMessage) {
    const when = formatDateTime(`${lastMessage[1]}T${lastMessage[2]}:00Z`, ctx.locale)
    if (when) return ctx.t("kernel.approvalsUi.tpl.lastMessage", { when })
  }
  if (ctx.locale === "en") return text
  const out = localizeTemplate(text, ctx)
  return localizeRefPhrases(out, ctx)
}

/** A known server template in the reader's language; any other text as written. */
function localizeTemplate(text: string, ctx: ApprovalCopyContext): string {
  for (const tpl of TEMPLATES) {
    const m = tpl.re.exec(text)
    if (!m) continue
    const params: Record<string, string> = {}
    tpl.names.forEach((name, i) => {
      params[name] = m[i + 1] ?? ""
    })
    if (tpl.key.endsWith(".editRole") && params.changes) {
      params.changes = localizeRoleChanges(params.changes, ctx.t)
    }
    // A priority the projects catalog names ("high" -> "Haute"); any other value as written.
    if (tpl.key.endsWith(".priorityLine") && params.value) {
      const key = `projects.priorityLevel.${params.value}`
      const named = ctx.t(key)
      if (named !== key) params.value = named.toLowerCase()
    }
    return ctx.t(tpl.key, params)
  }
  return text
}
