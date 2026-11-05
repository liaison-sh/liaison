// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `service.test.ts` proves that `lastContactedAt` folds invoicing activity in,
// and it needs an `app_invoicing.documents` table to do it. It used to BRANCH:
// create a minimal table when the app was absent, and otherwise write its
// fixture rows into the REGISTERED app's own table, in the registered shape.
// Two things were wrong with that. Which branch ran depended on whether some
// other file had registered invoicing first, so the file asserted against a
// shape it had not written; and on the branch it usually took in a full run it
// inserted into, and deleted from, live application tables.
//
// This drives the case the branch was written for: a registered-shape
// `app_invoicing` already in place, with a witness on every insert into its
// documents table, and `service.test.ts` run against it in its own process.
//
// It lives HERE, and not beside `service.test.ts` under `src/modules/contacts`,
// because it spawns a nested `bun test` over that file: under the unit suite,
// which selects `src/modules` whole, the parent process runs `service.test.ts`
// too and the two processes fight over the same fixture. `integration-extra`
// runs in its own process for exactly this reason, as the mail analogue next to
// it already does.
//
// Fails-without-fix: the witness records the fixture's rows.
import { afterAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  inheritedFixtureLockEnv,
  releaseAppSchema,
  takeOverAppSchema,
} from "~/tests/helpers/app-schema-fixture"

const SERVICE_FILE = "src/modules/contacts/service.test.ts"

// No `acquireAppSchemaLock` here: the child takes that same Postgres advisory
// lock, so holding it across the spawn would deadlock on ourselves.
afterAll(async () => {
  await releaseAppSchema("app_invoicing")
})

describe("the last-activity fixture never writes into a registered invoicing schema", () => {
  it("leaves the registered documents table untouched", async () => {
    await takeOverAppSchema("app_invoicing")
    await sql.unsafe(`GRANT ALL ON SCHEMA app_invoicing TO liaison_rls, liaison_app, liaison_admin`)
    await sql.unsafe(`
      CREATE TABLE app_invoicing.issuer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        legal_name TEXT NOT NULL,
        country TEXT,
        default_currency TEXT
      )`)
    // The registered shape, with the `type` column the old branch keyed on.
    await sql.unsafe(`
      CREATE TABLE app_invoicing.documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id UUID NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        issuer_profile_id UUID NOT NULL REFERENCES app_invoicing.issuer_profiles (id),
        currency TEXT NOT NULL,
        counterparty_contact_id UUID,
        issued_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    await sql.unsafe(`CREATE TABLE app_invoicing.fixture_witness (at TIMESTAMPTZ DEFAULT now())`)
    await sql.unsafe(`
      CREATE FUNCTION app_invoicing.note_fixture_write() RETURNS trigger AS $$
      BEGIN
        INSERT INTO app_invoicing.fixture_witness DEFAULT VALUES;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await sql.unsafe(`
      CREATE TRIGGER note_fixture_write BEFORE INSERT ON app_invoicing.documents
      FOR EACH ROW EXECUTE FUNCTION app_invoicing.note_fixture_write()`)
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON app_invoicing.issuer_profiles, app_invoicing.documents, app_invoicing.fixture_witness TO liaison_rls, liaison_app, liaison_admin`,
    )

    const child = Bun.spawn(["bun", "test", "--timeout", "120000", SERVICE_FILE], {
      cwd: process.cwd(),
      // The child takes the same schema over: it inherits the ownership lock
      // this file holds instead of queueing on it.
      env: { ...process.env, ...inheritedFixtureLockEnv(["app_invoicing"]) },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) {
      throw new Error(
        `child "bun test ${SERVICE_FILE}" exited ${code}\n${err.slice(-2500)}\n${out.slice(-1500)}`,
      )
    }
    // It really ran: an empty child run must never read as a pass.
    expect(`${err}\n${out}`).toContain("across 1 file")

    const [witness] = (await sql`
      SELECT count(*)::int AS n FROM app_invoicing.fixture_witness`) as unknown as Array<{
      n: number
    }>
    expect(witness.n).toBe(0)
    // And the shape that was here before the child ran is still exactly here.
    const [issuer] = (await sql`
      SELECT to_regclass('app_invoicing.issuer_profiles') AS t`) as unknown as Array<{
      t: string | null
    }>
    expect(issuer.t).not.toBeNull()
  }, 180_000)
})
