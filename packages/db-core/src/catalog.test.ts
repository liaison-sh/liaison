// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  CatalogValidationError,
  extractNamedParams,
  type ReadCatalog,
  toOrdinalSql,
  validateCatalog,
} from "./catalog"

function baseCatalog(overrides: Partial<ReadCatalog["reads"][string]> = {}): ReadCatalog {
  return {
    adapter: "test-adapter",
    reads: {
      org_tier: {
        description: "Org tier lookup by slug",
        domain: "licenses",
        sql: "SELECT tier, slug FROM kernel.organizations WHERE slug = :slug",
        params: { slug: { type: "string" } },
        columns: ["tier", "slug"],
        tables: ["kernel.organizations"],
        ...overrides,
      },
    },
  }
}

describe("validateCatalog", () => {
  test("accepts a well-formed catalog", () => {
    expect(() => validateCatalog(baseCatalog())).not.toThrow()
  })

  test("accepts a WITH ... SELECT (leading CTE)", () => {
    const catalog = baseCatalog({
      sql: "WITH recent AS (SELECT id FROM kernel.organizations WHERE slug = :slug) SELECT id FROM recent",
    })
    expect(() => validateCatalog(catalog)).not.toThrow()
  })

  test("accepts SELECT after leading line and block comments", () => {
    const catalog = baseCatalog({
      sql: "-- tier lookup\n  /* by slug, ** starred */\n/**/SELECT tier, slug FROM kernel.organizations WHERE slug = :slug",
    })
    expect(() => validateCatalog(catalog)).not.toThrow()
  })

  test("rejects a statement whose head hides behind a comment's end inside a literal", () => {
    const catalog = baseCatalog({
      sql: "/* a */ DELETE FROM kernel.organizations WHERE slug = '*/ SELECT' AND slug = :slug",
    })
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("checks the statement head in linear time on stacked comment ends", () => {
    const started = performance.now()
    const catalog = baseCatalog({ sql: `/*${"*//*".repeat(20_000)} :slug` })
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("rejects UPDATE-headed SQL", () => {
    const catalog = baseCatalog({
      sql: "UPDATE kernel.organizations SET tier = 'x' WHERE slug = :slug",
    })
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("rejects a read allow-listing a secret column (credentials_encrypted)", () => {
    const catalog: ReadCatalog = {
      adapter: "test-adapter",
      reads: {
        bad_read: {
          description: "leaks a secret",
          domain: "health",
          sql: "SELECT credentials_encrypted FROM kernel.connected_accounts WHERE org_id = :orgId",
          params: { orgId: { type: "string" } },
          columns: ["credentials_encrypted"],
          tables: ["kernel.connected_accounts"],
        },
      },
    }
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
    try {
      validateCatalog(catalog)
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogValidationError)
      expect((err as CatalogValidationError).message).toContain("secret column")
    }
  })

  test("rejects a read allow-listing kernel.users.password_hash", () => {
    const catalog: ReadCatalog = {
      adapter: "test-adapter",
      reads: {
        bad_read: {
          description: "leaks a secret",
          domain: "moderation",
          sql: "SELECT password_hash FROM kernel.users WHERE id = :userId",
          params: { userId: { type: "string" } },
          columns: ["password_hash"],
          tables: ["kernel.users"],
        },
      },
    }
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("rejects param declared but unused in SQL", () => {
    const catalog = baseCatalog({
      params: { slug: { type: "string" }, unused: { type: "string" } },
    })
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("rejects SQL referencing a param that is not declared", () => {
    const catalog = baseCatalog({
      sql: "SELECT tier FROM kernel.organizations WHERE slug = :slug AND id = :missing",
    })
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("rejects empty columns array", () => {
    const catalog: ReadCatalog = baseCatalog()
    catalog.reads.org_tier.columns = []
    expect(() => validateCatalog(catalog)).toThrow()
  })

  test("rejects multi-statement SQL (bare top-level semicolon)", () => {
    const catalog = baseCatalog({
      sql: "SELECT tier FROM kernel.organizations WHERE slug = :slug; SELECT 1",
    })
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("accepts a semicolon inside a string literal (not multi-statement)", () => {
    const catalog = baseCatalog({
      sql: "SELECT tier FROM kernel.organizations WHERE slug = :slug AND name != 'a;b'",
    })
    expect(() => validateCatalog(catalog)).not.toThrow()
  })
})

describe("validateCatalog — grantColumns (S1 fail-closed grant rendering)", () => {
  test("single-table read with no explicit grantColumns defaults to { [tables[0]]: columns }", () => {
    const validated = validateCatalog(baseCatalog())
    expect(validated.reads.org_tier.grantColumns).toEqual({
      "kernel.organizations": ["tier", "slug"],
    })
  })

  test("a multi-table (joined) read with no grantColumns for one of its tables is rejected", () => {
    const catalog: ReadCatalog = {
      adapter: "test-adapter",
      reads: {
        joined: {
          description: "joined read missing grantColumns",
          domain: "moderation",
          sql: "SELECT t.id FROM app_tickets.tickets t JOIN kernel.contacts c ON c.id = t.contact_id WHERE c.email = :email",
          params: { email: { type: "string" } },
          columns: ["id"],
          tables: ["app_tickets.tickets", "kernel.contacts"],
          // grantColumns omitted entirely — multi-table reads must declare it.
        },
      },
    }
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("a multi-table read declaring grantColumns for only ONE of its two tables is rejected", () => {
    const catalog: ReadCatalog = {
      adapter: "test-adapter",
      reads: {
        joined: {
          description: "joined read, partial grantColumns",
          domain: "moderation",
          sql: "SELECT t.id FROM app_tickets.tickets t JOIN kernel.contacts c ON c.id = t.contact_id WHERE c.email = :email",
          params: { email: { type: "string" } },
          columns: ["id"],
          tables: ["app_tickets.tickets", "kernel.contacts"],
          grantColumns: {
            "app_tickets.tickets": ["id", "contact_id"],
            // kernel.contacts entry missing
          },
        },
      },
    }
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("a result column not present under any table's grantColumns is rejected", () => {
    const catalog: ReadCatalog = {
      adapter: "test-adapter",
      reads: {
        joined: {
          description: "joined read, dangling result column",
          domain: "moderation",
          sql: "SELECT t.id, t.subject FROM app_tickets.tickets t JOIN kernel.contacts c ON c.id = t.contact_id WHERE c.email = :email",
          params: { email: { type: "string" } },
          columns: ["id", "subject"],
          tables: ["app_tickets.tickets", "kernel.contacts"],
          grantColumns: {
            "app_tickets.tickets": ["id", "contact_id"], // missing "subject"
            "kernel.contacts": ["id", "email"],
          },
        },
      },
    }
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("a grantColumns entry naming a SECRET_COLUMNS column is rejected even though it's JOIN/WHERE-only, not in the result projection", () => {
    const catalog: ReadCatalog = {
      adapter: "test-adapter",
      reads: {
        joined: {
          description: "joined read leaking a secret via grantColumns",
          domain: "moderation",
          sql: "SELECT t.id FROM app_tickets.tickets t WHERE t.reply_token = :token",
          params: { token: { type: "string" } },
          columns: ["id"],
          tables: ["app_tickets.tickets"],
          grantColumns: {
            "app_tickets.tickets": ["id", "reply_token"],
          },
        },
      },
    }
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError)
  })

  test("a correctly-declared multi-table read validates and resolves grantColumns as declared", () => {
    const catalog: ReadCatalog = {
      adapter: "test-adapter",
      reads: {
        tickets_by_requester_email: {
          description: "joined read",
          domain: "moderation",
          sql: "SELECT t.id, t.subject FROM app_tickets.tickets t JOIN kernel.contacts c ON c.id = t.contact_id WHERE c.email = :email",
          params: { email: { type: "string" } },
          columns: ["id", "subject"],
          tables: ["app_tickets.tickets", "kernel.contacts"],
          grantColumns: {
            "app_tickets.tickets": ["id", "subject", "contact_id"],
            "kernel.contacts": ["id", "email"],
          },
        },
      },
    }
    const validated = validateCatalog(catalog)
    expect(validated.reads.tickets_by_requester_email.grantColumns).toEqual({
      "app_tickets.tickets": ["id", "subject", "contact_id"],
      "kernel.contacts": ["id", "email"],
    })
  })
})

describe("param binding (named -> ordinal)", () => {
  test("extractNamedParams finds all named params in declaration order", () => {
    const names = extractNamedParams("SELECT * FROM t WHERE a = :foo AND b = :bar")
    expect(names).toEqual(["foo", "bar"])
  })

  test("extractNamedParams dedupes repeated param usage", () => {
    const names = extractNamedParams("SELECT * FROM t WHERE a = :foo OR b = :foo")
    expect(names).toEqual(["foo"])
  })

  test("extractNamedParams ignores :: cast operator", () => {
    const names = extractNamedParams("SELECT a::text FROM t WHERE b = :foo")
    expect(names).toEqual(["foo"])
  })

  test("toOrdinalSql maps named params to ordinal placeholders in order", () => {
    const { text, values } = toOrdinalSql("SELECT * FROM t WHERE a = :foo AND b = :bar", {
      foo: 1,
      bar: "x",
    })
    expect(text).toBe("SELECT * FROM t WHERE a = $1 AND b = $2")
    expect(values).toEqual([1, "x"])
  })

  test("toOrdinalSql maps a repeated named param to the same ordinal at each occurrence", () => {
    const { text, values } = toOrdinalSql("SELECT * FROM t WHERE a = :foo OR b = :foo", {
      foo: 42,
    })
    expect(text).toBe("SELECT * FROM t WHERE a = $1 OR b = $1")
    expect(values).toEqual([42])
  })

  test("toOrdinalSql carries a param's explicit cast to its uncast occurrences", () => {
    const { text, values } = toOrdinalSql(
      "SELECT id FROM t WHERE (:after IS NULL OR (u, id) > (:after::timestamptz, :id)) LIMIT :limit",
      { after: null, id: null, limit: 5 },
    )
    expect(text).toBe(
      "SELECT id FROM t WHERE ($1::timestamptz IS NULL OR (u, id) > ($1::timestamptz, $2)) LIMIT $3",
    )
    expect(values).toEqual([null, null, 5])
  })

  test("toOrdinalSql keeps schema-qualified and array casts, and leaves an already-cast use alone", () => {
    expect(toOrdinalSql("SELECT 1 WHERE :a IS NULL OR x = ANY(:a :: text[])", {}).text).toBe(
      "SELECT 1 WHERE $1::text[] IS NULL OR x = ANY($1 :: text[])",
    )
    expect(toOrdinalSql("SELECT 1 WHERE :a::pg_catalog.int8 > 0 OR :a IS NULL", {}).text).toBe(
      "SELECT 1 WHERE $1::pg_catalog.int8 > 0 OR $1::pg_catalog.int8 IS NULL",
    )
  })

  test("toOrdinalSql adds no cast to a param cast to two different types", () => {
    const { text } = toOrdinalSql("SELECT 1 WHERE :a IS NULL OR :a::int > 0 OR :a::text = 'x'", {})
    expect(text).toBe("SELECT 1 WHERE $1 IS NULL OR $1::int > 0 OR $1::text = 'x'")
  })
})
