// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Installing the demo org's `database` connection.
//
// Every `db_*` tool resolves a `database` connection off `kernel.connected_accounts`
// before it does anything else, so without this row the oracle answers
// `not_connected` and the most impressive thing in the demo does not happen.
// Demo mode REFUSES connections (`createCredentialConnection` and
// `startOAuthFlow` both throw for a demo org), which is correct and stays
// exactly as it is: this function is not that path and does not weaken it.
//
// WHY A VISITOR CANNOT TURN THIS INTO A REAL CONNECTION
//
//   1. This function is not reachable from outside. The demo SEEDER calls it
//      and nothing else does: no route mounts it, no bridge method exposes it,
//      no tool wraps it.
//   2. It takes no credential. The stored `connectionString` is the fixed
//      sentinel from sentinel.ts, so a caller who controls every argument still
//      cannot store a DSN, a host or a password.
//   3. The visitor facing doors stay shut. A demo org cannot create or
//      re-connect a credential connection, so nobody can write over this row
//      with a real DSN.
//   4. Even a real DSN would not be dialled. `resolve.ts` rewrites the sentinel
//      for an org that passes both demo gates, and REFUSES any other stored
//      value on a demo org, so a demo org's database traffic can only ever
//      reach the warehouse schema through the read-only role.
//
// The row is org-owned, which is why it is written through the privileged
// handle: the `connected_accounts` RLS policies make an org-owned, non-kernel
// insert impossible under `liaison_rls`.
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { DEMO_WAREHOUSE_SENTINEL_DSN } from "./sentinel"

const APP_NAME = "database"
const CONNECTION_NAME = "database"
const IDENTIFIER = "default"
const DISPLAY_NAME = "Resonant Audio Labs warehouse"

export interface DemoWarehouseConnection {
  connectionId: string
}

/**
 * Give `orgId` the demo warehouse connection. Idempotent: a second call reuses
 * the existing row and refreshes the sentinel.
 */
export async function installDemoWarehouseConnection(opts: {
  orgId: string
  /** The seeded admin, for `created_by`. */
  createdByUserId: string
}): Promise<DemoWarehouseConnection> {
  const encrypted = encryptSecret(
    JSON.stringify({ connectionString: DEMO_WAREHOUSE_SENTINEL_DSN }),
    process.env.ENCRYPTION_KEY ?? "",
    CryptoContext.connectedAccountCredentials,
  )
  const k = drizzleSql.raw(schemaRef("kernel"))
  const metadata = JSON.stringify({
    demo: true,
    fixtureProvider: "liaison-demo-warehouse",
    note: "Demo analytics warehouse. No real database credential is stored here.",
  })

  const connectionId = await withPrivilegedDb(opts.orgId, "install-demo-warehouse", async (tx) => {
    const result = await tx.execute(drizzleSql`
      INSERT INTO ${k}.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
         identifier, display_name, credentials_encrypted, token_expires_at,
         metadata, status, created_by)
      VALUES
        (${opts.orgId}::uuid, ${APP_NAME}, ${CONNECTION_NAME}, 'org', NULL, 'credentials',
         ${IDENTIFIER}, ${DISPLAY_NAME}, ${encrypted}, NULL,
         ${metadata}::jsonb, 'active', ${opts.createdByUserId}::uuid)
      ON CONFLICT (org_id, app_name, connection_name, identifier, owner_type)
        WHERE status = 'active'
      DO UPDATE SET
        credentials_encrypted = EXCLUDED.credentials_encrypted,
        display_name = EXCLUDED.display_name,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const row = rows[0] as { id?: string } | undefined
    if (!row?.id) throw new Error("demo warehouse connection was not written")
    return row.id
  })

  return { connectionId }
}
