// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The stamp an app registration writes on its schema once the manifest's DDL is
// fully applied (`stampAppSchema`, modules/apps/runtime.ts). A schema without it
// was made by something else (a numbered migration that creates the namespace,
// or a registration that has not finished): the manifest's columns may be absent.
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { extractRows } from "~/db"

export const APP_DDL_STAMP_PREFIX = "liaison:app-ddl:v2:"

/** Whether a registration has fully applied the manifest's DDL to `schemaName`. */
export async function appSchemaApplied(
  tx: { execute: (query: SQL) => Promise<unknown> },
  schemaName: string,
): Promise<boolean> {
  const [row] = extractRows<{ stamp: string | null }>(
    await tx.execute(drizzleSql`
      SELECT obj_description(n.oid, 'pg_namespace') AS stamp
        FROM pg_namespace n WHERE n.nspname = ${schemaName}`),
  )
  return row?.stamp?.startsWith(APP_DDL_STAMP_PREFIX) === true
}
