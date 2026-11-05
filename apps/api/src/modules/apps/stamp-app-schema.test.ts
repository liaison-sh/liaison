// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The schema stamp is best effort: a schema the registering role does not own
// (a per-worker test clone, one an operator created by hand) loses the stamp and
// nothing else. A raw `SAVEPOINT` statement did not give that: the driver still
// failed the enclosing registration transaction on the COMMENT's error, so every
// app on such a schema failed to register.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import postgres from "postgres"
import { withSchemaAdmin } from "~/db/privileged"
import { stampAppSchema } from "~/modules/apps/runtime"

const APP_DSN =
  process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
const ADMIN_DSN = APP_DSN.replace("liaison_app:liaison_app", "liaison:liaison")
const FOREIGN = `zz_stamp_foreign_${process.pid}`
const OWNED = `zz_stamp_owned_${process.pid}`
const ORG = "00000000-0000-0000-0000-000000000000"

const su = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} })

beforeAll(async () => {
  // Owned by the superuser, not by the role registration runs as.
  await su.unsafe(`CREATE SCHEMA IF NOT EXISTS ${FOREIGN}`)
  await su.unsafe(`DROP SCHEMA IF EXISTS ${OWNED}`)
})

afterAll(async () => {
  await su.unsafe(`DROP SCHEMA IF EXISTS ${FOREIGN}`)
  await su.unsafe(`DROP SCHEMA IF EXISTS ${OWNED}`)
  await su.end()
})

describe("stampAppSchema", () => {
  it("loses only the stamp on a schema the registering role does not own", async () => {
    const result = await withSchemaAdmin(ORG, "stamp-test-foreign", async (tx) => {
      const stamped = await stampAppSchema(tx, FOREIGN, "liaison:app-ddl:v1:test")
      // The enclosing transaction is still usable and commits.
      await tx.execute(drizzleSql`SELECT 1`)
      return stamped
    })
    expect(result).toBe(false)
  })

  it("stamps a schema the registering role owns", async () => {
    const stamped = await withSchemaAdmin(ORG, "stamp-test-owned", async (tx) => {
      await tx.execute(drizzleSql.raw(`CREATE SCHEMA ${OWNED}`))
      return stampAppSchema(tx, OWNED, "liaison:app-ddl:v1:owned")
    })
    expect(stamped).toBe(true)
    const [row] = await su<{ comment: string | null }[]>`
      SELECT obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace WHERE nspname = ${OWNED}`
    expect(row?.comment).toBe("liaison:app-ddl:v1:owned")
  })
})
