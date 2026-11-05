// SPDX-License-Identifier: FSL-1.1-ALv2
//
// assertReadOnlySelect — cheap syntactic gate in front of the structural
// guarantees (READ ONLY transaction + role-layer allow-list grants). This is
// explicitly DEFENSE IN DEPTH, not the real wall (see Task 7's grant model +
// function-execution lockdown) — it exists to catch obvious hostility early
// with a clean, typed, non-leaky error before either of those layers.
//
// No SQL parser dependency: comment/string/dollar-quote-aware scanning only.

export class SqlGuardError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = "SqlGuardError"
  }
}

/** Dangerous function names (case-insensitive), matched at call position —
 *  i.e. immediately followed by `(` — never as a bare substring, so a column
 *  named `pg_sleep_at` is not rejected. Matched on the bare function name, so
 *  a schema qualifier (`pg_catalog.set_config`) or double quotes
 *  (`"pg_terminate_backend"`, `"pg_catalog"."set_config"`) change nothing.
 *
 *  Three families: anything that changes a setting for the rest of the
 *  transaction (`set_config` would undo the statement timeout the transport
 *  just set), anything that signals, reconfigures or blocks the server or
 *  other sessions, and anything that reaches the server's filesystem, large
 *  objects or another database. Postgres and Redshift share these names;
 *  Redshift adds no SQL-callable equivalent beyond them. */
const DANGEROUS_FUNCTIONS = [
  // settings
  "set_config",
  // backend signalling / server control
  "pg_cancel_backend",
  "pg_terminate_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_promote",
  "pg_switch_wal",
  "pg_switch_xlog",
  "pg_create_restore_point",
  "pg_notify",
  "pg_log_backend_memory_contexts",
  "pg_stat_reset",
  // filesystem
  "pg_stat_file",
  // sequences
  "copy",
  "setval",
  "nextval",
]

/** Whole families, by name prefix: sleeps, advisory locks (a lock held on a
 *  pooled connection outlives the call), directory listings and file reads,
 *  large objects, dblink, replication and backup control, stat resets. */
const DANGEROUS_FUNCTION_PREFIXES = [
  "pg_sleep",
  "pg_advisory",
  "pg_try_advisory",
  "pg_ls_",
  "pg_read_",
  "lo_",
  "dblink",
  "pg_replication_",
  "pg_logical_",
  "pg_create_",
  "pg_drop_replication_slot",
  "pg_backup_",
  "pg_start_backup",
  "pg_stop_backup",
  "pg_stat_reset",
  "pg_wal_replay_",
  // Functions that EXECUTE SQL handed to them as a string. The string is a
  // literal to this lexer, so whatever it holds (a set_config('role', ...) that
  // steps out of a narrowed SET LOCAL ROLE, for one) would run unseen.
  "query_to_xml",
  "cursor_to_xml",
  "table_to_xml",
  "schema_to_xml",
  "database_to_xml",
  "ts_stat",
  "ts_rewrite",
  "pg_export_snapshot",
  // Settings dumps and WAL/transaction-id internals: no read-only analytic
  // query needs them. (`current_setting` stays allowed: a read changes nothing.)
  "pg_show_all_settings",
  "pg_wal_",
  "pg_current_wal",
  "pg_current_xact",
  "pg_import_",
  "txid_",
  // adminpack file writes, statistics resets and waits on other sessions.
  "pg_file_",
  "pg_stat_statements_reset",
  "pg_wait_for_backend_termination",
  "pg_log_",
]

function isDangerousFunction(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    DANGEROUS_FUNCTIONS.includes(lower) ||
    DANGEROUS_FUNCTION_PREFIXES.some((p) => lower.startsWith(p))
  )
}

/** The identifier a token names, when it can name a function: a bare word, or
 *  a double-quoted identifier with its quotes removed. */
function functionName(t: Token): string | null {
  if (t.kind === "word") return t.value
  if (t.kind === "string" && t.value.startsWith('"')) {
    return t.value.slice(1, t.value.endsWith('"') ? -1 : undefined).replace(/""/g, '"')
  }
  return null
}

const WRITE_STATEMENT_HEADS = [
  "insert",
  "update",
  "delete",
  "merge",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "vacuum",
  "reindex",
  "call",
  "do",
  "copy",
  "explain",
]

interface Token {
  kind: "word" | "punct" | "string" | "dollar" | "comment" | "other"
  value: string
  /** Position right after this token — used to check what follows (e.g. "(") */
  end: number
}

/** Identifier characters as Postgres and Redshift lex them: a letter,
 *  underscore or non-ASCII character starts one; digits and `$` may follow.
 *  `a$$` is ONE identifier, never an identifier followed by a dollar quote. */
