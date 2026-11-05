// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `mail.mailboxes` provisioner: mailboxes people read and send from in the MAIL
 * app. It creates Mail app connections only and never a ticket inbox (ticket
 * inboxes are `tickets.inboxes`, backed by connections the tickets app owns).
 *
 *  - GMAIL (shared only): save the per-org Google OAuth client when supplied and
 *    report `pending` for the interactive `liaison connect mail/gmail`. No
 *    connection is created headlessly.
 *  - IMAP: ensure a `mail/imap` connection for the address, org-owned (shared)
 *    or owned by the member named in `owner` (personal). The Mail app's reactive
 *    `onAccountConnected` handler creates the mailbox once the server drains the
 *    connection event; this provisioner does not wait for it.
 *
 * Access to a shared mailbox is the `mail:inbox` dimension grant, managed in
 * Settings; this config does not model it.
 */
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import {
  connectingPersonOrFail,
  type PendingItem,
  type Provisioner,
  type ProvisionPlan,
  type ProvisionResult,
} from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { users } from "~/db/schema/kernel"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { saveGoogleIntegrationConfig } from "~/modules/settings/google-integration"

interface MailMailboxResult {
  address: string
  provider: "gmail" | "imap"
  visibility: "shared" | "personal"
  /** Whether the Mail app connection exists (always false for a pending Gmail box). */
  connected: boolean
}

/** A Google OAuth client named on the tool path, whose secret comes from the secret card. */
export function googleClientPending(app: "mail" | "tickets", address: string): PendingItem {
  return {
    kind: "credentials",
    app,
    connection: "google-client",
    identifier: address,
    action: "enter the Google client secret with request_secret, then apply again",
    message: `The Google client for '${address}' is saved once its secret is entered.`,
  }
}

/**
 * The Google client part of a Gmail mailbox or inbox plan line. The client ID
 * is not a secret and is shown, so the person approving sees which client is
 * set (an id pasted from another app's setup is visible before it is saved);
 * the secret never is.
 */
export function googleClientPlan(google: { clientId: string } | undefined): string {
  return google ? `save Google client ID ${google.clientId}, ` : ""
}

/** An IMAP box named on the tool path, whose password comes from the secret card. */
export function passwordPending(app: "mail" | "tickets", address: string): PendingItem {
  return {
    kind: "credentials",
    app,
    connection: "imap",
    identifier: address,
    action: "enter the mailbox password with request_secret",
    message: `'${address}' connects once its password is entered.`,
  }
}

export const mailMailboxesProvisioner: Provisioner<ProvisioningConfig> = {
  key: "mail",

  async plan(_ctx, config): Promise<ProvisionPlan> {
    const list = config.mail?.mailboxes ?? []
    return {
      actions: list.map((m) =>
        m.provider === "gmail"
          ? `mail gmail mailbox '${m.address}' (${googleClientPlan(m.google)}OAuth via connect mail/gmail)`
          : `mail imap mailbox '${m.address}' (${m.owner ? `personal, owner ${m.owner}` : "shared"})`,
      ),
    }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const list = config.mail?.mailboxes ?? []
    if (list.length === 0) return {}

    const mailboxes: MailMailboxResult[] = []
    const changed: string[] = []
    const unchanged: string[] = []
    const pending: PendingItem[] = []
    const key = (address: string) => `mail.mailboxes.${address}`

    for (const m of list) {
      if (m.provider === "gmail") {
        if (m.google && ctx.toolPath) {
          // A secret never travels as a tool param: the client is saved once
          // the person enters its secret on the secret card.
          pending.push(googleClientPending("mail", m.address))
        } else if (m.google) {
          await saveGoogleIntegrationConfig(ctx.orgId, {
            clientId: m.google.clientId,
            clientSecret: m.google.clientSecret,
          })
          changed.push(`${key(m.address)}.googleClient`)
        }
        ctx.log(
          `mail mailbox '${m.address}': run 'liaison guide google --email ${m.address}' for its path and steps, then 'liaison connect mail/gmail' to authorize`,
        )
        pending.push({
          kind: "oauth",
          app: "mail",
          connection: "gmail",
          action: `liaison guide google --email ${m.address}, then liaison connect mail/gmail`,
          message: `Mail app mailbox '${m.address}' awaits Google OAuth consent.`,
        })
        mailboxes.push({
          address: m.address,
          provider: "gmail",
          visibility: "shared",
          connected: false,
        })
        continue
      }

      const imap = m.imap
      if (!imap) continue // schema guarantees it; narrowing only

      let ownerUserId: string | null = null
      if (m.owner !== undefined) {
        const owner = m.owner
        const [row] = await ctx.priv("cli-mail-owner", (tx) =>
          tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(eq(users.orgId, ctx.orgId), drizzleSql`lower(${users.email}) = lower(${owner})`),
            )
            .limit(1),
        )
        if (!row) {
          throw new ConfigError(
            `mail.mailboxes: owner '${owner}' of '${m.address}' is not a member of this org ` +
              "(add them under users first)",
          )
        }
        ownerUserId = row.id
      }

      const existing = await ctx.priv("cli-mail-imap-precheck", (tx) =>
        tx.execute(drizzleSql`
          SELECT id FROM ${kernelRel("connected_accounts")}
          WHERE org_id = ${ctx.orgId}::uuid AND app_name = 'mail' AND connection_name = 'imap'
            AND lower(identifier) = lower(${m.address}) AND status = 'active'
            AND owner_type = ${ownerUserId ? "user" : "org"}
            AND owner_id IS NOT DISTINCT FROM ${ownerUserId}::uuid
          LIMIT 1
        `),
      )
      if (extractRows(existing).length > 0) {
        unchanged.push(`${key(m.address)}.connection`)
      } else if (ctx.toolPath) {
        // No password on the tool path: create nothing, ask for the secret.
        ctx.log(`mail mailbox '${m.address}': waiting for its password`)
        pending.push(passwordPending("mail", m.address))
        mailboxes.push({
          address: m.address,
          provider: "imap",
          visibility: ownerUserId ? "personal" : "shared",
          connected: false,
        })
        continue
      } else {
        const creator =
          ownerUserId ?? connectingPersonOrFail(ctx, `mail: the imap connection of '${m.address}'`)
        await ctx.priv("cli-mail-imap-create", (priv) =>
          createCredentialConnection(priv, ctx.orgId, creator, "mail", "imap", {
            identifier: m.address,
            credentials: {
              email: imap.email,
              imapHost: imap.imapHost,
              imapPort: String(imap.imapPort),
              smtpHost: imap.smtpHost,
              smtpPort: String(imap.smtpPort),
              username: imap.username,
              password: imap.password,
            },
            ownerType: ownerUserId ? "user" : "org",
          }),
        )
        ctx.log(`mail mailbox '${m.address}': imap connection created`)
        changed.push(`${key(m.address)}.connection`)
      }
      mailboxes.push({
        address: m.address,
        provider: "imap",
        visibility: ownerUserId ? "personal" : "shared",
        connected: true,
      })
    }

    return {
      section: { mailboxes },
      ...(changed.length > 0 ? { changed } : {}),
      ...(unchanged.length > 0 ? { unchanged } : {}),
      ...(pending.length > 0 ? { pending } : {}),
    }
  },
}
