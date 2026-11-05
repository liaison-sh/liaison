#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run check:migration-safety`
//
// A deploy runs the previous release beside the new schema: the migration step
// applies the new migrations, then old processes keep serving until the new
// ones are ready. A migration that removes or reshapes something the previous
// release still uses breaks those old processes for the length of the overlap
// (and makes a rollback to the previous image impossible). A migration that
// holds a long lock on a busy table stops writes for as long as it runs.
//
// This guard reads every migration the drizzle journal (`meta/_journal.json`,
// the list the migrator runs) holds above the recorded baseline entry
// (`scripts/migration-safety-baseline.json`; the older ones are never
// rechecked) and refuses the statements that do either, unless the file says
// why they are safe. A `.sql` the journal does not list, or a journal entry
// with no file or not named `NNNN_name`, fails too.
//
// - Contract changes (`DROP [COLUMN]`, `DROP TABLE`, `RENAME`, `SET SCHEMA`,
//   `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `ADD COLUMN ... NOT NULL` without
//   a default on an existing table): only a file carrying `-- contract:
//   <reason>, unused since <PR or release>`, which says the previous release
//   no longer uses the object.
// - Other removals and behaviour changes on existing objects (`DROP INDEX`,
//   `DROP CONSTRAINT`, `DROP FUNCTION|PROCEDURE|POLICY|TRIGGER|TYPE|SCHEMA|
//   VIEW|SEQUENCE|DOMAIN|EXTENSION`, `TRUNCATE`, `ALTER TYPE`, `ALTER DOMAIN`,
//   `REVOKE` except on objects the file creates, `CREATE OR REPLACE FUNCTION`
//   of a function an earlier migration created; on a table not created in the
//   same file: `CREATE|ALTER POLICY`, `CREATE [OR REPLACE] TRIGGER`,
//   `ENABLE|DISABLE|FORCE|NO FORCE ROW LEVEL SECURITY`, and `ADD CONSTRAINT`,
//   `ADD EXCLUDE` or an inline `REFERENCES` / `CHECK` in `ADD COLUMN`, `NOT
//   VALID` included): the file's `-- contract:` line, or `-- expand-safe: <why
//   the previous release's code satisfies it>` right above the statement.
// - Dynamic SQL (a `DO` block, an `EXECUTE`, or a function body, dollar- or
//   single-quoted, that runs DDL): the guard does not parse inside it, so it
//   needs `-- reviewed-dynamic: <reason>` right above the statement.
// - Any `ALTER TABLE` on a table not created in the same file: a non-zero
//   `lock_timeout` set earlier in the file (its lock queues behind a long
//   transaction and every reader queues behind it), contract files included.
// - An index build on a table not created in the same file (`CREATE INDEX`,
//   `ADD ... PRIMARY KEY|UNIQUE`, inline in `ADD COLUMN` too): the migrator
//   runs every pending file in one transaction, so `CONCURRENTLY` is
//   impossible and the build holds a write lock. A non-zero `lock_timeout`
//   must be set earlier in the file (so a busy table makes the migration fail
//   fast instead of queueing every writer behind it) and the statement carries
//   `-- index-build: <table> <rows> <measured ms>`, measured at the largest
//   known deployment's size. A build over the budget below is a declared
//   maintenance deploy: `-- maintenance-deploy: <reason>` above the statement.
//
// Annotations count only as real comments: a `--` line inside a function body
// or a string literal exempts nothing. Table names compare schema-qualified.
//
// The code half of the rule (release N's code runs on N+1's schema; remove only
// after a release that stopped using the object; readers tolerate unknown enum
// and jsonb values) is in apps/api/CLAUDE.md "Migrations" and the self-hosting
// upgrade guide, and is enforced by review.

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/** An index build on an existing table must measure well under the 30 s request timeout. */
export const INDEX_BUILD_BUDGET_MS = 10_000

/** The name drizzle-kit gives a migration (its journal tag): `NNNN_words`. */
const MIGRATION_TAG = /^\d{4}_[\w-]+$/

export interface Statement {
  /** The SQL with comments removed and string / dollar-quoted bodies blanked, upper-cased, whitespace collapsed. */
  shape: string
  /** The raw function and DO bodies of the statement: dollar-quoted, or the string after a function's `AS`. */
  bodies: string[]
  /** The contents of the statement's string literals, in order (`''` unescaped). */
  literals: string[]
  /** The `--` comment lines above the statement (since the previous one), never from inside a string or body. */
  notes: string[]
}

