// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison approval-reminders run` -- remind one member now of their own
 * requests that have waited longer than their reminder interval (a day unless
 * they chose every 3 days or weekly; modules/approvals/reminders.ts),
 * instead of waiting for the hourly sweep. An operator command: it runs inside
 * the server's container, with the server's database.
 *
 *   liaison approval-reminders run --user <member email|uuid> [--org <slug>] [--force]
 *
 * It posts the reminder line in the member's conversation with their agent and
 * enqueues the agent's turn for the server's workers (this process never hosts
 * jobs). Without a qualifying request it does nothing, and a member who turned
 * approval reminders off gets nothing either. `--force` skips the once-per-
 * interval check and the member's "off", never the qualifying-request one.
 *
 * STDOUT carries the JSON report, STDERR the human summary.
 */
import { and, eq } from "drizzle-orm"
import { resolveMember } from "~/cli/lib/resolve-member"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import {
  type RemindResult,
  remindUserOfWaitingApprovals,
  type StartReminderTurn,
  startReminderTurnOnServer,
} from "~/modules/approvals/reminders"

export const APPROVAL_REMINDERS_USAGE =
  "usage: liaison approval-reminders run --user <member email|uuid> [--org <slug>] [--force]"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

async function resolveReminderMember(
  orgSlug: string | undefined,
  user: string,
): Promise<{ orgId: string; userId: string } | string> {
  if (!UUID.test(user)) return resolveMember(orgSlug, user)
  const org = await resolveOrgId(orgSlug, "more than one org exists: pass --org <slug>")
  if (!org.ok) return org.message
  const [row] = await withSystemDb("cli-approval-reminders-user", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, org.orgId), eq(users.id, user), eq(users.status, "active")))
      .limit(1),
  )
  return row ? { orgId: org.orgId, userId: row.id } : `no active member '${user}' in this org`
}

export async function runApprovalRemindersCli(
  argv: string[],
  deps: { startTurn?: StartReminderTurn } = {},
): Promise<{ exitCode: number; report: unknown; message?: string }> {
  const user = arg("--user", argv)
  if (!user) {
    return { exitCode: 2, report: { error: "missing --user" }, message: APPROVAL_REMINDERS_USAGE }
  }
  const member = await resolveReminderMember(arg("--org", argv), user)
  if (typeof member === "string") return { exitCode: 2, report: { error: member }, message: member }
  const res: RemindResult = await remindUserOfWaitingApprovals({
    ...member,
    force: argv.includes("--force"),
    // The CLI hosts no job worker: the turn is handed to the server's.
    startTurn: deps.startTurn ?? startReminderTurnOnServer,
  })
  const message =
    res.status === "sent"
      ? `Reminder posted (${res.count} waiting request(s)); the agent's turn is queued.`
      : res.status === "throttled"
        ? "Not sent: this member was already reminded within their reminder interval (pass --force to send anyway)."
        : res.status === "off"
          ? "Not sent: this member turned approval reminders off (pass --force to send anyway)."
          : res.status === "inactive"
            ? "Not sent: the member is not active."
            : "Not sent: no request of theirs has waited longer than their reminder interval."
  return { exitCode: 0, report: { ...member, ...res }, message }
}
