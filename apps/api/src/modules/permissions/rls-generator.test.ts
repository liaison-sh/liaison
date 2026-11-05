// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  assertRlsManagementAllowed,
  forceRlsStatements,
  generateRequiredScopesVisibilityClause,
  generateRlsPolicySql,
  migrationGovernedTables,
  rlsScopeEntityForTable,
  scopeEntityReachableByGrant,
  tablesUnreachableByGrantableScopes,
  withSublinkReaders,
} from "~/modules/permissions/rls-generator"

describe("RLS policy generator", () => {
  it("generates membership dimension policy", () => {
    const sql = generateRlsPolicySql("app_test", "items", {
      team: { type: "membership" },
    })
    expect(sql).toContain("CREATE POLICY")
    expect(sql).toContain('"app_test"."items"')
    expect(sql).toContain("rls_ctx.dimensions()")
    expect(sql).toContain('"team"')
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY")
  })

  it("membership dimension treats a NULL/unset row value as unclassified (visible+writable), not wildcard-only", () => {
    // BL-91 regression: without an `IS NULL` branch, a row whose membership column is NULL
    // (e.g. a ticket created with no team) fails `NULL = ANY(grants)` → NULL (not TRUE), so it
    // is silently inaccessible to a SCOPED grant holder — `tickets:create` with no team threw a
    // 42501 RLS WITH CHECK violation for a support agent holding a scoped tickets:team grant.
    // An unclassified (NULL) row belongs to no team and must be reachable by any grant on this
    // dimension; an explicitly-classified row still requires the matching grant (unchanged).
    const sql = generateRlsPolicySql("app_test", "items", {
      team: { type: "membership" },
    })
    expect(sql).toContain('"team" IS NULL')
    // The explicit-value branch must still be present (a classified row needs the grant).
    expect(sql).toContain('"team" = ANY(')
  })

  it("generates level dimension policy with ordered comparison", () => {
    const sql = generateRlsPolicySql("app_test", "items", {
      sensitivity: { type: "level", order: ["public", "internal", "confidential"] },
    })
    expect(sql).toContain('"sensitivity"')
    expect(sql).toContain("CASE")
    // Verify specific CASE ordering: public=0, internal=1, confidential=2
    expect(sql).toContain("WHEN 'public' THEN 0")
    expect(sql).toContain("WHEN 'internal' THEN 1")
    expect(sql).toContain("WHEN 'confidential' THEN 2")
  })

  it("level dimension treats a NULL/unset row level as the lowest band (visible), not admin-only", () => {
    // Regression: without COALESCE, `CASE NULL … END` → NULL and `NULL <= grant` is false, so a row
    // created without an explicit level (e.g. a connected mail account — onAccountConnected sets no
    // sensitivity) is silently invisible to every non-`*` user. The row-side comparison must COALESCE
    // the unclassified level to 0 (the lowest band) so unclassified rows are visible to any grant.
    const sql = generateRlsPolicySql("app_test", "items", {
      sensitivity: { type: "level", order: ["public", "internal", "confidential"] },
    })
    // The ROW's level expression must be COALESCE'd to 0.
    expect(sql).toContain("COALESCE(CASE")
    expect(sql).toContain("END, 0) <=")
  })

  it("level dimension treats a viewer with NO grants under the key as lowest-band clearance", () => {
    // Regression: with dimensions `{}` (every plain member role without an explicit
    // sensitivity grant), `jsonb_array_elements_text(NULL)` yields zero rows, MAX() is
    // NULL, and `0 <= NULL` is not TRUE — so scope-holding members lost EVERY row,
    // including lowest-band tickets assigned to them. The GRANT-side MAX must be
    // COALESCE'd to 0 so missing grants mean lowest-band clearance, while every band
    // above the lowest still requires an explicit grant.
    const sql = generateRlsPolicySql("app_test", "items", {
      sensitivity: { type: "level", order: ["public", "internal", "confidential"] },
    })
    expect(sql).toContain("END, 0) <= COALESCE((")
    expect(sql).toContain("), 0)")
  })

  it("generates multi-dimension policy with AND conditions", () => {
    const sql = generateRlsPolicySql("app_test", "items", {
      team: { type: "membership" },
      sensitivity: { type: "level", order: ["public", "internal", "confidential"] },
    })
    expect(sql).toContain('"team"')
    expect(sql).toContain('"sensitivity"')
    expect(sql).toContain("AND")
  })

  it("includes org_id check", () => {
    const sql = generateRlsPolicySql("app_test", "items", {
      team: { type: "membership" },
    })
    expect(sql).toContain("org_id")
    expect(sql).toContain("rls_ctx.org_id()")
  })

  it("generates valid SQL (no syntax errors)", () => {
    const sql = generateRlsPolicySql("app_test", "items", {
      team: { type: "membership" },
    })
    // Basic syntax checks
    expect(sql).toContain("FOR SELECT")
    expect(sql).toContain("USING")
  })

  // internalWriteScope (social set_triage/dismiss_finding 0-row-no-error RLS class). A table whose UNGATED
  // internal-mutation tools are scoped on a DIFFERENT family than its rlsScope (social `finding`: rlsScope
  // `findings`, but set_triage/dismiss_finding are `social:internal`) must let an internal-scope-only
  // context WRITE — else the UPDATE is silently RLS-denied (0 rows, no error) and the handler reports
  // success on a write that never landed (the autonomous-triage-routine FAIL: every finding left
  // status='new'). The WRITE policies (UPDATE/INSERT/DELETE) must accept the declared internalWriteScope;
  // the READ policy must NOT (read stays gated on the rlsScope read scope).
  it("WRITE policies accept the declared internalWriteScope; READ does not (the social triage RLS fix)", () => {
    const sql = generateRlsPolicySql(
      "social",
      "finding",
      {},
      "social",
      "findings", // rlsScope alias
      { status: "string", triage_category: "string" },
      "social:internal", // internalWriteScope
    )
    // Split into the four per-op policies so we can assert per-operation.
    const updateIdx = sql.indexOf("FOR UPDATE")
    const deleteIdx = sql.indexOf("FOR DELETE")
    const insertIdx = sql.indexOf("FOR INSERT")
    const selectIdx = sql.indexOf("FOR SELECT")
    const selectPolicy = sql.slice(selectIdx, insertIdx)
    const insertPolicy = sql.slice(insertIdx, updateIdx)
    const updatePolicy = sql.slice(updateIdx, deleteIdx)
    const deletePolicy = sql.slice(deleteIdx)
    // The internal scope is an accepted grant on every WRITE policy.
    expect(updatePolicy).toContain("g = 'social:internal'")
    expect(insertPolicy).toContain("g = 'social:internal'")
    expect(deletePolicy).toContain("g = 'social:internal'")
    // The standard findings:write grant still works (it is not REPLACED, only ADDED to).
    expect(updatePolicy).toContain("g = 'social:findings:write'")
    // The READ policy must NOT accept the internal write scope (read stays gated on findings:read).
    expect(selectPolicy).not.toContain("g = 'social:internal'")
    expect(selectPolicy).toContain("g = 'social:findings:read'")
  })

  it("without internalWriteScope, the WRITE policy does NOT accept an unrelated internal scope (no widening)", () => {
    // Fails-without proof: a table that does NOT declare internalWriteScope keeps the strict write policy —
    // the internal scope is NOT silently accepted, so the fix is opt-in per table.
    const sql = generateRlsPolicySql("social", "finding", {}, "social", "findings", {
      status: "string",
    })
    expect(sql).not.toContain("g = 'social:internal'")
  })

  it("dimension keys with SQL-special characters are safe", () => {
    const policySql = generateRlsPolicySql("app_test", "items", {
      "team'; DROP TABLE users;--": { type: "membership" },
    })
    // Single quotes in string literals are properly escaped (doubled)
    expect(policySql).toContain("team''; DROP TABLE users;--")
    // The key is identifier-quoted in column references
    expect(policySql).toContain('"team\'; DROP TABLE users;--"')
  })

  it("dimension keys with quotes are properly escaped", () => {
    const policySql = generateRlsPolicySql("app_test", "items", {
      'te"am': { type: "membership" },
    })
    // Verify proper identifier escaping (double quotes doubled)
    expect(policySql).toContain('"te""am"')
  })

  describe("scope enforcement", () => {
    it("adds scope check when appName and entityName are provided", () => {
      const sql = generateRlsPolicySql("app_crm", "contacts", {}, "crm", "contacts")
      // Should check for entity-level scope
      expect(sql).toContain("crm:contacts")
      // Should check for app-level wildcard scope
      expect(sql).toContain("crm:*")
      // Should allow unrestricted '*' scope
      expect(sql).toContain("(SELECT rls_ctx.scopes()) = '*'")
      // Should use array-based exact/prefix matching (not substring position)
      expect(sql).toContain("unnest(string_to_array(")
      expect(sql).not.toContain("position(")
    })

    it("omits scope check when appName is not provided (backward compat)", () => {
      const sql = generateRlsPolicySql("app_test", "items", {})
      // Without appName/entityName, no scope condition is generated
      expect(sql).not.toContain("rls_ctx.scopes()")
    })

    it("escapes SQL-special characters in app and entity names", () => {
      const sql = generateRlsPolicySql("app_evil", "items", {}, "evil'app", "it'ems")
      // Single quotes should be doubled for SQL literal safety
      expect(sql).toContain("evil''app:it''ems")
      expect(sql).toContain("evil''app:*")
    })

    it("includes scope check in all four policy types", () => {
      const sql = generateRlsPolicySql("app_crm", "contacts", {}, "crm", "contacts")
      // Each of the 4 policies (SELECT, INSERT, UPDATE, DELETE) should contain scope check.
      // UPDATE has it twice (USING + WITH CHECK), so 5 occurrences total.
      const matches = sql.match(/crm:\*/g)
      expect(matches?.length).toBe(5)
    })

    it("combines scope check with org_id and dimension conditions", () => {
      const sql = generateRlsPolicySql(
        "app_crm",
        "contacts",
        { team: { type: "membership" } },
        "crm",
        "contacts",
      )
      // All three condition types should be present
      expect(sql).toContain("rls_ctx.org_id()")
      expect(sql).toContain("rls_ctx.scopes()")
      expect(sql).toContain("rls_ctx.dimensions()")
    })
  })

  it("generated policies read the request context only through the rls_ctx readers", () => {
    const policySql = generateRlsPolicySql(
      "app_test",
      "items",
      { region: { type: "membership" } },
      "test",
      "items",
    )
    // The variables themselves can be set by SQL inside the transaction; the
    // readers return what withRlsContext verified (migrations 0184-0186).
    expect(policySql.match(/current_setting\([^)]+\)/g) ?? []).toEqual([])
    expect(policySql).toContain("rls_ctx.scopes()")
    expect(policySql).toContain("rls_ctx.dimensions()")
  })

  describe("self-referencing membership and ownership OR-composition", () => {
    it("generates standard membership dimension condition when column exists", () => {
      const sql = generateRlsPolicySql(
        "app_test",
        "items",
        {
          team: { type: "membership" },
        },
        "test",
        "items",
        { team: "uuid", title: "string" },
      )
      expect(sql).toContain('"team"')
      expect(sql).toContain("ANY")
    })

    it("infers self-referencing membership when dimension key has no matching column in entity fields", () => {
      const sql = generateRlsPolicySql(
        "app_mail",
        "accounts",
        {
          inbox: { type: "membership" },
        },
        "mail",
        "accounts",
        {
          emailAddress: "string",
          ownerType: "string",
          ownerId: "uuid?",
        },
      )
      expect(sql).toContain("id = ANY")
      expect(sql).not.toMatch(/"inbox" = ANY/)
    })

    it("infers ownership OR-composition when entity has ownerType + ownerId fields", () => {
      const sql = generateRlsPolicySql(
        "app_mail",
        "accounts",
        {
          inbox: { type: "membership" },
        },
        "mail",
        "accounts",
        {
          emailAddress: "string",
          ownerType: "string",
          ownerId: "uuid?",
        },
      )
      expect(sql).toContain("owner_type")
      expect(sql).toContain("owner_id")
      expect(sql).toContain("OR")
      expect(sql).toContain("nullif((SELECT rls_ctx.user_id()), '')::uuid")
      expect(sql).toMatch(
        /owner_type = 'user'[\s\S]+?OR[\s\S]+?rls_ctx\.dimensions\(\)::jsonb\)->'mail:inbox'/,
      )
      expect(sql).not.toContain("mail:mail:inbox")
    })

    it("uses canonical full dimension keys in current_dimensions checks", () => {
      const sql = generateRlsPolicySql(
        "app_mail",
        "accounts",
        {
          inbox: { type: "membership" },
        },
        "mail",
        "accounts",
        {
          emailAddress: "string",
          ownerType: "string",
          ownerId: "uuid?",
        },
      )

      expect(sql).toContain("rls_ctx.dimensions()::jsonb)->'mail:inbox'")
      expect(sql).not.toContain("rls_ctx.dimensions()::jsonb)->'inbox'")
    })

    it("INSERT policy uses only org_id + scope check (no dimension/ownership)", () => {
      const sql = generateRlsPolicySql(
        "app_mail",
        "accounts",
        {
          inbox: { type: "membership" },
        },
        "mail",
        "accounts",
        {
          emailAddress: "string",
          ownerType: "string",
          ownerId: "uuid?",
        },
      )
      const insertPolicy = sql.split("FOR INSERT")[1]?.split("FOR UPDATE")[0] ?? ""
      expect(insertPolicy).toContain("org_id")
      expect(insertPolicy).not.toContain("owner_type")
      expect(insertPolicy).not.toContain("inbox")
    })

    it("entity without ownerType/ownerId uses AND-composition (no OR block)", () => {
      const sql = generateRlsPolicySql(
        "app_test",
        "items",
        {
          team: { type: "membership" },
        },
        "test",
        "items",
        { team: "uuid", title: "string" },
      )
      expect(sql).not.toContain("owner_type")
      expect(sql).not.toContain("owner_id")
      expect(sql).not.toContain("rls_ctx.user_id()")
    })
  })

  describe("logical RLS scope-entity (rlsScope alias)", () => {
    it("gates a table on its LOGICAL scope-entity, not its physical table name", () => {
      // `issuer_profiles` physical table aliased to the `settings` scope-entity:
      // the generated SQL must accept `invoicing:settings*` grants and must NOT
      // mention the physical table name in the scope check.
      const sql = generateRlsPolicySql(
        "app_invoicing",
        "issuer_profiles",
        {},
        "invoicing",
        "settings",
      )
      expect(sql).toContain("invoicing:settings")
      expect(sql).toContain("invoicing:settings:read")
      expect(sql).toContain("invoicing:settings:write")
      expect(sql).not.toContain("invoicing:issuer_profiles")
    })

    it("rlsScopeEntityForTable returns the alias when set, else the table name", () => {
      expect(rlsScopeEntityForTable("document_lines", { rlsScope: "documents" })).toBe("documents")
      expect(rlsScopeEntityForTable("issuer_profiles", { rlsScope: "settings" })).toBe("settings")
      expect(rlsScopeEntityForTable("documents", {})).toBe("documents")
      expect(rlsScopeEntityForTable("documents", undefined)).toBe("documents")
      // Empty / non-string rlsScope falls back to the table name.
      expect(rlsScopeEntityForTable("documents", { rlsScope: "" })).toBe("documents")
      expect(rlsScopeEntityForTable("documents", { rlsScope: 42 })).toBe("documents")
    })

    it("scopeEntityReachableByGrant matches exactly the accepted-grant set", () => {
      const reach = (g: string) => scopeEntityReachableByGrant("invoicing", "settings", g)
      // Accepted forms
      expect(reach("*")).toBe(true)
      expect(reach("invoicing")).toBe(true)
      expect(reach("invoicing:*")).toBe(true)
      expect(reach("invoicing:settings")).toBe(true)
      expect(reach("invoicing:settings:read")).toBe(true)
      expect(reach("invoicing:settings:write")).toBe(true)
      // Rejected forms (the bug: a sibling logical scope must NOT grant access)
      expect(reach("invoicing:documents")).toBe(false)
      expect(reach("invoicing:documents:write")).toBe(false)
      expect(reach("invoicing:issuer_profiles")).toBe(false)
      expect(reach("other:*")).toBe(false)
      expect(reach("invoicing:settings:admin")).toBe(false)
    })

    it("tablesUnreachableByGrantableScopes flags tables no grant can reach", () => {
      // The pre-fix invoicing shape: physical tables, only logical grantable scopes.
      const grantable = [
        "invoicing:documents:read",
        "invoicing:documents:write",
        "invoicing:settings:read",
        "invoicing:settings:write",
        "invoicing:internal",
      ]
      const brokenSchema = {
        documents: {}, // reachable (table name == logical scope)
        document_lines: {}, // UNREACHABLE without an alias
        issuer_profiles: {}, // UNREACHABLE without an alias
        webhook_deliveries: {}, // UNREACHABLE without an alias
      }
      expect(
        tablesUnreachableByGrantableScopes("invoicing", brokenSchema, grantable).sort(),
      ).toEqual(["document_lines", "issuer_profiles", "webhook_deliveries"])
      // Aliasing each physical table onto a grantable logical scope fixes it.
      const fixedSchema = {
        documents: {},
        document_lines: { rlsScope: "documents" },
        issuer_profiles: { rlsScope: "settings" },
        webhook_deliveries: { rlsScope: "internal" },
      }
      expect(tablesUnreachableByGrantableScopes("invoicing", fixedSchema, grantable)).toEqual([])
    })

    it("leaves migration-governed tables to the registration's policy check", () => {
      // mail drafts: owner-only access granted by a migration policy, no
      // scope alias (an alias would widen it to every inbox reader).
      const schema = {
        conversations: {},
        drafts: { rlsGovernedByMigration: true },
        notes: {},
      }
      const grantable = ["mail:conversations:read", "mail:conversations:write"]
      expect(tablesUnreachableByGrantableScopes("mail", schema, grantable)).toEqual(["notes"])
      expect(migrationGovernedTables(schema)).toEqual(["drafts"])
      // An app whose RLS is wholly migration-managed generates no policy, so
      // every one of its tables is judged on its migration policies.
      expect(
        tablesUnreachableByGrantableScopes("knowledge", { tags: {}, collections: {} }, [], {
          rlsManagedBy: "migration",
        }),
      ).toEqual([])
      expect(
        migrationGovernedTables({ tags: {}, collections: {} }, { rlsManagedBy: "migration" }),
      ).toEqual(["tags", "collections"])
      // Only a literal `true` marks a table.
      expect(migrationGovernedTables({ t: { rlsGovernedByMigration: "yes" } })).toEqual([])
    })
  })

  describe("requiredScopesVisibility", () => {
    const visibility = {
      requiredScopesColumn: "required_scopes",
      disclosureListColumn: "disclosure_list",
    }
    const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
    const withVisibility = () =>
      generateRlsPolicySql(
        "kernel",
        "messages",
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        visibility,
      )
    const policy = (sql: string, verb: string) =>
      sql.split(`FOR ${verb}`)[1]?.split("CREATE POLICY")[0] ?? ""

    it("emits a requiredScopesVisibility OR clause containing the array-containment operator", () => {
      const sql = withVisibility()
      const select = policy(sql, "SELECT")
      // Containment is element-wise through hasScope rules, not a bare `<@`: every
      // required element must be covered by some grant.
      expect(select).toContain('unnest("required_scopes")')
      expect(select).toContain('"disclosure_list"')
      expect(select).toContain("rls_ctx.scopes()")
      expect(select).toContain("rls_ctx.user_id()")
      expect(select).toMatch(/\)\s*OR COALESCE\(/)
      expect(select).toContain(
        withSublinkReaders(generateRequiredScopesVisibilityClause(visibility)),
      )
    })

    it("omits the requiredScopesVisibility clause when the option is not passed", () => {
      // Pinned digests of the generator output without the option (org and user read through rls_ctx).
      expect(
        sha256(generateRlsPolicySql("app_test", "items", { team: { type: "membership" } })),
      ).toBe("ed3e7455bb4abed49d68ca7539c08729abec01afcc79db5636a4a4d551b5b25d")
      expect(
        sha256(
          generateRlsPolicySql(
            "app_mail",
            "conversations",
            { inbox: { type: "membership", column: "accountId" } } as any,
            "mail",
            "conversations",
            { accountId: "uuid", ownerType: "string", ownerId: "uuid?" },
            "mail:internal",
            { via: { table: "accounts", localColumn: "accountId" } },
          ),
        ),
      ).toBe("4974a320464f667781ae7ad751251541fa55934274831ddfea2955429e3f4863")
    })

    it("gates only the SELECT policy and ANDs the clause with the org condition", () => {
      const sql = withVisibility()
      const clause = withSublinkReaders(generateRequiredScopesVisibilityClause(visibility))
      expect(policy(sql, "SELECT")).toContain(`rls_ctx.org_id()), '')::uuid\n    AND ${clause}`)
      expect(policy(sql, "INSERT")).not.toContain("required_scopes")
      expect(policy(sql, "UPDATE")).not.toContain("required_scopes")
      expect(policy(sql, "DELETE")).not.toContain("required_scopes")
    })

    it("mirrors hasScope inline: no app_has_scope, no bare-* shortcut, JS-compatible split", () => {
      const clause = generateRequiredScopesVisibilityClause(visibility)
      expect(clause).not.toContain("app_has_scope")
      // A GUC of '*' must not bypass the empty-string and null required-scope checks.
      expect(clause).not.toContain("rls_ctx.scopes() = '*'")
      // string_to_array('', ':') is '{}' while ''.split(':') is [''].
      expect(clause).toContain("regexp_split_to_array(")
      expect(clause).toContain("'__none__'")
      // Callers split generated SQL on ';'.
      expect(clause.includes(";")).toBe(false)
      const matches = clause.match(/current_setting\([^)]+\)/g) ?? []
      for (const match of matches) expect(match).toContain(", true)")
    })

    it("quotes and snake-cases the column names", () => {
      const clause = generateRequiredScopesVisibilityClause({
        requiredScopesColumn: "requiredScopes",
        disclosureListColumn: 'odd"name',
      })
      expect(clause).toContain('unnest("required_scopes")')
      expect(clause).toContain('"odd""name"')
    })
  })
})

