// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `tickets.inboxes` provisioner: support inboxes whose mail becomes tickets.
 *
 * Every inbox here is backed by a connection the TICKETS app owns
 * (`tickets/gmail` or `tickets/imap`). The tickets app syncs only its own
 * connections, and its reactive `ticketsOnAccountConnected` handler creates (or
 * rebinds, on a reconnect) the inbox row when such a connection lands. This
 * provisioner never touches the Mail app.
 *
 *  - GMAIL: save the per-org Google OAuth client when supplied, then either
 *    converge the settings of an inbox already bound to a tickets connection, or
 *    report `pending` for the interactive `liaison connect tickets/gmail`.
 *  - IMAP: ensure an org-owned `tickets/imap` connection for the address
 *    (headless), wait (bounded) for the live server to create the inbox, then
 *    converge its settings. On timeout it reports `pending`; a re-run converges.
 *
 * Settings convergence (`convergeTicketInbox`) is shared with `liaison connect`.
 */
import { sql as drizzleSql } from "drizzle-orm"
import {
  runAdminOp,
  writeApproveRepliesFromHome as writeApproveRepliesFromHomeSetting,
} from "~/apps/tickets/admin"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { readAdminErrorCode } from "~/cli/lib/admin-op"
import {
  googleClientPending,
  googleClientPlan,
  passwordPending,
} from "~/cli/provisioners/mail-mailboxes"
import {
  connectingPersonOrFail,
  type PendingItem,
  type Provisioner,
  type ProvisionPlan,
  type ProvisionResult,
} from "~/cli/provisioners/types"
import { extractRows, type PrivilegedDb } from "~/db"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { saveGoogleIntegrationConfig } from "~/modules/settings/google-integration"

type TicketInboxEntry = NonNullable<NonNullable<ProvisioningConfig["tickets"]>["inboxes"]>[number]

/** The inbox settings the config converges. */
export type TicketInboxSettings = Pick<
  TicketInboxEntry,
  "name" | "fromDisplayName" | "defaultTeam" | "default"
>

/** A tickets inbox row plus the app that owns its connection. */
export interface TicketInboxRow {
  id: string
  name: string
  from_display_name: string | null
  default_team: string | null
  is_default_for_create: boolean
  connected_account_id: string | null
  connection_app: string | null
}

interface TicketInboxResult {
  address: string
  provider: "gmail" | "imap"
  /** Whether a tickets-owned connection exists for the address. */
  connected: boolean
  /** Whether the inbox row exists and is bound to that connection. */
  ready: boolean
}

type PrivRunner = <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>

/** Read the live (non-archived) tickets inbox for an address, with its connection's app. */
export async function readTicketInbox(
  priv: PrivRunner,
  orgId: string,
  address: string,
): Promise<TicketInboxRow | null> {
  const rows = await priv("cli-ticket-inbox-read", (tx) =>
    tx.execute(drizzleSql`
      SELECT i.id, i.name, i.from_display_name, i.default_team, i.is_default_for_create,
             i.connected_account_id, ca.app_name AS connection_app
      FROM ${ticketsRel("inboxes")} i
      LEFT JOIN ${kernelRel("connected_accounts")} ca
        ON ca.id = i.connected_account_id AND ca.status = 'active'
      WHERE i.org_id = ${orgId}::uuid AND lower(i.email_address) = lower(${address})
        AND i.archived_at IS NULL
      LIMIT 1
    `),
  )
  return extractRows<TicketInboxRow>(rows)[0] ?? null
}

/**
 * Converge an existing inbox's settings to the config. Only fields the config
 * sets are compared; `default: false` never clears the flag (moving the default
 * is done by marking another inbox `default: true`). Returns the changed field
 * names (empty when already converged).
 */
export async function convergeTicketInbox(
  priv: PrivRunner,
  orgId: string,
  userId: string,
  row: TicketInboxRow,
  want: TicketInboxSettings,
): Promise<string[]> {
  const params: Record<string, unknown> = {}
  if (want.name !== undefined && want.name !== row.name) params.name = want.name
  if (want.fromDisplayName !== undefined && want.fromDisplayName !== row.from_display_name) {
    params.fromDisplayName = want.fromDisplayName
  }
  if (want.defaultTeam !== undefined && want.defaultTeam !== row.default_team) {
    params.defaultTeam = want.defaultTeam
  }
  if (want.default === true && !row.is_default_for_create) params.isDefaultForCreate = true
  const changed = Object.keys(params)
  if (changed.length === 0) return []
  const result = await priv("cli-ticket-inbox-update", (tx) =>
    runAdminOp(
      tx,
      orgId,
      "inboxesUpdate",
      { id: row.id, ...params },
      { actorType: "user", userId },
    ),
  )
  const errCode = readAdminErrorCode(result)
  if (errCode) throw new Error(`tickets inbox ${row.id}: inboxesUpdate failed (${errCode})`)
  return changed
}

