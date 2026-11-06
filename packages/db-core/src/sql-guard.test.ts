// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { assertReadOnlySelect, MAX_RAW_SQL_CHARS, SqlGuardError } from "./sql-guard"

function expectAccept(sql: string) {
  expect(() => assertReadOnlySelect(sql)).not.toThrow()
}

function expectReject(sql: string, code?: string) {
  try {
    assertReadOnlySelect(sql)
    throw new Error(`expected rejection for: ${sql}`)
  } catch (err) {
    expect(err).toBeInstanceOf(SqlGuardError)
    if (code) expect((err as SqlGuardError).code).toBe(code)
  }
}

describe("assertReadOnlySelect — accept", () => {
  test("plain SELECT", () => expectAccept("SELECT 1"))
  test("WITH ... SELECT", () => expectAccept("WITH x AS (SELECT 1 AS a) SELECT a FROM x"))
  test("lowercase select", () => expectAccept("select 1"))
  test("comment-prefixed select", () => expectAccept("-- a comment\nSELECT 1"))
  test("semicolon inside a string literal", () => expectAccept("SELECT 'a;b' AS val"))
  test("dollar-quoted string containing a semicolon", () => expectAccept("SELECT $$a;b$$ AS val"))
  test("trailing semicolon with nothing after it", () => expectAccept("SELECT 1;"))
  test("column named pg_sleep_at is not rejected (not a call)", () =>
    expectAccept("SELECT pg_sleep_at FROM some_table"))
})

