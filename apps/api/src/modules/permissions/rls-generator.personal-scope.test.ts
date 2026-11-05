// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { generateRlsPolicySql } from "~/modules/permissions/rls-generator"

const dims = {
  inbox: { type: "membership" as const, column: "accountId" },
}

describe("generateRlsPolicySql personalScope", () => {
  it("emits a SECURITY DEFINER owner-lookup helper for the via form", () => {
    const sql = generateRlsPolicySql(
      "app_mail",
      "conversations",
      dims as any,
      "mail",
      "conversations",
      { accountId: "uuid", ownerType: "string", ownerId: "uuid?" },
      undefined,
      { via: { table: "accounts", localColumn: "accountId" } },
    )
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "app_mail"."accounts_personal_owner"')
    expect(sql).toContain("SECURITY DEFINER")
    // The function body must stay semicolon-free (callers split on ';').
    const body = sql.split("$$")[1] ?? ""
    expect(body.includes(";")).toBe(false)
  })

  it("appends the owner-only condition to every policy, keyed on the local column", () => {
    const sql = generateRlsPolicySql(
      "app_mail",
      "conversations",
      dims as any,
      "mail",
      "conversations",
      { accountId: "uuid", ownerType: "string", ownerId: "uuid?" },
      undefined,
      { via: { table: "accounts", localColumn: "accountId" } },
    )
    const cond = '"app_mail"."accounts_personal_owner"("account_id")'
    // select + insert + update USING + update WITH CHECK + delete: at least 4 policies carry it.
    const occurrences = sql.split(cond).length - 1
    expect(occurrences).toBeGreaterThanOrEqual(8) // two references per condition, 4+ policies
    // System-context exemption: empty or NIL-uuid user GUC pierces (sync jobs).
    expect(sql).toContain("00000000-0000-0000-0000-000000000000")
  })

  it("casts a text via column to uuid behind a format guard, and leaves a uuid column bare", () => {
    const textSql = generateRlsPolicySql(
      "app_calendar",
      "events",
      { calaccess: { type: "membership" as const } } as any,
      "calendar",
      "events",
      { calendarId: "uuid", calaccess: "string" },
      undefined,
      { via: { table: "accounts", localColumn: "calaccess" } },
    )
    expect(textSql).toContain(
      `"app_calendar"."accounts_personal_owner"((CASE WHEN "calaccess" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "calaccess"::uuid END))`,
    )
    const uuidSql = generateRlsPolicySql(
      "app_mail",
      "conversations",
      dims as any,
      "mail",
      "conversations",
      { accountId: "uuid", ownerType: "string", ownerId: "uuid?" },
      undefined,
      { via: { table: "accounts", localColumn: "accountId" } },
    )
    expect(uuidSql).toContain(`"app_mail"."accounts_personal_owner"("account_id")`)
    expect(uuidSql).not.toContain("::uuid END")
  })

  it("self form keys the condition on the table's own id", () => {
    const sql = generateRlsPolicySql(
      "app_mail",
      "accounts",
      dims as any,
      "mail",
      "accounts",
      { ownerType: "string", ownerId: "uuid?", visibility: "string?" },
      undefined,
      {},
    )
    expect(sql).toContain('"app_mail"."accounts_personal_owner"("id")')
  })

  it("omits the condition entirely without a personalScope declaration", () => {
    const sql = generateRlsPolicySql(
      "app_mail",
      "conversations",
      dims as any,
      "mail",
      "conversations",
      { accountId: "uuid", ownerType: "string", ownerId: "uuid?" },
    )
    expect(sql).not.toContain("personal_owner")
  })
})
