// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE STORED, NON-SECRET SETTINGS OF A CREDENTIALS CONNECTION.
//
// Editing a mailbox's credentials in Settings reopens the connect form. It used
// to open with only the email filled, so the person retyped the hosts, ports and
// username, and a wrong default port was offered silently. The form now loads
// what the account already holds.
//
// Only the fields the manifest marks `readable: true` ever leave the server: an
// allowlist, since a secret is not always typed `password` (an API key typed
// `text`). An org-owned account needs the
// connection's admin scope (as disconnecting it does); a personal one is read
// by its owner only. Anything else reads as not found.

import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { UUID_RE } from "~/lib/uuid"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { hasScope } from "~/modules/permissions/permissions"

export type ConnectionSettingsOutcome =
  | { status: "ok"; settings: Record<string, string> }
  | { status: "not_found" }
  | { status: "forbidden" }

export async function readConnectionSettings(params: {
  orgId: string
  userId: string
  scopes: readonly string[]
  connectedAccountId: string
}): Promise<ConnectionSettingsOutcome> {
  const { orgId, userId, scopes, connectedAccountId } = params
  // A malformed id names no account (and would make the uuid column throw).
  if (!UUID_RE.test(connectedAccountId)) return { status: "not_found" }
  const row = await withPrivilegedDb(orgId, "connected-account-settings-read", async (tx) => {
    const rows = await tx
      .select({
        appName: connectedAccounts.appName,
        connectionName: connectedAccounts.connectionName,
        ownerType: connectedAccounts.ownerType,
        ownerId: connectedAccounts.ownerId,
        status: connectedAccounts.status,
        credentialsEncrypted: connectedAccounts.credentialsEncrypted,
      })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.id, connectedAccountId), eq(connectedAccounts.orgId, orgId)))
      .limit(1)
    return rows[0]
  })
  if (!row) return { status: "not_found" }
  if (row.ownerType === "org") {
    if (!hasScope(connectionAdminScope(orgId, row.appName, row.connectionName), [...scopes])) {
      return { status: "forbidden" }
    }
  } else if (row.ownerId !== userId) {
    return { status: "not_found" }
  }

  const config = connectionConfigRegistry.get([orgId, row.appName, row.connectionName])
  const readable = new Set(
    (config?.credentialFields ?? [])
      .filter((f) => f.readable === true && f.type !== "password")
      .map((f) => f.name),
  )
  if (readable.size === 0 || !row.credentialsEncrypted) return { status: "ok", settings: {} }

  const stored = JSON.parse(
    decryptSecret(
      row.credentialsEncrypted,
      process.env.ENCRYPTION_KEY ?? "",
      CryptoContext.connectedAccountCredentials,
    ),
  ) as Record<string, unknown>
  const settings: Record<string, string> = {}
  for (const [name, value] of Object.entries(stored)) {
    if (!readable.has(name)) continue
    if (typeof value === "string") settings[name] = value
    else if (typeof value === "number" && Number.isFinite(value)) settings[name] = String(value)
  }
  return { status: "ok", settings }
}
