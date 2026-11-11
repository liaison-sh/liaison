// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT IS STORED FOR A TARGET, READ FROM THE STORE ITSELF.
//
// A secret request is complete when the store for its target holds a secret
// it did not hold when the agent asked. The card cannot be trusted to say so:
// it is the browser, and the browser may be anyone. So the server reads the
// stored rows and compares FINGERPRINTS:
//
//   byok                       sha256 of providerKeys.<provider>.encrypted
//   oauth_client               sha256 of the oauth_providers row's encrypted secret
//   google_integration_client  sha256 of integrations.google.oauthClient's encrypted secret
//   connection_credentials,    sha256 of (account id, credentials ciphertext) of each
//   api_connector_credentials  active org-owned account of the connection
//   api_key                    sha256 of each live key id with the request's label
//   oauth_connect              sha256 of each active OAuth account of the connection
//                              held by the request's owner (the person who asked,
//                              for a personal connect; the org, for a shared one)
//
// Every encryption here draws a fresh nonce, so re-entering the same secret
// still yields a new ciphertext and a new fingerprint. A fingerprint is a hash
// of ciphertext or of an id: it says nothing about the secret.
//
// The HINT is what the agent is told once the secret is saved, and never part
// of the secret where that would leak it: a provider key's last 4 characters
// (A8), an OAuth client id's tail (the id is not secret), a minted key's
// public prefix (the one the key list shows). Connection credentials get none:
// a password's last characters are still the password. A connected OAuth
// account's hint is the account it names (an address, a shop domain), which
// the provider chose: it is no secret, and the conversation shows it fenced.

import { createHash } from "node:crypto"
import { and, desc, sql as drizzleSql, eq, isNotNull } from "drizzle-orm"
import { API_CONNECTOR_APP, API_CONNECTOR_CONNECTION } from "~/apps/api-connector/store"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import type { PrivilegedDb } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts, oauthProviders, organizations } from "~/db/schema/kernel"
import { oauthClientKey } from "~/modules/apps/connections/oauth-client"
import { oauthClientIdHint } from "~/modules/apps/connections/oauth-client-provisioning"
import type { SecretTarget } from "~/modules/secret-requests/targets"