/**
 * Converge `settings.tickets.approveRepliesFromHome` (the same key the tickets
 * settings page writes through PATCH /api/org). Touches only that key; returns
 * whether the stored value changed.
 */
export async function writeApproveRepliesFromHome(
  priv: PrivRunner,
  orgId: string,
  value: boolean,
): Promise<boolean> {
  return priv(
    "config-apply-tickets-approve-from-home",
    async (tx) => (await writeApproveRepliesFromHomeSetting(tx, orgId, value)) !== null,
  )
}

/** The inbox for an address when it is bound to a tickets connection, now (no wait). */
async function readBoundInbox(
  priv: PrivRunner,
  orgId: string,
  address: string,
): Promise<TicketInboxRow | null> {
  const row = await readTicketInbox(priv, orgId, address)
  return row && row.connection_app === "tickets" ? row : null
}

export interface TicketInboxesDeps {
  /** How often to re-check for the inbox the server creates reactively. */
  pollIntervalMs: number
  /** Bounded total wait before reporting `pending`. */
  pollTimeoutMs: number
  sleep: (ms: number) => Promise<void>
}

const defaultDeps: TicketInboxesDeps = {
  pollIntervalMs: 1_000,
  pollTimeoutMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export function createTicketInboxesProvisioner(
  deps: TicketInboxesDeps = defaultDeps,
): Provisioner<ProvisioningConfig> {
  async function pollForInbox(
    priv: PrivRunner,
    orgId: string,
    address: string,
  ): Promise<TicketInboxRow | null> {
    const deadline = Date.now() + deps.pollTimeoutMs
    for (;;) {
      const row = await readTicketInbox(priv, orgId, address)
      if (row && row.connection_app === "tickets") return row
      if (Date.now() >= deadline) return null
      await deps.sleep(deps.pollIntervalMs)
    }
  }

  return {
    key: "tickets",

    async plan(_ctx, config): Promise<ProvisionPlan> {
      const list = config.tickets?.inboxes ?? []
      const approveFromHome = config.tickets?.approveRepliesFromHome
      return {
        actions: [
          ...(approveFromHome !== undefined
            ? [`tickets setting approveRepliesFromHome = ${approveFromHome}`]
            : []),
          ...list.map((i) =>
            i.provider === "gmail"
              ? `tickets gmail inbox '${i.address}' (${googleClientPlan(i.google)}OAuth via connect tickets/gmail)`
              : `tickets imap inbox '${i.address}' (connect, wait for inbox, apply settings)`,
          ),
        ],
      }
    },

    async apply(ctx, _plan, config): Promise<ProvisionResult> {
      const list = config.tickets?.inboxes ?? []
      const approveFromHome = config.tickets?.approveRepliesFromHome
      if (list.length === 0 && approveFromHome === undefined) return {}

      const inboxes: TicketInboxResult[] = []
      const changed: string[] = []
      const unchanged: string[] = []

      if (approveFromHome !== undefined) {
        const label = "tickets.approveRepliesFromHome"
        const wrote = await writeApproveRepliesFromHome(ctx.priv, ctx.orgId, approveFromHome)
        ctx.log(`tickets setting approveRepliesFromHome ${wrote ? "written" : "already set"}`)
        ;(wrote ? changed : unchanged).push(label)
      }
      const pending: PendingItem[] = []
      const key = (address: string) => `tickets.inboxes.${address}`

      const converge = async (row: TicketInboxRow, entry: TicketInboxEntry) => {
        const fields = await convergeTicketInbox(ctx.priv, ctx.orgId, ctx.actor.userId, row, entry)
        if (fields.length > 0) {
          ctx.log(`tickets inbox '${entry.address}': updated ${fields.join(", ")}`)
          changed.push(`${key(entry.address)}.settings`)
        } else {
          unchanged.push(`${key(entry.address)}.settings`)
        }
      }

      for (const entry of list) {
        if (entry.provider === "gmail") {
          if (entry.google && ctx.toolPath) {
            pending.push(googleClientPending("tickets", entry.address))
          } else if (entry.google) {
            await saveGoogleIntegrationConfig(ctx.orgId, {
              clientId: entry.google.clientId,
              clientSecret: entry.google.clientSecret,
            })
            changed.push(`${key(entry.address)}.googleClient`)
          }
          const row = await readTicketInbox(ctx.priv, ctx.orgId, entry.address)
          if (row && row.connection_app === "tickets") {
            await converge(row, entry)
            inboxes.push({
              address: entry.address,
              provider: "gmail",
              connected: true,
              ready: true,
            })
            continue
          }
          const boundElsewhere = row !== null && row.connection_app !== null
          ctx.log(
            boundElsewhere
              ? `tickets inbox '${entry.address}': bound to a '${row.connection_app}' app connection, ` +
                  "which never delivers tickets; run 'liaison connect tickets/gmail' to rebind it"
              : `tickets inbox '${entry.address}': run 'liaison guide google --email ${entry.address}' for its path and steps, then 'liaison connect tickets/gmail' to authorize`,
          )
          pending.push({
            kind: "oauth",
            app: "tickets",
            connection: "gmail",
            action: `liaison guide google --email ${entry.address}, then liaison connect tickets/gmail`,
            message: boundElsewhere
              ? `Ticket inbox '${entry.address}' is bound to a '${row.connection_app}' app connection; ` +
                "connect it through the tickets app so it receives tickets."
              : `Ticket inbox '${entry.address}' awaits Google OAuth consent.`,
          })
          inboxes.push({
            address: entry.address,
            provider: "gmail",
            connected: false,
            ready: false,
          })
          continue
        }

        const imap = entry.imap
        if (!imap) continue // schema guarantees it; narrowing only

        const existing = await ctx.priv("cli-ticket-inbox-imap-precheck", (tx) =>
          tx.execute(drizzleSql`
            SELECT id FROM ${kernelRel("connected_accounts")}
            WHERE org_id = ${ctx.orgId}::uuid AND app_name = 'tickets' AND connection_name = 'imap'
              AND lower(identifier) = lower(${entry.address}) AND status = 'active'
            LIMIT 1
          `),
        )
        const connected = extractRows(existing).length > 0
        if (connected) {
          unchanged.push(`${key(entry.address)}.connection`)
        } else if (ctx.toolPath) {
          // No password on the tool path: create nothing, ask for the secret.
          // The inbox appears once the secret card saves the connection; its
          // settings are applied by a later call.
          ctx.log(`tickets inbox '${entry.address}': waiting for its password`)
          pending.push(passwordPending("tickets", entry.address))
          inboxes.push({ address: entry.address, provider: "imap", connected: false, ready: false })
          continue
        } else {
          // Org-owned non-kernel connections are uninsertable under liaison_rls
          // (the RETURNING is blocked), so this runs privileged.
          const creator = connectingPersonOrFail(
            ctx,
            `tickets: the imap connection of '${entry.address}'`,
          )
          await ctx.priv("cli-ticket-inbox-imap-create", (priv) =>
            createCredentialConnection(priv, ctx.orgId, creator, "tickets", "imap", {
              identifier: entry.address,
              credentials: {
                email: imap.email,
                imapHost: imap.imapHost,
                imapPort: String(imap.imapPort),
                smtpHost: imap.smtpHost,
                smtpPort: String(imap.smtpPort),
                username: imap.username,
                password: imap.password,
              },
              ownerType: "org",
            }),
          )
          ctx.log(`tickets inbox '${entry.address}': imap connection created`)
          changed.push(`${key(entry.address)}.connection`)
        }

        // The tool path never waits for the server: it reads what exists now.
        const row = ctx.toolPath
          ? await readBoundInbox(ctx.priv, ctx.orgId, entry.address)
          : await pollForInbox(ctx.priv, ctx.orgId, entry.address)
        if (!row && ctx.toolPath) {
          pending.push({
            kind: "credentials",
            app: "tickets",
            connection: "imap",
            identifier: entry.address,
            action: "apply again once the inbox appears",
            message: `Ticket inbox '${entry.address}' is connected; apply again once the inbox appears to set its settings.`,
          })
          inboxes.push({ address: entry.address, provider: "imap", connected: true, ready: false })
          continue
        }
        if (!row) {
          ctx.log(
            `tickets inbox '${entry.address}': the server has not created the inbox yet ` +
              "(is the server running and draining events?); re-run config apply to apply its settings",
          )
          pending.push({
            kind: "credentials",
            app: "tickets",
            connection: "imap",
            action: "liaison config apply (re-run once the server has created the inbox)",
            message: `Ticket inbox '${entry.address}' is connected; its settings apply on a re-run.`,
          })
          inboxes.push({ address: entry.address, provider: "imap", connected: true, ready: false })
          continue
        }
        await converge(row, entry)
        inboxes.push({ address: entry.address, provider: "imap", connected: true, ready: true })
      }

      return {
        section: { inboxes },
        ...(changed.length > 0 ? { changed } : {}),
        ...(unchanged.length > 0 ? { unchanged } : {}),
        ...(pending.length > 0 ? { pending } : {}),
      }
    },
  }
}

/** Production provisioner (30 s bounded wait, 1 s cadence). */
export const ticketInboxesProvisioner = createTicketInboxesProvisioner()
