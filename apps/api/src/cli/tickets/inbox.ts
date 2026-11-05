// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `tickets inbox <list|create|update|move>` -- manage tickets API inboxes from the CLI.
 *
 * An API inbox is a receiving bucket (bug reports, website contact, a per-tenant
 * endpoint) with no connected mailbox; replies go through a reply-via mailbox
 * (see loadInboxAndProvider). Runs privileged, no HTTP -- same seam the mailbox
 * provisioner uses (`runAdminOp(priv, orgId, 'inboxesCreate'|'ticketsMove', ...)`).
 *
 * `update` configures the per-inbox ("virtual mailbox") email identity: From
 * display name, reply-to base address, signature, acknowledgement on/off + body,
 * and the SLA promise phrase used in that acknowledgement -- the same fields the
 * Liaison web Settings > Tickets > Inboxes panel edits.
 *
 * I/O discipline (matches `config apply` / `tickets import`): the machine-readable
 * JSON report is written to STDOUT by the dispatcher; human/usage text is STDERR.
 *
 *   liaison tickets inbox list   [--org <slug>]
 *   liaison tickets inbox create --name <name> [--org <slug>] [--kind api]
 *                                [--reply-via <inboxId> | --reply-from <email>]
 *                                [--default-team <team>] [--mint-key]
 *                                [--reply-to <email>] [--from-name <name>]
 *                                [--signature-html <html>] [--signature-text <text>]
 *                                [--ack-enabled true|false] [--ack-body <text>]
 *                                [--sla-promise <phrase>]
 *   liaison tickets inbox update --id <inboxId> [--org <slug>]
 *                                [--reply-via <mailboxInboxId>]
 *                                [--from-name <name>] [--reply-to <email>]
 *                                [--signature-html <html>] [--signature-text <text>]
 *                                [--ack-enabled true|false] [--ack-body <text>]
 *                                [--sla-promise <phrase>]
 *                                [--attention-cutoff <iso>|now|none]
 *   liaison tickets inbox move   --ticket <id> --to-inbox <inboxId> [--org <slug>]
 */
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