describe("FORCE row-level security on app-defined tables", () => {
  it("every generated policy set enables AND forces RLS on its table", () => {
    const sql = generateRlsPolicySql("app_x", "things", {}, "x", "things", { id: "uuid" })
    expect(sql).toContain('ALTER TABLE "app_x"."things" ENABLE ROW LEVEL SECURITY;')
    expect(sql).toContain('ALTER TABLE "app_x"."things" FORCE ROW LEVEL SECURITY;')
  })

  it("the statements a migration-managed table gets are the same two, quoted", () => {
    expect(forceRlsStatements("app_x", 'od"d')).toEqual([
      'ALTER TABLE "app_x"."od""d" ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE "app_x"."od""d" FORCE ROW LEVEL SECURITY;',
    ])
  })

  it("an installed third-party package cannot claim rlsManagedBy migration", () => {
    expect(() =>
      assertRlsManagementAllowed({ name: "evil", rlsManagedBy: "migration", _installed: true }),
    ).toThrow(/cannot declare rlsManagedBy/)
    // First-party installs, in-tree apps and ordinary apps are unaffected.
    expect(() =>
      assertRlsManagementAllowed({
        rlsManagedBy: "migration",
        _installed: true,
        _firstParty: true,
      }),
    ).not.toThrow()
    expect(() => assertRlsManagementAllowed({ rlsManagedBy: "migration" })).not.toThrow()
    expect(() => assertRlsManagementAllowed({ _installed: true })).not.toThrow()
  })
})
