// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's GitHub connection: the sentinel token and the world's
// owner, so the GitHub app resolves its connection and every read it makes
// reaches the stand-in (provider.ts), which answers it in-process.
//
// Demo mode refuses credential posts on every visitor door
// (`createCredentialConnection`), and that stays as it is: `installDemoGithubConnection`
// is not that path. It is called by the services world's seed layer and
// nothing else, takes no token from its caller, and writes only the constants
// in sentinel.ts plus the seed's anchor, which the stand-in dates its history
// from (its story clock, never the wall clock).
//
// The row is org-owned, written on the privileged handle as the connection
// service does for its org-owned callers; the stand-in reads the anchor back on
// the handle scoped to the org whose request it answers.
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import {
  DEMO_GITHUB_IDENTIFIER,
  DEMO_GITHUB_OWNER,
  DEMO_GITHUB_SENTINEL_TOKEN,
  GITHUB_APP,
  GITHUB_CONNECTION,
} from "./sentinel"

/** The two fields the GitHub app's connection declares: the token and the owner. */
export function demoGithubCredentials(): Record<string, string> {
  return { token: DEMO_GITHUB_SENTINEL_TOKEN, owner: DEMO_GITHUB_OWNER }
}

function connectionMatch(orgId: string) {
  return and(
    eq(connectedAccounts.orgId, orgId),
    eq(connectedAccounts.appName, GITHUB_APP),
    eq(connectedAccounts.connectionName, GITHUB_CONNECTION),
    eq(connectedAccounts.ownerType, "org"),
  )
}

/**
 * Give `orgId` the services world's GitHub connection. Idempotent: a second
 * call refreshes the sentinel and the anchor on the same row.
 */
export async function installDemoGithubConnection(opts: {
  orgId: string
  /** The seeded admin, for `created_by`. */
  createdByUserId: string
  /** The seed's anchor: the stand-in's history is dated from it. */
  anchor: Date
}): Promise<{ connectionId: string }> {
  const credentialsEncrypted = encryptSecret(
    JSON.stringify(demoGithubCredentials()),
    process.env.ENCRYPTION_KEY ?? "",
    CryptoContext.connectedAccountCredentials,
  )
  const connectionId = await withPrivilegedDb(opts.orgId, "install-demo-github", async (tx) => {
    const [existing] = await tx
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(connectionMatch(opts.orgId))
      .limit(1)
    const fields = {
      providerType: "credentials" as const,
      identifier: DEMO_GITHUB_IDENTIFIER,
      displayName: "GitHub (demo stand-in)",
      credentialsEncrypted,
      status: "active" as const,
      statusMessage: null,
      disconnectedAt: null,
      metadata: {
        demo: true,
        anchor: opts.anchor.toISOString(),
        note: "Demo stand-in. No real account, no real token.",
      },
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
        appName: GITHUB_APP,
        connectionName: GITHUB_CONNECTION,
        ownerType: "org",
        ownerId: null,
        createdBy: opts.createdByUserId,
      })
      .returning({ id: connectedAccounts.id })
    if (!row) throw new Error("demo GitHub connection was not written")
    return row.id
  })
  return { connectionId }
}

/**
 * The anchor the org's stand-in history is dated from, or null when the org
 * holds no stand-in connection (the stand-in then refuses, it never guesses a
 * date from the wall clock).
 */
export async function demoGithubAnchorOf(orgId: string): Promise<Date | null> {
  const rows = await withPrivilegedDb(orgId, "demo-github-anchor", (tx) =>
    tx
      .select({ metadata: connectedAccounts.metadata })
      .from(connectedAccounts)
      .where(connectionMatch(orgId))
      .limit(1),
  )
  const metadata = rows[0]?.metadata as { demo?: unknown; anchor?: unknown } | null | undefined
  if (metadata?.demo !== true || typeof metadata.anchor !== "string") return null
  const at = new Date(metadata.anchor)
  return Number.isNaN(at.getTime()) ? null : at
}