const IDENT_START = /[A-Za-z_\u0080-\uffff]/
const IDENT_CONT = /[A-Za-z0-9_$\u0080-\uffff]/
/** A dollar-quote delimiter: `$$` or `$tag$`, the tag an identifier without `$`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/

/**
 * Tokenizes SQL into a comment/string/dollar-quote-aware stream. Strings and
 * comments are opaque single tokens (their contents never re-scanned for
 * keywords or semicolons) — this is what makes the multi-statement and
 * dangerous-function checks below string/comment-safe without a real parser.
 *
 * `backslashEscapes` decides how a plain '...' literal treats `\'`. Postgres
 * (standard_conforming_strings on) reads `'a\'` as a complete literal;
 * Redshift reads `\'` as an escaped quote. The guard cannot know which
 * server it fronts, so `assertReadOnlySelect` scans BOTH ways and a statement
 * must pass both. An `E'...'` literal always honours backslash escapes.
 */
function tokenize(sql: string, backslashEscapes: boolean): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i)
      const stop = end === -1 ? n : end
      tokens.push({ kind: "comment", value: sql.slice(i, stop), end: stop })
      i = stop
      continue
    }
    // Block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      tokens.push({ kind: "comment", value: sql.slice(i, stop), end: stop })
      i = stop
      continue
    }
    // Single-quoted string (with '' escape, and backslash escapes where they apply)
    if (ch === "'") {
      const prev = tokens[tokens.length - 1]
      const escapeString =
        backslashEscapes || (prev?.kind === "word" && prev.end === i && /^[eE]$/.test(prev.value))
      let j = i + 1
      while (j < n) {
        if (escapeString && sql[j] === "\\") {
          j += 2
          continue
        }
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          j++
          break
        }
        j++
      }
      tokens.push({ kind: "string", value: sql.slice(i, j), end: j })
      i = j
      continue
    }
    // Double-quoted identifier — treat as opaque like a string for our purposes
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2
          continue
        }
        if (sql[j] === '"') {
          j++
          break
        }
        j++
      }
      tokens.push({ kind: "string", value: sql.slice(i, j), end: j })
      i = j
      continue
    }
    // Dollar-quoted string ($$...$$  or  $tag$...$tag$)
    if (ch === "$") {
      const tagMatch = DOLLAR_TAG.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const closeIdx = sql.indexOf(tag, i + tag.length)
        const stop = closeIdx === -1 ? n : closeIdx + tag.length
        tokens.push({ kind: "dollar", value: sql.slice(i, stop), end: stop })
        i = stop
        continue
      }
    }
    // Word (identifier/keyword)
    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < n && IDENT_CONT.test(sql[j])) j++
      tokens.push({ kind: "word", value: sql.slice(i, j), end: j })
      i = j
      continue
    }
    // Punctuation / everything else, one char at a time
    tokens.push({ kind: "punct", value: ch, end: i + 1 })
    i++
  }
  return tokens
}

function isEffectivelyEmpty(t: Token): boolean {
  return t.kind === "comment" || (t.kind === "punct" && /^\s*$/.test(t.value))
}

/**
 * Validates that `sql` is a single, read-only SELECT (optionally with a
 * leading WITH/CTE chain), free of write-headed CTEs, `SELECT ... INTO`,
 * locking clauses, `EXPLAIN ANALYZE`, and dangerous function calls. Throws
 * `SqlGuardError` with a distinct, non-leaky message per violation kind.
 */
export function assertReadOnlySelect(sql: string): void {
  assertReadOnlyTokens(tokenize(sql, false))
  assertReadOnlyTokens(tokenize(sql, true))
}

