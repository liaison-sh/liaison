// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0009 once backfilled the default-for-create inbox with one deployment's own
// identity (a hardcoded from-name and reply-to address), so any database that
// held a default inbox when 0009 ran was stamped with another company's
// address. The statement is now DDL only. Already-migrated databases
// are untouched: drizzle skips 0009 by its `when`, it never re-hashes the file.
//
// The replay below runs every statement of the real file except its column
// DDL (which already exists on the migrated test database) against a seeded
// default inbox with no identity, inside a transaction that is rolled back.

import { afterAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import postgres from "postgres"

const MIGRATIONS_DIR = new URL(".", import.meta.url).pathname
const FILE_0009 = `${MIGRATIONS_DIR}0009_inbox_email_identity.sql`

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

/** Statements of a migration file, comments stripped, split on drizzle breakpoints. */
function statements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
}

const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await sql.end()
})

class Rollback extends Error {}

describe("0009_inbox_email_identity", () => {
  it("leaves a default inbox without an identity untouched: no stamped from-name or reply-to", async () => {
    const replayable = statements(FILE_0009).filter((s) => !/^ALTER TABLE .* ADD COLUMN/i.test(s))
    let after: { from_display_name: string | null; reply_to_email: string | null } | undefined

    await sql
      .begin(async (tx) => {
        const slug = `m0009-${crypto.randomUUID()}`
        const [org] = await tx`
          INSERT INTO kernel.organizations (name, slug) VALUES ('Acme 0009', ${slug}) RETURNING id`
        const [user] = await tx`
          INSERT INTO kernel.users (org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (${org!.id}, ${`${slug}@acme.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`
        const [account] = await tx`
          INSERT INTO kernel.connected_accounts
            (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
          VALUES (${org!.id}, 'tickets', 'gmail', 'org', null, 'oauth2', 'help@acme.test', 'active', ${user!.id}, 'enc')
          RETURNING id`
        const [inbox] = await tx`
          INSERT INTO app_tickets.inboxes
            (org_id, kind, connected_account_id, name, email_address, is_default_for_create)
          VALUES (${org!.id}, 'mailbox', ${account!.id}, 'Help', 'help@acme.test', true)
          RETURNING id`

        for (const stmt of replayable) await tx.unsafe(stmt)

        const [row] = await tx`
          SELECT from_display_name, reply_to_email FROM app_tickets.inboxes WHERE id = ${inbox!.id}`
        after = row as typeof after
        throw new Rollback()
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err
      })

    expect(after).toEqual({ from_display_name: null, reply_to_email: null })
  })

  it("no migration stamps a literal from-name or reply-to address onto inboxes", () => {
    const offenders: string[] = []
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      for (const stmt of statements(`${MIGRATIONS_DIR}${file}`)) {
        if (
          /\b(?:from_display_name|reply_to_email)\s*=\s*(?:coalesce\([^,]*,\s*)?'[^']+'/i.test(stmt)
        ) {
          offenders.push(file)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