export interface ParsedMigration {
  statements: Statement[]
  /** `--` comment lines after the last statement. */
  trailingNotes: string[]
}

const IDENT_CHAR = /[\w$]/

/**
 * Split a migration into statements: on `--> statement-breakpoint` and on `;`,
 * outside single-quoted strings (`E''` escapes included), quoted identifiers
 * (`""` escapes included), dollar-quoted bodies and comments. A `;` inside a
 * `$tag$ ... $tag$` function or DO body never splits. Comment lines are
 * collected as notes only where they are real comments, so an annotation
 * written inside a function body or a string exempts nothing.
 */
export function parseMigration(sql: string): ParsedMigration {
  const out: Statement[] = []
  let shape = ""
  let bodies: string[] = []
  let literals: string[] = []
  let notes: string[] = []
  const flush = () => {
    const s = shape.replace(/\s+/g, " ").trim()
    if (s) {
      out.push({ shape: s.toUpperCase(), bodies, literals, notes })
      notes = []
    }
    shape = ""
    bodies = []
    literals = []
  }
  const n = sql.length
  /** Read the string literal opening at `start`; returns its contents and the index after it. */
  const readString = (start: number, backslashEscapes: boolean): [string, number] => {
    let j = start + 1
    let content = ""
    while (j < n) {
      const ch = sql[j]
      if (backslashEscapes && ch === "\\") {
        content += sql.slice(j, j + 2)
        j += 2
        continue
      }
      if (ch === "'") {
        if (sql[j + 1] === "'") {
          content += "'"
          j += 2
          continue
        }
        return [content, j + 1]
      }
      content += ch
      j++
    }
    return [content, n]
  }
  let i = 0
  while (i < n) {
    const c = sql[i] ?? ""
    const prev = sql[i - 1] ?? ""
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i)
      const line = sql.slice(i, end === -1 ? n : end).trim()
      if (/^-->\s*statement-breakpoint/.test(line)) flush()
      else notes.push(line)
      i = end === -1 ? n : end + 1
      shape += " "
      continue
    }
    if (c === "/" && sql[i + 1] === "*") {
      // Postgres block comments nest.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++
          i += 2
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--
          i += 2
        } else i++
      }
      shape += " "
      continue
    }
    const eString = (c === "E" || c === "e") && sql[i + 1] === "'" && !IDENT_CHAR.test(prev)
    if (c === "'" || eString) {
      const [content, next] = readString(eString ? i + 1 : i, eString)
      literals.push(content)
      // `CREATE FUNCTION ... AS '<body>'`: the string is the function's body.
      const before = shape.replace(/\s+/g, " ").trim().toUpperCase()
      if (/^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE)\b/.test(before) && /\bAS$/.test(before))
        bodies.push(content)
      shape += "''"
      i = next
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      const stop = Math.min(n, j + 1)
      shape += sql.slice(i, stop)
      i = stop
      continue
    }
    if (c === "$" && !IDENT_CHAR.test(prev)) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (tag) {
        const open = tag[0]
        const close = sql.indexOf(open, i + open.length)
        const stop = close === -1 ? n : close
        bodies.push(sql.slice(i + open.length, stop))
        shape += " $$ "
        i = close === -1 ? n : close + open.length
        continue
      }
    }
    if (c === ";") {
      flush()
      i++
      continue
    }
    shape += c
    i++
  }
  flush()
  return { statements: out, trailingNotes: notes }
}

/** The statements of a migration (see `parseMigration`). */
export function splitStatements(sql: string): Statement[] {
  return parseMigration(sql).statements
}

export interface Finding {
  file: string
  statement: string
  rule: string
  message: string
}

/** One identifier: quoted (spaces and `""` escapes allowed) or bare. */
const IDENT = `(?:"(?:[^"]|"")+"|[\\w$]+)`
/** A possibly schema-qualified name, captured. */
const NAME = `(${IDENT}(?:\\.${IDENT}){0,2})`
const IF_NOT_EXISTS = `(?:IF NOT EXISTS )?`
const IF_EXISTS = `(?:IF EXISTS )?`
const ONLY = `(?:ONLY )?`

/**
 * A name as written, unquoted and lower-cased, with its schema kept:
 * `"kernel"."Foo"` -> `kernel.foo`. An unqualified name stays unqualified, so
 * `app_x.foo` and `kernel.foo` are different tables.
 */
export function qualifiedName(raw: string): string {
  const parts = raw.match(/"(?:[^"]|"")+"|[^."]+/g) ?? []
  return parts
    .map((p) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p).toLowerCase())
    .join(".")
}