describe("assertReadOnlySelect — reject", () => {
  test("INSERT", () => expectReject("INSERT INTO t VALUES (1)", "write_head"))
  test("CTE-write bypass: WITH d AS (DELETE ... RETURNING *) SELECT * FROM d", () =>
    expectReject("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "cte_write"))
  test("multi-statement: SELECT 1; DROP TABLE x", () =>
    expectReject("SELECT 1; DROP TABLE x", "multi_statement"))
  test("SELECT ... FOR UPDATE", () => expectReject("SELECT * FROM t FOR UPDATE", "locking_clause"))
  test("SELECT ... FOR SHARE", () => expectReject("SELECT * FROM t FOR SHARE", "locking_clause"))
  test("EXPLAIN ANALYZE SELECT", () => expectReject("EXPLAIN ANALYZE SELECT 1", "explain_analyze"))
  test("EXPLAIN (ANALYZE) SELECT — parenthesized option form", () =>
    expectReject("EXPLAIN (ANALYZE) SELECT 1", "explain_analyze"))
  test("COPY (SELECT ...) TO STDOUT", () => expectReject("COPY (SELECT 1) TO STDOUT", "write_head"))
  test("SELECT pg_sleep(30)", () => expectReject("SELECT pg_sleep(30)", "dangerous_function"))
  test("SELECT dblink(...)", () =>
    expectReject("SELECT dblink('conn', 'select 1')", "dangerous_function"))
  test("SELECT pg_read_file(...)", () =>
    expectReject("SELECT pg_read_file('/etc/passwd')", "dangerous_function"))
  test("SELECT ... INTO", () => expectReject("SELECT * INTO new_table FROM t", "select_into"))
  test("dangerous function nested inside a subquery", () =>
    expectReject("SELECT * FROM (SELECT pg_sleep(5)) x", "dangerous_function"))
  test("dangerous function nested inside a CTE", () =>
    expectReject("WITH x AS (SELECT pg_sleep(5)) SELECT * FROM x", "dangerous_function"))
  test("UPDATE", () => expectReject("UPDATE t SET a = 1", "write_head"))
  test("DELETE", () => expectReject("DELETE FROM t", "write_head"))
  test("DROP TABLE", () => expectReject("DROP TABLE t", "write_head"))

  test("each rejection has a distinct, non-leaky error message", () => {
    const messages = new Set<string>()
    const cases = [
      "INSERT INTO t VALUES (1)",
      "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
      "SELECT 1; DROP TABLE x",
      "SELECT * FROM t FOR UPDATE",
      "EXPLAIN ANALYZE SELECT 1",
      "SELECT pg_sleep(30)",
    ]
    for (const sql of cases) {
      try {
        assertReadOnlySelect(sql)
      } catch (err) {
        const msg = (err as SqlGuardError).message
        expect(msg).not.toContain("password")
        expect(msg).not.toContain("://")
        messages.add(msg)
      }
    }
    expect(messages.size).toBe(cases.length)
  })
})

// Tokenizer-desync bypasses: each one made the guard see a single statement
// where Postgres or Redshift sees several (2026-09-22 review). The first is the
// reproduced proof of concept: it committed the READ ONLY transaction and ran
// with statement_timeout 0 and no row cap.
describe("assertReadOnlySelect — lexer desync bypasses", () => {
  test("PoC: `a$$` is one identifier, not an identifier then a dollar quote", () =>
    expectReject(
      "SELECT 1 AS a$$) x; COMMIT; SELECT current_setting('transaction_read_only'), current_setting('statement_timeout') FROM (SELECT 1 AS b$$",
      "multi_statement",
    ))
  test("same with a non-ASCII identifier before the dollars", () =>
    expectReject("SELECT 1 AS é$$) x; DELETE FROM t; SELECT (1 AS b$$", "multi_statement"))
  test("E'...' honours backslash escapes: E'\\'' hides nothing", () =>
    expectReject("SELECT E'\\'' ; DELETE FROM t; --'", "multi_statement"))
  test("a plain literal is also read the Redshift way (backslash escapes the quote)", () =>
    expectReject("SELECT 'a\\'; DELETE FROM t; --'", "multi_statement"))
  test("a stray `)` that would close the row-cap wrapper is refused", () =>
    expectReject("SELECT * FROM big) t --", "unbalanced_parens"))
  test("still accepted: identifiers with `$`, digit tags, trailing comments, backslashes", () => {
    expectAccept("SELECT 1 AS a$$")
    expectAccept("SELECT $a1$;x$a1$ AS d")
    expectAccept("SELECT 1 AS one -- trailing note")
    expectAccept("SELECT 'C:\\temp' AS p")
  })
})

// set_config inside a SELECT resets statement_timeout (or any GUC) for the rest
// of the READ ONLY transaction, defeating the timeout wall; the backend and
// filesystem families signal or reach past the database. Matched on the bare
// name: quoting or schema-qualifying it changes nothing (2026-09-22 review).
describe("assertReadOnlySelect — settings, signalling and filesystem functions", () => {
  const cases = [
    "SELECT set_config('statement_timeout', '0', true)",
    "SELECT set_config('statement_timeout','0',false)",
    "SELECT pg_catalog.set_config('statement_timeout', '0', true)",
    `SELECT "pg_catalog"."set_config"('statement_timeout', '0', true)`,
    `SELECT "SET_CONFIG"('statement_timeout', '0', true)`,
    "SELECT pg_cancel_backend(123)",
    `SELECT "pg_terminate_backend"(123)`,
    "SELECT pg_catalog.pg_terminate_backend(1)",
    "SELECT pg_terminate_backend /* x */ (123)",
    "SELECT pg_reload_conf()",
    "SELECT pg_rotate_logfile()",
    "SELECT pg_advisory_lock(1)",
    "SELECT pg_try_advisory_xact_lock(1)",
    "SELECT pg_sleep_for('1 minute')",
    "SELECT pg_ls_waldir()",
    "SELECT pg_stat_file('postgresql.conf')",
    "SELECT lo_unlink(1)",
    "SELECT pg_notify('c', 'x')",
    "SELECT * FROM t WHERE x IN (SELECT set_config('work_mem', '1GB', true))",
    // SQL passed as a string runs outside the lexer's view (2026-10-15 review).
    "SELECT query_to_xml('select set_config(''role'',''x'',true)', false, false, '')",
    "SELECT pg_catalog.query_to_xml_and_xmlschema('select 1', false, false, '')",
    "SELECT query_to_xmlschema('select 1', false, false, '')",
    "SELECT cursor_to_xml('c', 1, false, false, '')",
    "SELECT table_to_xml('t', false, false, '')",
    "SELECT schema_to_xml('public', false, false, '')",
    "SELECT database_to_xml(false, false, '')",
    "SELECT * FROM ts_stat('select v from t')",
    "SELECT ts_rewrite('a'::tsquery, 'select a, b from t')",
    "SELECT pg_export_snapshot()",
    "SELECT pg_current_wal_lsn()",
    "SELECT txid_current()",
    "SELECT pg_file_write('x', 'y', false)",
    "SELECT pg_stat_statements_reset()",
    "SELECT pg_wait_for_backend_termination(1, 1000)",
    "SELECT pg_log_backend_memory_contexts(1)",
  ]
  for (const sql of cases) test(sql, () => expectReject(sql, "dangerous_function"))

  test("the same names as columns or quoted aliases, not calls, are fine", () => {
    expectAccept(`SELECT set_config, "pg_terminate_backend" FROM t`)
    expectAccept("SELECT lower(name), current_setting('statement_timeout') FROM t")
  })
})

describe("assertReadOnlySelect — unicode-escaped names", () => {
  const cases = [
    `SELECT U&"set\\005fconfig"('role', 'liaison_admin', true)`,
    `SELECT u&"query_to_xml"('select 1', false, false, '')`,
    `SELECT U&'abc'`,
  ]
  for (const sql of cases) test(sql, () => expectReject(sql, "unicode_escape"))

  test("a column named u is not affected", () => {
    expect(() => assertReadOnlySelect("SELECT u FROM t WHERE u & 1 = 1")).not.toThrow()
  })
})

describe("assertReadOnlySelect — query length", () => {
  const ofLength = (length: number) => {
    const head = "SELECT '"
    return `${head}${"a".repeat(length - head.length - 1)}'`
  }

  test("accepts a query at the limit", () => {
    expect(ofLength(MAX_RAW_SQL_CHARS)).toHaveLength(MAX_RAW_SQL_CHARS)
    expectAccept(ofLength(MAX_RAW_SQL_CHARS))
  })

  test("refuses a longer one, saying how long it is and what the limit is", () => {
    expectReject(ofLength(MAX_RAW_SQL_CHARS + 1), "query_too_long")
    expect(() => assertReadOnlySelect(ofLength(MAX_RAW_SQL_CHARS + 1))).toThrow(
      `${MAX_RAW_SQL_CHARS + 1} characters, the limit is ${MAX_RAW_SQL_CHARS}`,
    )
  })

  test("refuses an oversized query without scanning it", () => {
    const started = performance.now()
    expectReject(`SELECT '${"'".repeat(1_000_000)}`, "query_too_long")
    expect(performance.now() - started).toBeLessThan(100)
  })
})
