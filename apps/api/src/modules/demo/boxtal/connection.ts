// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Installing a demo org's Boxtal connection: the sentinel keys on the sandbox
// environment, so the Boxtal app resolves a client and its traffic reaches the
// demo responder (responder.ts), which answers it in-process.
//
// Demo mode refuses credential posts on every visitor door
// (`createCredentialConnection`), and that stays as it is: this function is not
// that path. It is called by the demo seeder and nothing else, takes no key
// from its caller, and writes only the constants in sentinel.ts. Even a real
// key would be inert: for a demo org every Boxtal host is answered by the
// responder or refused, never put on the wire.
//
// The row is org-owned, written on the privileged handle as the connection
// service does for its org-owned callers.
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import {
  DEMO_BOXTAL_CONNECTION,
  DEMO_BOXTAL_IDENTIFIER,
  DEMO_BOXTAL_SENTINEL_KEY,
} from "./sentinel"

const APP_NAME = "boxtal"

/** The five keys the Boxtal app reads (bundled-apps/boxtal/src/lib/get-client.ts). */
export function demoBoxtalCredentials(): Record<string, string> {
  return {
    v1Key: DEMO_BOXTAL_SENTINEL_KEY,
    v1Secret: DEMO_BOXTAL_SENTINEL_KEY,
    v3Key: DEMO_BOXTAL_SENTINEL_KEY,
    v3Secret: DEMO_BOXTAL_SENTINEL_KEY,
    environment: "sandbox",
  }
}

/**
 * Give `orgId` the demo Boxtal connection. Idempotent: a second call refreshes
 * the sentinel on the same row.
 */
export async function installDemoBoxtalConnection(opts: {
  orgId: string
  /** The seeded admin, for `created_by`. */
  createdByUserId: string
}): Promise<{ connectionId: string }> {
  const credentialsEncrypted = encryptSecret(
    JSON.stringify(demoBoxtalCredentials()),
    process.env.ENCRYPTION_KEY ?? "",
    CryptoContext.connectedAccountCredentials,
  )
  const connectionId = await withPrivilegedDb(opts.orgId, "install-demo-boxtal", async (tx) => {
    const match = and(
      eq(connectedAccounts.orgId, opts.orgId),
      eq(connectedAccounts.appName, APP_NAME),
      eq(connectedAccounts.connectionName, DEMO_BOXTAL_CONNECTION),
      eq(connectedAccounts.ownerType, "org"),
    )
    const [existing] = await tx
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(match)
      .limit(1)
    const fields = {
      providerType: "credentials" as const,
      identifier: DEMO_BOXTAL_IDENTIFIER,
      displayName: "Boxtal (demo)",
      credentialsEncrypted,
      status: "active" as const,
      statusMessage: null,
      disconnectedAt: null,
      metadata: { demo: true, note: "Demo fixtures. No real carrier, no real credential." },
    }
    if (existing) {
      await tx
        .update(connectedAccounts)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(connectedAccounts.id, existing.id))
      return existing.id
    }
    const [row] = await tx
      .insert(connectedAccounts)
      .values({
        ...fields,
        orgId: opts.orgId,
        appName: APP_NAME,
        connectionName: DEMO_BOXTAL_CONNECTION,
        ownerType: "org",
        ownerId: null,
        createdBy: opts.createdByUserId,
      })
      .returning({ id: connectedAccounts.id })
    if (!row) throw new Error("demo Boxtal connection was not written")
    return row.id
  })
  return { connectionId }
}
