// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel:report_bug`: the web form's "Report a bug", for an agent or an MCP
// client (Claude desktop, Claude Code) acting for its signed-in user. The
// report goes through `fileBugReport`, so it lands in the Bug Reports inbox in
// the same layout and attributed to that user, exactly like the form.
//
// When the operator sends bug reports only to the Liaison team (team-only,
// operator org), the tool sends NOTHING itself: it prepares the exact payload
// and the reporter confirms it on a card (agent-drafts.ts). A turn no person
// started (a routine, a schedule, an agent-to-agent ask, an MCP connection that
// proves no person) is refused there: the form is the way.
//
// Who may call it: every member, as every member may use the form (the REST
// route asks for no scope). Its scope, `kernel:bug_reports:file`, is one every
// active member holds whatever their roles, and an agent acting for them keeps
// it whatever its ceiling (every-member-scopes.ts).
//
// Never an approval: filing into the org's own Bug Reports inbox is an internal
// action, so neither the scope taint (`taintUnjudgedWrite`) nor the outside-text
// hold (no `externalEffect`) parks it, whatever the turn read. The one case
// where data leaves the org, team-only, already waits for the reporter's own
// click on the exact payload: that click is the consent, not an approval.
//
// A call held for approval by an older build ends in the same card when
// approved: approving it prepares the draft, and only the reporter's click
// sends it. A held call that can no longer run (a routine's, once reports go
// only to the Liaison team) is refused as final, so its approval closes instead
// of returning to pending.
import { z } from "zod"
import { currentRunContext, runHasPerson } from "~/modules/agent/runtime/run-context"
import { toolRegistry } from "~/modules/apps/app-registries"
import { AgentDraftError, createAgentDraft } from "~/modules/bug-reports/agent-drafts"
import {
  approvalOriginHadPerson,
  fileBugReport,
  reporterEmailOf,
  serverSnapshotFor,
} from "~/modules/bug-reports/service"
import { isBugReportTeamOnlyFor } from "~/modules/liaison-team/bug-report-payload"

export const reportBugParams = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("One line naming the problem. It becomes the report's subject."),
  description: z
    .string()
    .trim()
    .min(1)
    .max(15_000)
    .describe(
      "What happened, what was expected, and the steps to reproduce, in the user's own words where possible.",
    ),
  page: z
    .string()
    .trim()
    .max(2_000)
    .optional()
    .describe("The Liaison page or screen concerned (a URL or a name such as 'Mail inbox')."),
  context: z
    .string()
    .trim()
    .max(4_000)
    .optional()
    .describe(
      "Anything else useful: the tool call that failed and its error, the ids involved (ticket-123, request-45).",
    ),
})

export type ReportBugParams = z.infer<typeof reportBugParams>

interface ReportBugContext {
  orgId: string
  userId: string
  actorType: "user" | "agent" | "mcp"
  /** Set when this run is the approved execution of a held call. */
  approvalRequestId?: string
  /** The routine a held call came from, when it came from one. */
  originRoutineId?: string
}

const VIA: Record<ReportBugContext["actorType"], string> = {
  user: "Liaison agent tool",
  agent: "Liaison agent",
  mcp: "MCP client (for example Claude)",
}

/** The ticket the report became (local inbox). */
export interface ReportBugFiled {
  filed: true
  ticketId: string
  ticketHandle: string | null
  message: string
}

/** Team-only: prepared, waiting for the reporter's click on its card. */
export interface ReportBugAwaitingConfirmation {
  filed: false
  teamOnly: true
  awaitingConfirmation: true
  draftId: string
  digest: string
  /**
   * What the conversation keeps. Never the payload itself: it carries the
   * reporter's email and the server's error signatures, and the conversation
   * may be shared. The card fetches it for the reporter alone
   * (GET /api/bug-reports/drafts/:id).
   */
  summary: { title: string; descriptionChars: number; payloadBytes: number }
  message: string
}

export interface ReportBugRefused {
  error: {
    code: "REPORTER_CONFIRMATION_REQUIRED" | "DRAFT_LIMIT_REACHED"
    message: string
    /** No approval of the same call can pass: a held one is closed, not re-pended. */
    final?: true
  }
}

export type ReportBugResult = ReportBugFiled | ReportBugAwaitingConfirmation | ReportBugRefused

/**
 * A person asked for this call and can click its card: a turn they typed in
 * Liaison, the desktop's local turn answering their message (gateway turn
 * credential), or an MCP client of theirs with no agent bound (no turn frame:
 * the person's own connection). Never a routine tick, a background or
 * coordinated turn, or an agent-bound MCP call that proves no person.
 */
export function hasHumanRequester(actorType: ReportBugContext["actorType"]): boolean {
  const frame = currentRunContext()
  if (!frame) return actorType === "mcp"
  return runHasPerson(frame)
}

const NOT_SENT_NO_PERSON =
  "NOT SENT: bug reports on this server go only to the Liaison team, and only the person reporting can send one, from a conversation they are in. Nothing was sent or filed. Tell the user to use the Report a bug form in Liaison."

/** The refusal of a turn no person started, also answered before any approval gate. */
function noPersonRefusal(): ReportBugRefused {
  return {
    error: { code: "REPORTER_CONFIRMATION_REQUIRED", message: NOT_SENT_NO_PERSON, final: true },
  }
}

