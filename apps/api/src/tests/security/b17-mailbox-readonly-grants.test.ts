// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-SEC-2: the readonly database role can never read mail content, mail key
// material, or a wrapped Account Key.
//
// `liaison_readonly` is created BYPASSRLS, so column grants are the ONLY
// control on it. `app_mail.messages` is protected by OMISSION (it receives no
// grant at all), which is why the assertions below are about absence: a
// narrower grant would be a regression, not an improvement.
//
// `kernel.user_key_wraps.wrapped_account_key` is the sharpest edge here. It is
// opaque, but it is also an offline cracking oracle at passphrase KDF speed, so
// handing it to a connector, an export or a log line is a real loss even
// though it is "just ciphertext".

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../../../..")
const GRANTS_PATH = resolve(REPO_ROOT, "apps/api/src/modules/apps/connections/sql/generated/readonly-grants.sql")

const grantsSql = readFileSync(GRANTS_PATH, "utf8")

interface SelectGrant {
  table: string
  columns: string[]
}

/** Every `GRANT SELECT (cols) ON schema.table TO liaison_readonly;` line. */
function parseSelectGrants(sql: string): SelectGrant[] {
  const re = /GRANT SELECT \(([^)]*)\) ON ([\w.]+) TO liaison_readonly;/g
  const grants: SelectGrant[] = []
  for (const m of sql.matchAll(re)) {
    grants.push({
      table: (m[2] as string).toLowerCase(),
      columns: (m[1] as string).split(",").map((c) => c.trim().toLowerCase()),
    })
  }
  return grants
}

const selectGrants = parseSelectGrants(grantsSql)
const allGrantedColumns = selectGrants.flatMap((g) => g.columns)

describe("T-SEC-2: readonly grants withhold mail content and key material", () => {
  test("the grants file was found, is non-empty, and actually parsed", () => {
    // Non-vacuity. Every assertion below is an absence, so a mistyped path or a
    // regex that matched nothing would report a clean bill of health on an
    // empty string.
    expect(grantsSql.length).toBeGreaterThan(500)
    expect(grantsSql).toContain("liaison_readonly")
    expect(selectGrants.length).toBeGreaterThanOrEqual(5)
    expect(allGrantedColumns.length).toBeGreaterThanOrEqual(20)
    // A positive control: a grant we EXPECT to exist. If this stops matching,
    // the parser broke and the negative assertions are worthless.
    const orgs = selectGrants.find((g) => g.table === "kernel.organizations")
    expect(orgs?.columns).toContain("slug")
  })

  test("the checked-in grants file is in sync with the catalog", async () => {
    const proc = Bun.spawn(["bun", "run", "scripts/db-readonly-role.ts", "--check-sync"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    const stdout = await new Response(proc.stdout).text()
    expect(`${stdout}${stderr}`.length).toBeGreaterThan(0)
    expect(exitCode).toBe(0)
  })

  test("app_mail.messages receives no grant at all", () => {
    expect(selectGrants.some((g) => g.table === "app_mail.messages")).toBe(false)
    expect(grantsSql).not.toContain("app_mail.messages")
  })

  test("app_mail.conversations does not grant subject", () => {
    const conversations = selectGrants.find((g) => g.table === "app_mail.conversations")
    // Positive control: the table IS still granted, so the absence below is
    // about the column, not about the table having vanished.
    expect(conversations).toBeDefined()
    expect(conversations?.columns).toContain("from_email")
    expect(conversations?.columns).not.toContain("subject")
    expect(conversations?.columns).not.toContain("snippet")
  })

  test("no ciphertext, content key, envelope or nonce column is granted anywhere", () => {
    const forbidden = allGrantedColumns.filter((c) =>
      /_ciphertext$|^content_key_|^enc_|^nonce_prefix$/.test(c),
    )
    expect(forbidden).toEqual([])
  })

  test("the mailbox key tables are never mentioned in the grants file", () => {
    expect(grantsSql).not.toContain("kernel.user_key_wraps")
    expect(grantsSql).not.toContain("kernel.user_mailbox_identities")
    expect(grantsSql).not.toContain("wrapped_account_key")
    // Migration 0041 added the wrapped identity private halves. They are
    // ciphertext under an Account Key the readonly role can never hold, but the
    // rule for mailbox key material is reach, not crackability: an operator
    // tool that can read a keyring is a step no design here grants.
    expect(grantsSql).not.toContain("wrapped_ecdh_private")
    expect(grantsSql).not.toContain("wrapped_sign_private")
    expect(grantsSql).not.toContain("ecdh_wrap_iv")
    expect(grantsSql).not.toContain("sign_wrap_iv")
    expect(grantsSql).not.toContain("kernel.mailbox_client_jobs")
    expect(grantsSql).not.toContain("kernel.mailbox_migration_state")
  })
})
