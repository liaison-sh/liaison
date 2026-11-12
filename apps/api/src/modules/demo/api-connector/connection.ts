// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Installing a demo org's API connection: the fixture CRM adapter under the
// slug `crm`, pointed at the demo fixture origin, with the sentinel API key.
//
// Demo mode refuses adapter uploads and credential posts on every visitor
// door (the adapter routes and `createCredentialConnection`), and that stays
// as it is: this function is not that path. It is called by the demo seeder
// and nothing else, takes no adapter, URL or credential from its caller, and
// writes only the constants in sentinel.ts. Even a real key would be inert:
// the demo origin never resolves, and for a demo org it is answered by the
// fixture responder or refused, never put on the wire.
//
// Both rows are org-owned and written on the privileged handle, as the
// connection service does for its org-owned callers.
import { and, eq } from "drizzle-orm"
import { loadFixtureCrmAdapter } from "~/modules/apps/connections/api/__fixtures__/fixture-crm/adapter"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import {
  API_CONNECTOR_APP,
  API_CONNECTOR_CONNECTION,
  upsertAdapterRow,
} from "~/modules/apps/connections/api/store"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import {
  DEMO_API_CONNECTOR_BASE_URL,
  DEMO_API_CONNECTOR_IDENTIFIER,
  DEMO_API_CONNECTOR_SENTINEL_KEY,
} from "./sentinel"

export interface DemoApiConnectorConnection {
  identifier: string
  connectionId: string
}

/**
 * Give `orgId` the demo API connection. Idempotent: a second call refreshes
 * the adapter and the sentinel on the same rows.
 */
export async function installDemoApiConnectorConnection(opts: {
  orgId: string
  /** The seeded admin, for `updated_by` / `created_by`. */
  createdByUserId: string
}): Promise<DemoApiConnectorConnection> {
  const adapter = loadFixtureCrmAdapter({ baseUrl: DEMO_API_CONNECTOR_BASE_URL })
  await upsertAdapterRow(opts.orgId, DEMO_API_CONNECTOR_IDENTIFIER, adapter, opts.createdByUserId)

  const credentialsEncrypted = encryptSecret(
    JSON.stringify({ apiKey: DEMO_API_CONNECTOR_SENTINEL_KEY }),
    process.env.ENCRYPTION_KEY ?? "",
    CryptoContext.connectedAccountCredentials,
  )
  const connectionId = await withPrivilegedDb(
    opts.orgId,
    "install-demo-api-connector",
    async (tx) => {
      const match = and(
        eq(connectedAccounts.orgId, opts.orgId),
        eq(connectedAccounts.appName, API_CONNECTOR_APP),
        eq(connectedAccounts.connectionName, API_CONNECTOR_CONNECTION),
        eq(connectedAccounts.ownerType, "org"),
        eq(connectedAccounts.identifier, DEMO_API_CONNECTOR_IDENTIFIER),
      )
      const [existing] = await tx
        .select({ id: connectedAccounts.id })
        .from(connectedAccounts)
        .where(match)
        .limit(1)
      const fields = {
        providerType: "credentials" as const,
        displayName: adapter.name,
        credentialsEncrypted,
        status: "active" as const,
        statusMessage: null,
        disconnectedAt: null,
        metadata: { demo: true, note: "Demo fixtures. No real system, no real credential." },
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
          appName: API_CONNECTOR_APP,
          connectionName: API_CONNECTOR_CONNECTION,
          ownerType: "org",
          ownerId: null,
          identifier: DEMO_API_CONNECTOR_IDENTIFIER,
          createdBy: opts.createdByUserId,
        })
        .returning({ id: connectedAccounts.id })
      if (!row) throw new Error("demo API connection was not written")
      return row.id
    },
  )
  await invalidateConnectionCaches(opts.orgId, DEMO_API_CONNECTOR_IDENTIFIER)
  return { identifier: DEMO_API_CONNECTOR_IDENTIFIER, connectionId }
}