function firstName(re: RegExp, shape: string): string | undefined {
  const m = re.exec(shape)
  return m?.[1] ? qualifiedName(m[1]) : undefined
}

/** Split on commas outside parentheses and quoted identifiers (strings are already blanked). */
function topLevelSplit(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let cur = ""
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === "(") depth++
    else if (!quoted && ch === ")") depth--
    else if (!quoted && depth === 0 && ch === ",") {
      out.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const CREATE_TABLE = new RegExp(
  `^CREATE (?:UNLOGGED |TEMP |TEMPORARY )?TABLE ${IF_NOT_EXISTS}${NAME}`,
)
const CREATE_FUNCTION = new RegExp(`^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE) ${NAME}`)

/** Tables and functions this file creates (so changes to them are not changes to existing objects). */
function createdIn(statements: Statement[]): { tables: Set<string>; functions: Set<string> } {
  const tables = new Set<string>()
  const functions = new Set<string>()
  for (const s of statements) {
    const t = firstName(CREATE_TABLE, s.shape)
    if (t) tables.add(t)
    const f = firstName(CREATE_FUNCTION, s.shape)
    if (f) functions.add(f)
  }
  return { tables, functions }
}

/** Functions created by any of the given migrations' sources (schema-qualified as written). */
export function functionsCreatedBy(sources: string[]): Set<string> {
  const out = new Set<string>()
  for (const src of sources) {
    for (const s of splitStatements(src)) {
      const f = firstName(CREATE_FUNCTION, s.shape)
      if (f) out.add(f)
    }
  }
  return out
}

const CONTRACT_NOTE = /^--\s*contract:\s*\S.*,\s*unused since\s+\S+/i
const EXPAND_SAFE_NOTE = /^--\s*expand-safe:\s*\S/i
const DYNAMIC_NOTE = /^--\s*reviewed-dynamic:\s*\S/i
const MAINTENANCE_NOTE = /^--\s*maintenance-deploy:\s*\S/i
const INDEX_BUILD_NOTE = /^--\s*index-build:\s*(\S+)\s+([\d_,]+)\s+(\d+)\s*(?:ms)?\b/i

/** DDL a function or DO body can run at migration time if the file calls it. */
const BODY_DDL =
  /\b(EXECUTE|DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|FUNCTION|PROCEDURE|POLICY|TRIGGER|TYPE|SCHEMA|VIEW|SEQUENCE|DOMAIN|EXTENSION)|TRUNCATE|RENAME|REVOKE|ALTER\s+(TABLE|TYPE|POLICY|DOMAIN)|CREATE\s+(OR\s+REPLACE\s+)?TRIGGER|ROW\s+LEVEL\s+SECURITY|SET\s+(NOT\s+NULL|SCHEMA))\b/i

/**
 * The `lock_timeout` a `SET` / `RESET lock_timeout` statement leaves, in its
 * own units (only zero or not matters), or undefined for any other statement.
 * `0`, `DEFAULT`, `RESET` and anything unparseable count as no timeout.
 */
function lockTimeoutSet(s: Statement): number | undefined {
  const m = /^(?:SET (?:LOCAL |SESSION )?LOCK_TIMEOUT (?:=|TO) (.+)|RESET LOCK_TIMEOUT)$/.exec(
    s.shape,
  )
  if (!m) return undefined
  if (!m[1]) return 0
  const raw = m[1].trim() === "''" ? (s.literals[0] ?? "") : m[1]
  const v = /^\s*(\d+(?:\.\d+)?)\s*(?:US|MS|S|MIN|H|D)?\s*$/i.exec(raw)
  return v ? Number(v[1]) : 0
}

/** `ADD [COLUMN] [IF NOT EXISTS] <col> ...`, as opposed to a table constraint. */
const COLUMN_ADD = new RegExp(
  `^ADD (?:COLUMN )?${IF_NOT_EXISTS}(?!(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\\b)${IDENT}`,
)
const CONSTRAINT_ADD = new RegExp(
  `^ADD (?:CONSTRAINT ${IDENT} )?(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE)\\b`,
)

/**
 * The findings for one migration. `earlierFunctions` holds the functions the
 * migrations before this one created, so a `CREATE OR REPLACE` of one of them
 * is recognised as a change to an existing function.
 */
