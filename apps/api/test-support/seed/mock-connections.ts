// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A connected account with placeholder credentials, for a browser test that
// needs an app connection without a provider round trip (the OAuth start flow
// redirects to the real provider). Test builds only: the row's tokens are
// fake, sealed with the server's own ENCRYPTION_KEY the way the OAuth callback
// seals real ones, so the app's token reads decrypt them. A resting row,
// written privileged as the standard tier writes its mail connections.
// Adopted on a repeat call: an active account of the same app, connection,
// owner and identifier is returned as is.
import { and, eq, isNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel/connected-accounts"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"

export interface MockConnectionInput {
  appName: string
  connectionName: string
  /** `user`: owned by `userId`; `org`: an org connection created by `userId`. */
  ownerType: "user" | "org"
  userId: string
  identifier: string
  displayName: string
  /** The account's metadata (an org Drive connection's chosen `sharedDrives`). */
  metadata?: Record<string, unknown>
  /** OAuth: fake access and refresh tokens. Credentials: this object, sealed. */
  kind:
    | { type: "oauth2"; providerAccountId?: string; accessToken?: string; refreshToken?: string }
    | { type: "credentials"; credentials: Record<string, string> }
}

export async function ensureMockConnection(
  orgId: string,
  input: MockConnectionInput,
): Promise<{ id: string; identifier: string; created: boolean }> {
  const ownerId = input.ownerType === "user" ? input.userId : null
  return withPrivilegedDb(orgId, "seed-route:mock-connection", async (tx) => {
    const [existing] = await tx
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, input.appName),
          eq(connectedAccounts.connectionName, input.connectionName),
          eq(connectedAccounts.ownerType, input.ownerType),
          ownerId ? eq(connectedAccounts.ownerId, ownerId) : isNull(connectedAccounts.ownerId),
          eq(connectedAccounts.identifier, input.identifier),
          eq(connectedAccounts.status, "active"),
        ),
      )
      .limit(1)
    if (existing) return { id: existing.id, identifier: input.identifier, created: false }
    const key = env.ENCRYPTION_KEY
    const oauth = input.kind.type === "oauth2"
    const [row] = await tx
      .insert(connectedAccounts)
      .values({
        orgId,
        appName: input.appName,
        connectionName: input.connectionName,
        ownerType: input.ownerType,
        ownerId,
        providerType: input.kind.type,
        identifier: input.identifier,
        displayName: input.displayName,
        providerAccountId:
          input.kind.type === "oauth2" ? (input.kind.providerAccountId ?? null) : null,
        accessTokenEncrypted: oauth
          ? encryptSecret(
              (input.kind.type === "oauth2" && input.kind.accessToken) || "e2e-fake-token",
              key,
              CryptoContext.connectedAccountAccessToken,
            )
          : null,
        refreshTokenEncrypted: oauth
          ? encryptSecret(
              (input.kind.type === "oauth2" && input.kind.refreshToken) || "e2e-fake-refresh",
              key,
              CryptoContext.connectedAccountRefreshToken,
            )
          : null,
        credentialsEncrypted:
          input.kind.type === "credentials"
            ? encryptSecret(
                JSON.stringify(input.kind.credentials),
                key,
                CryptoContext.connectedAccountCredentials,
              )
            : null,
        status: "active",
        createdBy: input.userId,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .returning({ id: connectedAccounts.id })
    if (!row)
      throw new Error(`mock connection: ${input.appName}/${input.connectionName} not written`)
    return { id: row.id, identifier: input.identifier, created: true }
  })
}
