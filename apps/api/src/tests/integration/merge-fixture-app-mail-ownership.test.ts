// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `merge.test.ts` fakes `app_mail.conversations` because `listContacts` and the
// merge re-point both read it. It used to fake it with `CREATE TABLE IF NOT
// EXISTS`, which owns nothing: `app_mail` is a REGISTERED app schema and is
// already present in any database an app install has touched, so the statement
// was a silent no-op and the file then ran against a table shape it never
// wrote. That is the same hazard that hid the invoicing red: whether the file
// passes depends on which other file installed the app first.
//
// This drives the real thing. It puts a FOREIGN `app_mail.conversations` in
// place — one whose column set differs from the fixture's in a column the
// file's own code path reads (`last_message_at`, which `listContacts` folds
// into `lastContactedAt`) — and runs `merge.test.ts` in a child `bun test`.
// The shape divergence is not hypothetical: the four in-repo fixtures of this
// table already disagree with each other (no `assigned_to` in
// tests/integration/mail-sync, an `escalated_ticket_id` in
// tests/integration/mail-api) and the registered manifest shape has columns
// none of them carry.
//
// Fails-without-fix: with `CREATE TABLE IF NOT EXISTS`, the child inherits the
// foreign table and every `listContacts` case dies on `column c.last_message_at
// does not exist`. Passes-with-fix: the file takes the schema over, builds its
// own, and is green whatever was there.
//
// It lives HERE, and not beside `merge.test.ts` under `src/modules/contacts`,
// because it spawns a nested `bun test` over that file: under the unit suite,
// which selects `src/modules` whole, the parent process runs `merge.test.ts`
// too and the two processes fight over the same fixture. `integration-extra`
// runs in its own process for exactly this reason.
import { afterAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  inheritedFixtureLockEnv,
  releaseAppSchema,
  takeOverAppSchema,
} from "~/tests/helpers/app-schema-fixture"

const TARGET = "src/modules/contacts/merge.test.ts"

// No `acquireAppSchemaLock` here: the child process takes that same Postgres
// advisory lock, so holding it across the spawn would deadlock on ourselves.
afterAll(async () => {
  await releaseAppSchema("app_mail")
})

describe("merge.test.ts owns the app_mail schema it fakes", () => {
  it("stays green when a foreign app_mail.conversations is already installed", async () => {
    await takeOverAppSchema("app_mail")
    await sql.unsafe(`GRANT USAGE ON SCHEMA app_mail TO liaison_rls, liaison_app, liaison_admin`)
    await sql.unsafe(`
        CREATE TABLE app_mail.conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL,
          account_id UUID NOT NULL,
          external_thread_id TEXT NOT NULL,
          contact_id UUID,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON app_mail.conversations TO liaison_rls, liaison_app, liaison_admin`,
    )

    const child = Bun.spawn(["bun", "test", "--timeout", "120000", TARGET], {
      cwd: process.cwd(),
      // The child takes app_mail over too, and the lock this file is holding
      // is the one it would queue on forever. Handing it down keeps the child
      // from acquiring it and, because the lock stays held by this session,
      // keeps the child from reclaiming this file's stash.
      // Only app_mail: this file takes that one over and holds its lock. Declaring
      // app_invoicing too would tell the child to skip an acquire nobody is covering.
      env: { ...process.env, ...inheritedFixtureLockEnv(["app_mail"]) },
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
        `child "bun test ${TARGET}" exited ${code} against a foreign app_mail.conversations\n${err.slice(-2500)}\n${out.slice(-1500)}`,
      )
    }
    expect(code).toBe(0)
  }, 180_000)
})