export function checkMigration(
  file: string,
  sql: string,
  earlierFunctions: ReadonlySet<string> = new Set(),
): Finding[] {
  const { statements, trailingNotes } = parseMigration(sql)
  const contract = [...statements.flatMap((s) => s.notes), ...trailingNotes].some((l) =>
    CONTRACT_NOTE.test(l),
  )
  const created = createdIn(statements)
  const isNew = (name: string | undefined) => !!name && created.tables.has(name)
  // The lock_timeout in force at each statement: the last SET before it.
  let lockTimeout = 0
  const findings: Finding[] = []

  for (const s of statements) {
    const q = s.shape
    const setTo = lockTimeoutSet(s)
    if (setTo !== undefined) {
      lockTimeout = setTo
      continue
    }
    const has = (re: RegExp) => s.notes.some((l) => re.test(l))
    const expandSafe = has(EXPAND_SAFE_NOTE)
    const rules = new Set<string>()
    const flag = (rule: string, message: string) => {
      if (rules.has(rule)) return
      rules.add(rule)
      findings.push({ file, statement: q.slice(0, 160), rule, message })
    }

    // Dynamic SQL: the guard cannot see what it does.
    const dynamic =
      /^DO\b/.test(q) ||
      // `CREATE TRIGGER ... EXECUTE FUNCTION f()` names a function; it runs no SQL here.
      /\bEXECUTE\b(?! (?:FUNCTION|PROCEDURE)\b)/.test(q) ||
      s.bodies.some((b) => BODY_DDL.test(b.replace(/--[^\n]*/g, "")))
    if (dynamic && !has(DYNAMIC_NOTE)) {
      flag(
        "dynamic-sql",
        "a DO block, an EXECUTE or a function body that runs DDL is not checked by this guard: " +
          "put `-- reviewed-dynamic: <reason>` right above the statement",
      )
    }

    // ALTER TABLE: the target and each of its comma-separated actions.
    const alterTable = new RegExp(`^ALTER TABLE ${IF_EXISTS}${ONLY}${NAME}(?: \\*)? ?(.*)$`).exec(q)
    const target = alterTable?.[1] ? qualifiedName(alterTable[1]) : undefined
    const existingTarget = !!alterTable && !isNew(target)
    const actions = existingTarget ? topLevelSplit(alterTable?.[2] ?? "") : []

    // Any ALTER TABLE on an existing table takes a lock that queues behind a
    // long transaction, and every reader of the table queues behind it.
    if (existingTarget && lockTimeout <= 0)
      flag(
        "alter-lock-timeout",
        `ALTER TABLE on existing table ${target}: set a non-zero lock_timeout before it, so a busy table fails the migration fast instead of blocking its readers`,
      )

    // Contract changes: only `-- contract:` passes them.
    if (!contract) {
      for (const a of actions) {
        if (new RegExp(`^DROP (?!CONSTRAINT\\b)(?:COLUMN )?${IF_EXISTS}${IDENT}`).test(a))
          flag("drop-column", "DROP COLUMN removes what the previous release may still read")
        if (/^SET SCHEMA\b/.test(a))
          flag(
            "set-schema",
            "SET SCHEMA moves the table away from the name the previous release uses",
          )
        if (new RegExp(`^ALTER (?:COLUMN )?${IDENT} (?:SET DATA )?TYPE\\b`).test(a))
          flag(
            "alter-column-type",
            "changing a column's type breaks the previous release's reads and writes",
          )
        if (/\bSET NOT NULL\b/.test(a))
          flag(
            "set-not-null",
            "SET NOT NULL fails the previous release's inserts that leave the column empty",
          )
        if (
          COLUMN_ADD.test(a) &&
          /\bNOT NULL\b/.test(a) &&
          !/\bDEFAULT\b/.test(a) &&
          !/\bGENERATED\b/.test(a)
        )
          flag(
            "add-not-null-column",
            "ADD COLUMN ... NOT NULL without a DEFAULT fails the previous release's inserts",
          )
      }
      if (/^DROP TABLE\b/.test(q))
        flag("drop-table", "DROP TABLE removes what the previous release may still read")
      if (/\bRENAME\b/.test(q) && !(alterTable && isNew(target)))
        flag("rename", "RENAME breaks the previous release, which still uses the old name")
    }

    // Removals and behaviour changes on existing objects: `-- contract:` or `-- expand-safe:`.
    if (!contract && !expandSafe) {
      const dropOn = new RegExp(
        `^DROP (INDEX|POLICY|TRIGGER|FUNCTION|PROCEDURE|TYPE|SCHEMA|VIEW|MATERIALIZED VIEW|SEQUENCE|DOMAIN|EXTENSION) ${IF_EXISTS}${NAME}(?:.*? ON ${NAME})?`,
      ).exec(q)
      if (dropOn) {
        const kind = dropOn[1] ?? ""
        const obj = qualifiedName(dropOn[2] ?? "")
        const onTable = dropOn[3] ? qualifiedName(dropOn[3]) : undefined
        // A drop that only clears the way for this file's own new table or function is not a removal.
        const sameFile =
          (onTable && isNew(onTable)) ||
          ((kind === "FUNCTION" || kind === "PROCEDURE") && created.functions.has(obj))
        if (!sameFile)
          flag(
            `drop-${kind.toLowerCase().replace(" ", "-")}`,
            `DROP ${kind} changes what the previous release relies on`,
          )
      }
      for (const a of actions) {
        if (/^DROP CONSTRAINT\b/.test(a))
          flag("drop-constraint", "DROP CONSTRAINT changes what the previous release relies on")
        if (CONSTRAINT_ADD.test(a) || (COLUMN_ADD.test(a) && /\b(?:REFERENCES|CHECK)\b/.test(a)))
          flag(
            "add-constraint",
            "a constraint added on an existing table (NOT VALID included) can refuse the previous release's writes",
          )
        if (/^(?:ENABLE|DISABLE|NO FORCE|FORCE) ROW LEVEL SECURITY$/.test(a))
          flag(
            "rls-change",
            "turning row-level security on, off or (no) force on an existing table changes what the previous release can see",
          )
      }
      if (/^TRUNCATE\b/.test(q))
        flag("truncate", "TRUNCATE deletes data the previous release may still read")
      if (/^ALTER TYPE\b/.test(q))
        flag(
          "alter-type",
          "ALTER TYPE (enum values included) changes values the previous release may not know",
        )
      if (/^ALTER DOMAIN\b/.test(q))
        flag("alter-domain", "ALTER DOMAIN changes what the previous release's writes must satisfy")
      const fn = firstName(new RegExp(`^CREATE OR REPLACE (?:FUNCTION|PROCEDURE) ${NAME}`), q)
      if (fn && earlierFunctions.has(fn))
        flag(
          "replace-function",
          `CREATE OR REPLACE FUNCTION ${fn} changes a function the previous release calls`,
        )
      const policy = new RegExp(`^(?:CREATE|ALTER) POLICY ${IDENT} ON ${ONLY}${NAME}`).exec(q)
      if (policy && !isNew(policy[1] ? qualifiedName(policy[1]) : undefined))
        flag(
          "policy-change",
          "a policy change on an existing table changes what the previous release can see",
        )
      const trigger = new RegExp(
        `^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER ${IDENT} .*? ON ${ONLY}${NAME}`,
      ).exec(q)
      if (trigger && !isNew(trigger[1] ? qualifiedName(trigger[1]) : undefined))
        flag(
          "trigger-change",
          "a trigger on an existing table changes what the previous release's writes do",
        )
      if (/^REVOKE\b/.test(q)) {
        // A revoke on objects this file creates takes nothing away from the previous release.
        const on = / ON (?:TABLE |FUNCTION |PROCEDURE |SEQUENCE )?(.+?) FROM /.exec(q)
        const objects = on?.[1] ? topLevelSplit(on[1]) : []
        const allNew =
          objects.length > 0 &&
          objects.every((o) => {
            const name = new RegExp(`^${NAME}`).exec(o)?.[1]
            const key = name ? qualifiedName(name) : undefined
            return !!key && (created.tables.has(key) || created.functions.has(key))
          })
        if (!allNew)
          flag("revoke", "REVOKE takes away a privilege the previous release may still use")
      }
    }

    // Index builds on existing tables: CREATE INDEX, and ADD ... PRIMARY KEY | UNIQUE.
    const index = new RegExp(
      `^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?(?:${IF_NOT_EXISTS}${IDENT} )?ON ${ONLY}${NAME}`,
    ).exec(q)
    let indexTable: string | undefined
    if (index?.[1]) {
      flag(
        "index-concurrently",
        "CREATE INDEX CONCURRENTLY cannot run: the migrator applies every pending file in one transaction",
      )
    } else if (index) {
      const table = index[2] ? qualifiedName(index[2]) : undefined
      if (!isNew(table)) indexTable = table
    } else if (
      actions.some(
        (a) =>
          (/^ADD (?:CONSTRAINT \S+ )?(?:PRIMARY KEY|UNIQUE)\b/.test(a) &&
            !/\bUSING INDEX\b/.test(a)) ||
          (COLUMN_ADD.test(a) && /\b(?:PRIMARY KEY|UNIQUE)\b/.test(a)),
      )
    ) {
      indexTable = target
    }
    if (indexTable && !contract) {
      if (lockTimeout <= 0)
        flag(
          "index-lock-timeout",
          `index build on existing table ${indexTable}: set a non-zero lock_timeout before it`,
        )
      const note = s.notes.map((l) => INDEX_BUILD_NOTE.exec(l)).find((m) => m)
      if (!note) {
        flag(
          "index-build-size",
          `index build on existing table ${indexTable}: add \`-- index-build: <table> <rows> <measured ms>\``,
        )
      } else if (Number(note[3]) > INDEX_BUILD_BUDGET_MS && !has(MAINTENANCE_NOTE)) {
        flag(
          "index-build-budget",
          `the measured build (${note[3]} ms) is over ${INDEX_BUILD_BUDGET_MS} ms: writes would stall; ` +
            "declare a maintenance deploy with `-- maintenance-deploy: <reason>`",
        )
      }
    }
  }
  return findings
}