/**
 * Whether this run has a person who can click the card. The approved execution
 * of a held call has one only if the turn that held it did: a routine, a
 * background or coordinated turn, or an agent-bound MCP call that proves no
 * person left none to click, so the approval closes (`final`) instead of
 * preparing a card nobody is looking at. `refuseBeforeGate` answers such a
 * turn first once reports go only to the Liaison team; this covers a call
 * held before that was switched on.
 */
async function reporterCanConfirm(ctx: ReportBugContext): Promise<boolean> {
  if (ctx.approvalRequestId) {
    return !ctx.originRoutineId && (await approvalOriginHadPerson(ctx.orgId, ctx.approvalRequestId))
  }
  return hasHumanRequester(ctx.actorType)
}

const AWAITING_CONFIRMATION =
  "NOT SENT YET. On this server bug reports go only to the Liaison team (no local ticket). The report is prepared with the user's email, and the user must check the exact report on its card and click Send there (under this call in Liaison, or in Report a bug when asked from another app). Nothing goes out until they do. Tell the user that; never say it was sent."

export async function handleReportBug(
  params: ReportBugParams,
  ctx: ReportBugContext,
): Promise<ReportBugResult> {
  const sections = [params.title, params.description]
  if (params.context) sections.push(`Additional context:\n${params.context}`)
  const form = {
    description: sections.join("\n\n"),
    context: {
      ...(params.page ? { url: params.page } : {}),
      userAgent: `Filed through: ${VIA[ctx.actorType] ?? VIA.agent}`,
    },
  }
  if (await isBugReportTeamOnlyFor(ctx.orgId)) {
    if (!(await reporterCanConfirm(ctx))) return noPersonRefusal()
    let draft: Awaited<ReturnType<typeof createAgentDraft>>
    try {
      draft = await createAgentDraft(ctx.orgId, ctx.userId, {
        form,
        snapshot: await serverSnapshotFor(ctx.orgId),
        reporterEmail: await reporterEmailOf(ctx.orgId, ctx.userId),
      })
    } catch (err) {
      if (err instanceof AgentDraftError && err.code === "DRAFT_LIMIT_REACHED") {
        return {
          error: { code: err.code, message: `NOT SENT: ${err.message}. Nothing was prepared.` },
        }
      }
      throw err
    }
    return {
      filed: false,
      teamOnly: true,
      awaitingConfirmation: true,
      draftId: draft.draftId,
      digest: draft.digest,
      summary: {
        title: params.title,
        descriptionChars: form.description.length,
        payloadBytes: Buffer.byteLength(JSON.stringify(draft.data)),
      },
      message: AWAITING_CONFIRMATION,
    }
  }
  const filed = await fileBugReport(ctx.orgId, ctx.userId, form)
  if (!filed.ticketId) {
    // Team-only went on between the check above and the filing: nothing was filed.
    return {
      error: {
        code: "REPORTER_CONFIRMATION_REQUIRED",
        message:
          "NOT SENT: bug reports on this server now go only to the Liaison team. Nothing was filed. Call report_bug again so the user can confirm the report.",
        final: true,
      },
    }
  }
  return {
    filed: true,
    ticketId: filed.ticketId,
    ticketHandle: filed.ticketHandle ?? null,
    message: `Bug report filed${filed.ticketHandle ? ` as ${filed.ticketHandle}` : ""} in the Bug Reports inbox, under the user's name.`,
  }
}

/**
 * Before any gate: team-only, a call from a turn no person started is refused
 * here, so it never waits in an approval nobody could turn into a sent report.
 * A call with no turn frame (a person's own MCP client, a direct call) goes on
 * to the handler, which judges it with its actor type.
 */
export async function refuseReportBugBeforeGate(
  _params: unknown,
  ctx: { orgId: string },
): Promise<ReportBugRefused | null> {
  if (!currentRunContext()) return null
  if (hasHumanRequester("agent")) return null
  return (await isBugReportTeamOnlyFor(ctx.orgId)) ? noPersonRefusal() : null
}

export function registerReportBugTool(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "report_bug"], {
    appName: "kernel",
    name: "report_bug",
    deferLoading: true,
    description:
      "File a bug report about Liaison itself (something broken, wrong or confusing in the product) for the signed-in user, exactly like the app's Report a bug form: it lands in the Bug Reports inbox under the user's name. Where the server sends bug reports only to the Liaison team, it prepares the report for the Liaison team instead, and the user sends it with one click after checking it. Use when the user asks to report or file a Liaison bug, or asks for a change to a skill or toolkit. Not for a customer's problem with the org's own products: that is a ticket.",
    searchKeywords: ["bug", "signaler", "problème", "anomalie"],
    // Every active member holds it, as the web form is open to every member
    // (every-member-scopes.ts): most reporters hold no tickets scope at all.
    requiredScopes: ["kernel:bug_reports:file"],
    params: reportBugParams,
    handler: handleReportBug as unknown as (p: unknown, c: unknown) => Promise<unknown>,
    writesToTable: "app_tickets.tickets",
    // A bug report about Liaison never parks (see the header): the scope taint does not judge
    // it, and it declares no outward effect, so outside text read earlier in the turn does
    // not hold it either. Team-only, the reporter's click on the draft is what sends it.
    taintUnjudgedWrite: true,
    // Its answer is the report's own ticket or draft id, no org record: its
    // scope is not a read and never enters the turn's taint.
    taintFree: true,
    // Team-only, a turn no person started never parks an approval: nobody
    // could confirm what it would prepare.
    refuseBeforeGate: refuseReportBugBeforeGate,
  })
}