export interface StoredSecretState {
  /** One fingerprint per stored secret of the target. */
  fingerprints: string[]
  /** The hint of the newest stored secret, by fingerprint. */
  hints: Map<string, string | null>
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

async function orgSettings(tx: PrivilegedDb, orgId: string): Promise<Record<string, unknown>> {
  const [row] = await tx
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  return record(row?.settings) ?? {}
}

/** A connected account's fingerprint, as an `oauth_connect` request's state lists it. */
export function connectAccountFingerprint(accountId: string): string {
  return sha256(`oauth-connect:${accountId}`)
}

/** The hint column holds at most 40 characters. */
const HINT_MAX = 40

/** A connected account's name, cut to the hint column. */
export function accountHint(identifier: string): string {
  return identifier.length <= HINT_MAX ? identifier : `${identifier.slice(0, HINT_MAX - 1)}…`
}

/** The last 4 characters, never more: an API key's hint (A8). */
export function lastFour(value: string): string {
  return `…${value.slice(-4)}`
}

async function readState(
  tx: PrivilegedDb,
  orgId: string,
  target: SecretTarget,
  requester: string,
): Promise<StoredSecretState> {
  const fingerprints: string[] = []
  const hints = new Map<string, string | null>()
  const add = (fingerprint: string, hint: string | null) => {
    fingerprints.push(fingerprint)
    hints.set(fingerprint, hint)
  }

  switch (target.kind) {
    case "byok": {
      const keys = record((await orgSettings(tx, orgId)).providerKeys)
      const entry = record(keys?.[target.provider])
      const encrypted = text(entry?.encrypted)
      if (encrypted) {
        const masked = text(entry?.maskedHint)
        add(sha256(encrypted), masked ? lastFour(masked) : null)
      }
      break
    }
    case "google_integration_client": {
      const integrations = record((await orgSettings(tx, orgId)).integrations)
      const client = record(record(integrations?.google)?.oauthClient)
      const encrypted = text(client?.clientSecretEncrypted)
      const clientId = text(client?.clientId)
      if (encrypted) add(sha256(encrypted), clientId ? oauthClientIdHint(clientId) : null)
      break
    }
    case "oauth_client": {
      const rows = await tx
        .select({
          clientId: oauthProviders.clientId,
          secret: oauthProviders.clientSecretEncrypted,
        })
        .from(oauthProviders)
        .where(
          and(
            eq(oauthProviders.orgId, orgId),
            eq(oauthProviders.name, oauthClientKey(orgId, target.app, target.connection)),
          ),
        )
      for (const row of rows) add(sha256(row.secret), oauthClientIdHint(row.clientId))
      break
    }
    case "connection_credentials":
    case "api_connector_credentials": {
      const app = target.kind === "connection_credentials" ? target.app : API_CONNECTOR_APP
      const connection =
        target.kind === "connection_credentials" ? target.connection : API_CONNECTOR_CONNECTION
      const rows = await tx
        .select({
          id: connectedAccounts.id,
          identifier: connectedAccounts.identifier,
          ciphertext: connectedAccounts.credentialsEncrypted,
        })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.orgId, orgId),
            eq(connectedAccounts.appName, app),
            eq(connectedAccounts.connectionName, connection),
            target.kind === "connection_credentials" && target.mode === "personal"
              ? and(
                  eq(connectedAccounts.ownerType, "user"),
                  eq(connectedAccounts.ownerId, requester),
                )
              : eq(connectedAccounts.ownerType, "org"),
            eq(connectedAccounts.status, "active"),
            isNotNull(connectedAccounts.credentialsEncrypted),
          ),
        )
      for (const row of rows) {
        if (target.identifier && row.identifier !== target.identifier) continue
        if (!row.ciphertext) continue
        add(sha256(`${row.id}:${row.ciphertext}`), null)
      }
      break
    }
    case "oauth_connect": {
      const rows = await tx
        .select({
          id: connectedAccounts.id,
          identifier: connectedAccounts.identifier,
          displayName: connectedAccounts.displayName,
        })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.orgId, orgId),
            eq(connectedAccounts.appName, target.app),
            eq(connectedAccounts.connectionName, target.connection),
            eq(connectedAccounts.providerType, "oauth2"),
            eq(connectedAccounts.status, "active"),
            target.mode === "org"
              ? eq(connectedAccounts.ownerType, "org")
              : and(
                  eq(connectedAccounts.ownerType, "user"),
                  eq(connectedAccounts.ownerId, requester),
                ),
          ),
        )
        .orderBy(desc(connectedAccounts.createdAt))
      for (const row of rows) {
        add(connectAccountFingerprint(row.id), accountHint(row.displayName ?? row.identifier))
      }
      break
    }
    case "api_key": {
      const rows = extractRows<{ id: string; key_prefix: string }>(
        await tx.execute(drizzleSql`
          SELECT id, key_prefix FROM ${ticketsRel("api_keys")}
          WHERE org_id = ${orgId}::uuid AND label = ${target.label} AND revoked_at IS NULL
          ORDER BY created_at DESC`),
      )
      for (const row of rows) add(sha256(`api-key:${row.id}`), row.key_prefix)
      break
    }
  }
  return { fingerprints, hints }
}

/**
 * What the store holds for the target now. Privileged, org-scoped by `orgId`.
 * `requester` is the person the request was asked for: a personal connect
 * reads only their own accounts.
 */
export function readStoredSecretState(
  orgId: string,
  target: SecretTarget,
  requester: string,
  /** A privileged transaction of this org the caller holds: read on it, no second slot. */
  on?: PrivilegedDb,
): Promise<StoredSecretState> {
  if (on) return readState(on, orgId, target, requester)
  return withPrivilegedDb(orgId, "secret-request-stored-state", (tx) =>
    readState(tx, orgId, target, requester),
  )
}

/**
 * A secret stored since `baseline` was taken, with its hint, or null when the
 * store holds nothing new for the target.
 */
export function newStoredSecret(
  state: StoredSecretState,
  baseline: readonly string[],
): { fingerprint: string; hint: string | null } | null {
  const seen = new Set(baseline)
  const fresh = state.fingerprints.find((f) => !seen.has(f))
  return fresh ? { fingerprint: fresh, hint: state.hints.get(fresh) ?? null } : null
}