export interface Baseline {
  /** The drizzle journal idx of the last migration that predates the guard; entries above it are checked. */
  afterIdx: number
  /** That migration's journal tag, so an edit to one without the other is caught. */
  tag: string
}

export interface RunResult {
  exitCode: 0 | 1
  checked: string[]
  findings: Finding[]
}

interface JournalEntry {
  idx: number
  tag: string
}

/**
 * Check the migrations the drizzle journal (`meta/_journal.json`) lists above
 * the baseline's idx. The journal, not the file number, is what the migrator
 * runs, so a reused or out-of-order number is still checked; a `.sql` the
 * journal does not list, an entry with no file, and an entry off the
 * `NNNN_name` pattern all fail.
 */
export function run(opts: { migrationsDir: string; baseline: Baseline }): RunResult {
  const journal = JSON.parse(
    readFileSync(join(opts.migrationsDir, "meta/_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] }
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx)
  const base = entries.find((e) => e.idx === opts.baseline.afterIdx)
  if (!base || base.tag !== opts.baseline.tag)
    throw new Error(
      `migration-safety baseline: journal idx ${opts.baseline.afterIdx} is ${base?.tag ?? "missing"}, not ${opts.baseline.tag}`,
    )
  const findings: Finding[] = []
  const finding = (file: string, rule: string, message: string) =>
    findings.push({ file, statement: "", rule, message })
  const listed = new Set(entries.map((e) => `${e.tag}.sql`))
  const onDisk = new Set(readdirSync(opts.migrationsDir).filter((f) => f.endsWith(".sql")))
  for (const f of [...onDisk].sort())
    if (!listed.has(f))
      finding(f, "not-in-journal", "the drizzle journal does not list this file, so it never runs")
  const earlier = new Set<string>()
  const checked: string[] = []
  for (const e of entries) {
    const f = `${e.tag}.sql`
    if (!MIGRATION_TAG.test(e.tag))
      finding(f, "journal-name", "a journal entry must be named NNNN_name (drizzle-kit's form)")
    if (!onDisk.has(f)) {
      finding(f, "journal-missing-file", "the drizzle journal lists a migration with no file")
      continue
    }
    const src = readFileSync(join(opts.migrationsDir, f), "utf8")
    if (e.idx > opts.baseline.afterIdx) {
      checked.push(f)
      findings.push(...checkMigration(f, src, earlier))
    }
    for (const fn of functionsCreatedBy([src])) earlier.add(fn)
  }
  return { exitCode: findings.length ? 1 : 0, checked, findings }
}

if (import.meta.main) {
  const root = process.env.LIAISON_ROOT
    ? resolve(process.env.LIAISON_ROOT)
    : resolve(new URL("..", import.meta.url).pathname)
  const baseline = JSON.parse(
    readFileSync(join(root, "scripts/migration-safety-baseline.json"), "utf8"),
  ) as Baseline
  const result = run({ migrationsDir: join(root, "apps/api/src/db/migrations"), baseline })
  for (const f of result.findings)
    console.error(`${f.file}: [${f.rule}] ${f.message}\n    ${f.statement}`)
  console.log(
    `check:migration-safety: ${result.checked.length} migration(s) above ${baseline.tag} (journal idx ${baseline.afterIdx}) checked, ` +
      `${result.findings.length} finding(s)`,
  )
  process.exit(result.exitCode)
}