export interface TicketsInboxResult {
  exitCode: number
  report: unknown
  message?: string
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function usage(message: string): TicketsInboxResult {
  return { exitCode: 2, report: { error: message }, message }
}

function ingestUrl(orgId: string, inboxId: string): string {
  return `${env.BASE_URL.replace(/\/$/, "")}/webhooks/${orgId}/inboxes/${inboxId}/tickets/create`
}

async function resolveActorUserId(orgId: string): Promise<string> {
  return withPrivilegedDb(orgId, "cli-inbox-actor", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${kernelRel("users")}
        WHERE org_id = ${orgId} AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`),
    )
    return rows[0]?.id ?? NIL_UUID
  })
}

const errCode = (r: unknown): string | undefined =>
  typeof r === "object" && r !== null && "error" in r
    ? ((r as { error?: { code?: string; message?: string } }).error?.code ?? "error")
    : undefined
const errMsg = (r: unknown): string | undefined =>
  typeof r === "object" && r !== null && "error" in r
    ? (r as { error?: { message?: string } }).error?.message
    : undefined

// Shared email-identity flags between `create` and `update`. Maps CLI flag
// name -> the admin-op param name; only present-on-argv flags are applied so
// `update` never clobbers an unrelated field back to null.
function emailIdentityParams(argv: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  // The send transport for an `api` inbox (which has no mail account of its
  // own). Settable on `update`, not just at creation: a receiving bucket is
  // routinely created BEFORE the mailbox that will carry its replies exists,
  // and until this flag there was no way to wire the two together afterwards.
  // Getting it wrong is silent — a missing route means the acknowledgement is
  // simply never sent, with nothing logged.
  const replyVia = arg("--reply-via", argv)
  if (replyVia !== undefined) params.replyViaInboxId = replyVia
  // b2b | b2c — the side this bucket serves, inherited by every ticket filed
  // through it. Settable on update too: a bucket usually predates the ruling.
  const defaultAudience = arg("--default-audience", argv)
  if (defaultAudience !== undefined) params.defaultAudience = defaultAudience
  const fromName = arg("--from-name", argv)
  if (fromName !== undefined) params.fromDisplayName = fromName
  const replyTo = arg("--reply-to", argv)
  if (replyTo !== undefined) params.replyToEmail = replyTo
  const sigHtml = arg("--signature-html", argv)
  if (sigHtml !== undefined) params.signatureHtml = sigHtml
  const sigText = arg("--signature-text", argv)
  if (sigText !== undefined) params.signatureText = sigText
  const ackEnabled = arg("--ack-enabled", argv)
  if (ackEnabled !== undefined) params.ackEnabled = ackEnabled !== "false"
  const ackBody = arg("--ack-body", argv)
  if (ackBody !== undefined) params.ackBodyText = ackBody
  const slaPromise = arg("--sla-promise", argv)
  if (slaPromise !== undefined) params.slaPromisePhrase = slaPromise
  // Attention cutoff: tickets whose activity predates it raise no automatic
  // attention items. Set after a historical import ("now"), clear with "none".
  const attentionCutoff = arg("--attention-cutoff", argv)
  if (attentionCutoff !== undefined) {
    params.attentionCutoffAt =
      attentionCutoff === "none"
        ? null
        : attentionCutoff === "now"
          ? new Date().toISOString()
          : attentionCutoff
  }
  return params
}

export async function runTicketsInbox(argv: string[]): Promise<TicketsInboxResult> {
  const sub = argv[0]
  if (!sub || !["list", "create", "update", "move"].includes(sub)) {
    return usage("usage: liaison tickets inbox <list|create|update|move> [flags]")
  }

  const resolved = await resolveOrgId(
    arg("--org", argv),
    "multiple orgs exist -- pass --org <slug>",
  )
  if (!resolved.ok)
    return { exitCode: 2, report: { error: resolved.message }, message: resolved.message }
  const orgId = resolved.orgId
  const actor = { actorType: "user" as const, userId: await resolveActorUserId(orgId) }

  if (sub === "list") {
    const list = (await withPrivilegedDb(orgId, "cli-inbox-list", (tx) =>
      runAdminOp(tx as never, orgId, "inboxesList", {}, actor),
    )) as Array<Record<string, unknown>>
    const inboxes = list.map((i) => ({
      id: i.id,
      kind: i.kind,
      name: i.name,
      emailAddress: i.email_address,
      replyViaInboxId: i.reply_via_inbox_id,
      replyFromEmail: i.reply_from_email,
      replyToEmail: i.reply_to_email,
      fromDisplayName: i.from_display_name,
      signatureHtml: i.signature_html,
      signatureText: i.signature_text,
      ackEnabled: i.ack_enabled,
      ackBodyText: i.ack_body_text,
      slaPromisePhrase: i.sla_promise_phrase,
      suppressAttention: i.suppress_attention,
      attentionCutoffAt: i.attention_cutoff_at,
      isDefaultForCreate: i.is_default_for_create,
      archivedAt: i.archived_at,
      ingestUrl: i.kind === "api" ? ingestUrl(orgId, String(i.id)) : null,
    }))
    return { exitCode: 0, report: { inboxes } }
  }

  if (sub === "create") {
    const name = arg("--name", argv)
    if (!name) return usage("create requires --name <name>")
    const kind = arg("--kind", argv) ?? "api"
    if (kind !== "api") {
      // A mailbox-backed inbox binds to a tickets-owned mail connection, which
      // only the connect flow or config apply creates.
      return usage(
        "create only makes API inboxes (--kind api). A mailbox inbox comes from " +
          "'liaison connect tickets/gmail' or tickets.inboxes in 'liaison config apply'",
      )
    }
    const params: Record<string, unknown> = { kind, name, ...emailIdentityParams(argv) }
    const replyVia = arg("--reply-via", argv)
    if (replyVia) params.replyViaInboxId = replyVia
    const replyFrom = arg("--reply-from", argv)
    if (replyFrom) params.replyFromEmail = replyFrom
    const defaultTeam = arg("--default-team", argv)
    if (defaultTeam) params.defaultTeam = defaultTeam
    const defaultAudience = arg("--default-audience", argv)
    if (defaultAudience) params.defaultAudience = defaultAudience

    const created = (await withPrivilegedDb(orgId, "cli-inbox-create", (tx) =>
      runAdminOp(tx as never, orgId, "inboxesCreate", params, actor),
    )) as Record<string, unknown>
    if (errCode(created)) {
      return { exitCode: 1, report: created, message: `inboxesCreate failed: ${errMsg(created)}` }
    }
    const inboxId = String(created.id)

    let apiKey: string | undefined
    if (argv.includes("--mint-key")) {
      const minted = (await withPrivilegedDb(orgId, "cli-inbox-mint-key", (tx) =>
        runAdminOp(
          tx as never,
          orgId,
          "apiKeysCreate",
          { label: `${name} ingest`, inboxId },
          actor,
        ),
      )) as Record<string, unknown>
      if (errCode(minted)) {
        return { exitCode: 1, report: minted, message: `apiKeysCreate failed: ${errMsg(minted)}` }
      }
      apiKey = minted.key as string
    }

    return {
      exitCode: 0,
      report: {
        id: inboxId,
        kind: created.kind,
        name: created.name,
        ingestUrl: created.kind === "api" ? ingestUrl(orgId, inboxId) : null,
        ...(apiKey ? { apiKey } : {}),
      },
    }
  }

  if (sub === "update") {
    const id = arg("--id", argv)
    if (!id) return usage("update requires --id <inboxId>")
    const params: Record<string, unknown> = { id, ...emailIdentityParams(argv) }
    if (Object.keys(params).length === 1) {
      return usage(
        "update requires at least one of: --reply-via --from-name --reply-to --signature-html " +
          "--signature-text --ack-enabled --ack-body --sla-promise --attention-cutoff",
      )
    }
    const updated = (await withPrivilegedDb(orgId, "cli-inbox-update", (tx) =>
      runAdminOp(tx as never, orgId, "inboxesUpdate", params, actor),
    )) as Record<string, unknown>
    if (errCode(updated)) {
      return { exitCode: 1, report: updated, message: `inboxesUpdate failed: ${errMsg(updated)}` }
    }
    return { exitCode: 0, report: { id, updated: true } }
  }

  // sub === "move"
  const ticket = arg("--ticket", argv)
  const toInbox = arg("--to-inbox", argv)
  if (!ticket || !toInbox) return usage("move requires --ticket <id> --to-inbox <inboxId>")
  const moved = (await withPrivilegedDb(orgId, "cli-inbox-move", (tx) =>
    runAdminOp(
      tx as never,
      orgId,
      "ticketsMove",
      { toInboxId: toInbox, ticketIds: [ticket] },
      actor,
    ),
  )) as Record<string, unknown>
  if (errCode(moved)) {
    return { exitCode: 1, report: moved, message: `ticketsMove failed: ${errMsg(moved)}` }
  }
  return { exitCode: 0, report: moved }
}