function assertReadOnlyTokens(allTokens: Token[]): void {
  // --- `U&"..."` / `U&'...'`: a quoted identifier or string whose characters
  // can be written as `\XXXX` escapes, so `U&"set\005fconfig"(...)` names a
  // function this scan would read as the unrelated word `set\005fconfig`.
  // Nothing a read-only query needs, so refused outright rather than decoded.
  for (let idx = 0; idx + 2 < allTokens.length; idx++) {
    const a = allTokens[idx]
    const b = allTokens[idx + 1]
    const c = allTokens[idx + 2]
    if (
      a.kind === "word" &&
      /^u$/i.test(a.value) &&
      b.kind === "punct" &&
      b.value === "&" &&
      (c.kind === "string" || c.kind === "other") &&
      (c.value.startsWith('"') || c.value.startsWith("'"))
    ) {
      throw new SqlGuardError("Unicode-escaped literals (U&...) are not allowed", "unicode_escape")
    }
  }
  const tokens = allTokens.filter((t) => !isEffectivelyEmpty(t))
  if (tokens.length === 0) {
    throw new SqlGuardError("Empty SQL statement", "empty")
  }

  // --- Single statement: only punct ";" tokens outside strings/comments/dollar
  // quotes are already excluded by tokenizer opacity; reject any ";" that has
  // non-whitespace content after it.
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.kind === "punct" && t.value === ";") {
      const rest = tokens.slice(idx + 1).filter((x) => !isEffectivelyEmpty(x))
      if (rest.length > 0) {
        throw new SqlGuardError(
          "Multiple statements are not allowed (semicolon followed by more content)",
          "multi_statement",
        )
      }
    }
  }

  // --- Balanced parentheses. The row cap wraps the statement in
  // `SELECT * FROM ( ... ) AS __liaison_row_cap LIMIT n`; a stray `)` would
  // close that wrapper early and leave the LIMIT to a trailing comment.
  let depth = 0
  for (const t of tokens) {
    if (t.kind !== "punct") continue
    if (t.value === "(") depth++
    if (t.value === ")" && --depth < 0) break
  }
  if (depth !== 0) {
    throw new SqlGuardError("Unbalanced parentheses", "unbalanced_parens")
  }

  // --- Statement head: first word must be SELECT or WITH.
  const firstWord = tokens.find((t) => t.kind === "word")
  if (!firstWord) {
    throw new SqlGuardError("SQL must start with SELECT or WITH", "bad_head")
  }
  const head = firstWord.value.toLowerCase()
  if (head === "explain") {
    throw new SqlGuardError(
      "EXPLAIN ANALYZE (or parenthesized ANALYZE option) executes the statement — not allowed",
      "explain_analyze",
    )
  }
  if (head !== "select" && head !== "with") {
    if (WRITE_STATEMENT_HEADS.includes(head)) {
      throw new SqlGuardError(
        `Statement head "${head.toUpperCase()}" is a write/DDL operation — only SELECT/WITH is allowed`,
        "write_head",
      )
    }
    throw new SqlGuardError("SQL must start with SELECT or WITH", "bad_head")
  }

  // --- CTE-write bypass: any `<ident> AS ( <write-head> ...` inside a WITH.
  // Walk word tokens looking for "(" immediately following, then check the
  // first word token inside that paren group.
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.kind === "punct" && t.value === "(") {
      // find first non-empty word/keyword token after "("
      let j = idx + 1
      while (j < tokens.length && isEffectivelyEmpty(tokens[j])) j++
      const inner = tokens[j]
      if (inner?.kind === "word") {
        const innerHead = inner.value.toLowerCase()
        if (WRITE_STATEMENT_HEADS.includes(innerHead) && innerHead !== "explain") {
          throw new SqlGuardError(
            `Nested "${innerHead.toUpperCase()}" inside a subquery/CTE is not allowed (CTE-write bypass)`,
            "cte_write",
          )
        }
      }
    }
  }

  // --- EXPLAIN (ANALYZE) parenthesized form, and general EXPLAIN anywhere as
  // a nested statement (defensive — the head check above already catches a
  // top-level EXPLAIN, this catches `(EXPLAIN ...)`-shaped nesting attempts).
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.kind === "word" && t.value.toLowerCase() === "explain") {
      throw new SqlGuardError(
        "EXPLAIN executes the statement and is not allowed in any position",
        "explain_analyze",
      )
    }
  }

  // --- SELECT ... INTO
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.kind === "word" && t.value.toLowerCase() === "into") {
      // Only a problem if not part of `insert into` (already rejected) —
      // in a SELECT-headed statement, INTO always means SELECT INTO.
      throw new SqlGuardError("SELECT ... INTO is not allowed (creates a table)", "select_into")
    }
  }

  // --- Locking clauses: FOR UPDATE / FOR SHARE
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.kind === "word" && t.value.toLowerCase() === "for") {
      let j = idx + 1
      while (j < tokens.length && isEffectivelyEmpty(tokens[j])) j++
      const next = tokens[j]
      if (next?.kind === "word" && ["update", "share"].includes(next.value.toLowerCase())) {
        throw new SqlGuardError(
          `Locking clause "FOR ${next.value.toUpperCase()}" is not allowed`,
          "locking_clause",
        )
      }
    }
  }

  // --- Dangerous function calls: word immediately followed (modulo comments)
  // by a "(" punct.
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    const name = functionName(t)
    if (name === null || !isDangerousFunction(name)) continue
    let j = idx + 1
    while (j < tokens.length && isEffectivelyEmpty(tokens[j])) j++
    const next = tokens[j]
    if (next?.kind === "punct" && next.value === "(") {
      throw new SqlGuardError(
        `Call to dangerous function "${name}" is not allowed`,
        "dangerous_function",
      )
    }
  }
}
