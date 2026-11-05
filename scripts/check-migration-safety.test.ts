// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkMigration, run, splitStatements } from "./check-migration-safety"

const FIXTURES = resolve(import.meta.dir, "__fixtures__/migration-safety")
const ROOT = resolve(import.meta.dir, "..")

/** Functions earlier migrations created, as the real run passes them. */
const EARLIER = new Set(["kernel.current_org_id"])

function rulesOf(fixture: string): string[] {
  const sql = readFileSync(join(FIXTURES, `${fixture}.sql`), "utf8")
  return checkMigration(`${fixture}.sql`, sql, EARLIER).map((f) => f.rule)
}

describe("check-migration-safety: refused", () => {
  const refused: Array<[string, string]> = [
    ["bad-drop-column", "drop-column"],
    ["bad-index", "index-lock-timeout"],
    ["bad-index-no-size", "index-build-size"],
    ["bad-index-over-budget", "index-build-budget"],
    ["bad-do-block", "dynamic-sql"],
    ["bad-function-body-ddl", "dynamic-sql"],
    ["bad-drop-index", "drop-index"],
    ["bad-alter-type", "alter-type"],
    ["bad-replace-function", "replace-function"],
    ["bad-not-valid-fk", "add-constraint"],
    ["bad-add-not-null", "add-not-null-column"],
    ["bad-set-not-null", "set-not-null"],
    ["bad-rename", "rename"],
    ["bad-truncate", "truncate"],
    ["bad-policy-existing", "policy-change"],
  ]
  for (const [fixture, rule] of refused) {
    it(`${fixture} fails with ${rule}`, () => {
      expect(rulesOf(fixture)).toContain(rule)
    })
  }

  it("a lock_timeout without the measured size still fails, and the size alone without lock_timeout fails", () => {
    expect(rulesOf("bad-index-no-size")).not.toContain("index-lock-timeout")
    const sizedNoTimeout =
      "-- index-build: kernel.threads 250000 1200ms\nCREATE INDEX t_idx ON kernel.threads (id);"
    expect(checkMigration("x.sql", sizedNoTimeout).map((f) => f.rule)).toEqual([
      "index-lock-timeout",
    ])
  })

  it("CONCURRENTLY is refused: the migrator runs in a transaction", () => {
    const sql = "CREATE INDEX CONCURRENTLY t_idx ON kernel.threads (id);"
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toEqual(["index-concurrently"])
  })

  it("a contract line without its 'unused since' clause does not exempt", () => {
    const sql = "-- contract: not needed\nALTER TABLE kernel.threads DROP COLUMN legacy_flag;"
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toContain("drop-column")
  })

  it("expand-safe does not pass a contract change", () => {
    const sql = "-- expand-safe: trust me\nALTER TABLE kernel.threads DROP COLUMN legacy_flag;"
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toContain("drop-column")
  })
})

describe("check-migration-safety: allowed", () => {
  for (const fixture of [
    "ok-contract",
    "ok-new-table",
    "ok-index-sized",
    "ok-do-reviewed",
    "ok-expand-safe",
  ]) {
    it(`${fixture} passes`, () => {
      expect(rulesOf(fixture)).toEqual([])
    })
  }

  it("CREATE TRIGGER ... EXECUTE FUNCTION is not dynamic SQL", () => {
    const sql =
      "CREATE TABLE kernel.t (id int);\nCREATE TRIGGER t_trg BEFORE UPDATE ON kernel.t FOR EACH ROW EXECUTE FUNCTION kernel.f();"
    expect(checkMigration("x.sql", sql)).toEqual([])
  })
})

describe("check-migration-safety: statement splitting", () => {
  it("a ; inside a dollar-quoted body, a string or a comment does not split", () => {
    const sql = [
      "-- a; comment",
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; SELECT 2; $body$ LANGUAGE sql;",
      "/* block; /* nested; */ comment */",
      "SELECT 'a;b';",
      "SELECT 1",
      "--> statement-breakpoint",
      "SELECT 2",
    ].join("\n")
    const shapes = splitStatements(sql).map((s) => s.shape)
    expect(shapes).toEqual([
      "CREATE FUNCTION F() RETURNS INT AS $$ LANGUAGE SQL",
      "SELECT ''",
      "SELECT 1",
      "SELECT 2",
    ])
  })

  it("a flagged keyword inside a string literal is not a statement", () => {
    const sql = "COMMENT ON TABLE kernel.threads IS 'we never DROP COLUMN here';"
    expect(checkMigration("x.sql", sql)).toEqual([])
  })
})

/** Each case: refused bare, allowed under its documented annotation. */
const FILE_CONTRACT = "-- contract: the old shape is gone, unused since #900"
const LOCK = "SET LOCAL lock_timeout = '5s';\n--> statement-breakpoint\n"
const SIZED = "-- index-build: kernel.threads 250000 1200ms"
const CASES: Array<{ name: string; sql: string; rule: string; note: string }> = [
  {
    name: "DROP without COLUMN",
    sql: "ALTER TABLE kernel.threads DROP legacy_flag;",
    rule: "drop-column",
    note: FILE_CONTRACT,
  },
  {
    name: "DROP IF EXISTS without COLUMN",
    sql: "ALTER TABLE kernel.threads DROP IF EXISTS legacy_flag;",
    rule: "drop-column",
    note: FILE_CONTRACT,
  },
  {
    name: "DROP COLUMN of a quoted name with a space",
    sql: 'ALTER TABLE "kernel"."threads" DROP COLUMN "my col";',
    rule: "drop-column",
    note: FILE_CONTRACT,
  },
  {
    name: "a DROP among other actions",
    sql: "ALTER TABLE kernel.threads ADD COLUMN x int, DROP legacy_flag;",
    rule: "drop-column",
    note: FILE_CONTRACT,
  },
  {
    name: "ALTER COLUMN of a quoted name with a space TYPE",
    sql: 'ALTER TABLE kernel.threads ALTER COLUMN "my col" TYPE bigint;',
    rule: "alter-column-type",
    note: FILE_CONTRACT,
  },
  {
    name: "ALTER of a quoted name with an escaped quote SET DATA TYPE",
    sql: 'ALTER TABLE kernel.threads ALTER "a ""b"" c" SET DATA TYPE text;',
    rule: "alter-column-type",
    note: FILE_CONTRACT,
  },
  {
    name: "SET SCHEMA",
    sql: "ALTER TABLE kernel.threads SET SCHEMA archive;",
    rule: "set-schema",
    note: FILE_CONTRACT,
  },
  {
    name: "REVOKE from a role",
    sql: "REVOKE SELECT ON kernel.threads FROM liaison_rls;",
    rule: "revoke",
    note: "-- expand-safe: the previous release never reads threads as liaison_rls",
  },
  {
    name: "CREATE TRIGGER on an existing table",
    sql: "CREATE TRIGGER threads_trg BEFORE UPDATE ON kernel.threads FOR EACH ROW EXECUTE FUNCTION kernel.touch();",
    rule: "trigger-change",
    note: "-- expand-safe: the trigger only stamps a column the previous release never reads",
  },
  {
    name: "CREATE OR REPLACE TRIGGER on an existing table",
    sql: "CREATE OR REPLACE TRIGGER threads_trg BEFORE UPDATE ON kernel.threads FOR EACH ROW EXECUTE FUNCTION kernel.touch();",
    rule: "trigger-change",
    note: "-- expand-safe: same body as before",
  },
  ...["DISABLE", "NO FORCE", "FORCE", "ENABLE"].map((verb) => ({
    name: `${verb} ROW LEVEL SECURITY on an existing table`,
    sql: `ALTER TABLE kernel.threads ${verb} ROW LEVEL SECURITY;`,
    rule: "rls-change",
    note: "-- expand-safe: every policy the previous release needs is in place",
  })),
  ...["SEQUENCE", "DOMAIN", "EXTENSION"].map((kind) => ({
    name: `DROP ${kind}`,
    sql: `DROP ${kind} IF EXISTS kernel.old_thing;`,
    rule: `drop-${kind.toLowerCase()}`,
    note: "-- expand-safe: nothing in the previous release refers to it",
  })),
  {
    name: "ALTER DOMAIN",
    sql: "ALTER DOMAIN kernel.email ADD CONSTRAINT email_at CHECK (VALUE LIKE '%@%');",
    rule: "alter-domain",
    note: "-- expand-safe: every stored value already satisfies it",
  },
  {
    name: "ADD EXCLUDE",
    sql: "ALTER TABLE kernel.threads ADD EXCLUDE USING gist (room WITH =);",
    rule: "add-constraint",
    note: "-- expand-safe: the previous release never writes overlapping rows",
  },
  {
    name: "inline ADD COLUMN ... REFERENCES",
    sql: "ALTER TABLE kernel.threads ADD COLUMN run_id uuid REFERENCES kernel.widget_runs(id);",
    rule: "add-constraint",
    note: "-- expand-safe: the previous release never writes run_id",
  },
  {
    name: "inline ADD COLUMN ... CHECK",
    sql: "ALTER TABLE kernel.threads ADD COLUMN n int CHECK (n > 0);",
    rule: "add-constraint",
    note: "-- expand-safe: the previous release never writes n",
  },
  {
    name: "inline ADD COLUMN ... UNIQUE builds an index",
    sql: `${LOCK}ALTER TABLE kernel.threads ADD COLUMN slug text UNIQUE;`,
    rule: "index-build-size",
    note: SIZED,
  },
  {
    name: "inline ADD COLUMN ... PRIMARY KEY builds an index",
    sql: `${LOCK}ALTER TABLE kernel.threads ADD COLUMN pk bigint PRIMARY KEY;`,
    rule: "index-build-size",
    note: SIZED,
  },
]

describe("check-migration-safety: contract-class statements", () => {
  for (const c of CASES) {
    it(`${c.name}: refused bare, allowed with its annotation`, () => {
      expect(checkMigration("x.sql", c.sql, EARLIER).map((f) => f.rule)).toContain(c.rule)
      // The annotation sits right above the statement (the last one in the case).
      const parts = c.sql.split("\n--> statement-breakpoint\n")
      const last = parts.pop() ?? ""
      // Every ALTER TABLE on an existing table also needs a lock_timeout (alter-lock-timeout).
      const annotated = LOCK + [...parts, `${c.note}\n${last}`].join("\n--> statement-breakpoint\n")
      expect(checkMigration("x.sql", annotated, EARLIER)).toEqual([])
    })
  }

  it("triggers and RLS changes on a table created in the same file stay allowed", () => {
    const sql = [
      "CREATE TABLE kernel.widgets (id int);",
      "CREATE TRIGGER widgets_trg BEFORE UPDATE ON kernel.widgets FOR EACH ROW EXECUTE FUNCTION kernel.touch();",
      "ALTER TABLE kernel.widgets ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE kernel.widgets FORCE ROW LEVEL SECURITY;",
      "ALTER TABLE kernel.widgets NO FORCE ROW LEVEL SECURITY;",
      "REVOKE ALL ON kernel.widgets FROM PUBLIC;",
      "ALTER TABLE kernel.widgets ADD COLUMN slug text UNIQUE;",
    ].join("\n")
    expect(checkMigration("x.sql", sql, EARLIER)).toEqual([])
  })

  it("ALTER COLUMN ... DROP DEFAULT and DROP NOT NULL are not column drops", () => {
    const sql =
      "ALTER TABLE kernel.threads ALTER COLUMN state DROP DEFAULT, ALTER COLUMN note DROP NOT NULL;"
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).not.toContain("drop-column")
  })

  it("DROP CONSTRAINT is a constraint drop, not a column drop", () => {
    const rules = checkMigration("x.sql", "ALTER TABLE kernel.threads DROP CONSTRAINT c;").map(
      (f) => f.rule,
    )
    expect(rules).toEqual(["alter-lock-timeout", "drop-constraint"])
  })
})

describe("check-migration-safety: names are schema-qualified", () => {
  it("creating app_x.threads does not exempt kernel.threads", () => {
    const sql =
      "CREATE TABLE app_x.threads (id int);\nALTER TABLE kernel.threads DROP COLUMN legacy_flag;"
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toContain("drop-column")
  })

  it("a quoted and an unquoted spelling of the same new table match", () => {
    const sql =
      'CREATE TABLE "kernel"."widgets" (id int);\nCREATE INDEX w_idx ON kernel.widgets (id);'
    expect(checkMigration("x.sql", sql)).toEqual([])
  })
})

describe("check-migration-safety: lock_timeout before an ALTER TABLE on an existing table", () => {
  const alter = "ALTER TABLE kernel.apps_installed ADD COLUMN IF NOT EXISTS manifest_schema jsonb;"
  it("an ALTER TABLE on an existing table without a lock_timeout is refused", () => {
    expect(checkMigration("x.sql", alter).map((f) => f.rule)).toEqual(["alter-lock-timeout"])
  })
  it("passes with a non-zero lock_timeout set before it", () => {
    expect(checkMigration("x.sql", `${LOCK}${alter}`)).toEqual([])
  })
  it("a lock_timeout reset to 0 before it does not count", () => {
    const sql = `${LOCK}SET LOCAL lock_timeout = 0;\n--> statement-breakpoint\n${alter}`
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toEqual(["alter-lock-timeout"])
  })
  it("a table created in the same file needs none (nobody else can hold a lock on it)", () => {
    const sql =
      "CREATE TABLE kernel.widgets (id int);\nALTER TABLE kernel.widgets ENABLE ROW LEVEL SECURITY;"
    expect(checkMigration("x.sql", sql)).toEqual([])
  })
})

describe("check-migration-safety: lock_timeout before the index build", () => {
  const index = `${SIZED}\nCREATE INDEX t_idx ON kernel.threads (id);`
  it("a lock_timeout set after the index statement does not count", () => {
    const sql = `${index}\n--> statement-breakpoint\nSET LOCAL lock_timeout = '5s';`
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toEqual(["index-lock-timeout"])
  })
  for (const zero of ["'0'", "0", "'0s'", "DEFAULT"]) {
    it(`SET lock_timeout = ${zero} does not count`, () => {
      const sql = `SET LOCAL lock_timeout = ${zero};\n--> statement-breakpoint\n${index}`
      expect(checkMigration("x.sql", sql).map((f) => f.rule)).toEqual(["index-lock-timeout"])
    })
  }
  it("a later reset to 0 before the build cancels an earlier timeout", () => {
    const sql = `SET LOCAL lock_timeout = '5s';\nSET LOCAL lock_timeout TO 0;\n${index}`
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toEqual(["index-lock-timeout"])
  })
  it("a non-zero timeout set before passes, with = or TO, quoted or not", () => {
    for (const set of ["SET LOCAL lock_timeout = '5s';", "SET lock_timeout TO 5000;"])
      expect(checkMigration("x.sql", `${set}\n${index}`)).toEqual([])
  })
})

describe("check-migration-safety: annotations only count outside bodies and strings", () => {
  it("a contract note inside a $$ body does not exempt the file", () => {
    const sql = [
      "CREATE FUNCTION kernel.g() RETURNS int AS $$",
      "-- contract: hidden, unused since #1",
      "SELECT 1",
      "$$ LANGUAGE sql;",
      "ALTER TABLE kernel.threads DROP COLUMN legacy_flag;",
    ].join("\n")
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toContain("drop-column")
  })
  it("a contract note inside a multi-line string does not exempt the file", () => {
    const sql = [
      "COMMENT ON TABLE kernel.threads IS 'line one",
      "-- contract: hidden, unused since #1",
      "';",
      "ALTER TABLE kernel.threads DROP COLUMN legacy_flag;",
    ].join("\n")
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toContain("drop-column")
  })
  it("an expand-safe note inside a $$ body does not exempt the next statement", () => {
    const sql = ["SELECT $$", "-- expand-safe: hidden", "$$;", "TRUNCATE kernel.threads;"].join(
      "\n",
    )
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toContain("truncate")
  })
  it("a trailing contract comment after the last statement still counts", () => {
    const sql = `${LOCK}ALTER TABLE kernel.threads DROP COLUMN legacy_flag;\n-- contract: gone, unused since #9\n`
    expect(checkMigration("x.sql", sql)).toEqual([])
  })
})

describe("check-migration-safety: the tokenizer", () => {
  it("an E'' string with a backslash-escaped quote does not leak its contents", () => {
    const sql = "COMMENT ON TABLE kernel.threads IS E'it\\'s; DROP TABLE kernel.threads';"
    expect(splitStatements(sql).map((s) => s.shape)).toEqual([
      "COMMENT ON TABLE KERNEL.THREADS IS ''",
    ])
    expect(checkMigration("x.sql", sql)).toEqual([])
  })
  it("a quoted identifier with an escaped quote stays one identifier", () => {
    const sql = 'CREATE TABLE kernel."a "";b" (id int);'
    expect(splitStatements(sql)).toHaveLength(1)
  })
  it("a single-quoted function body (LANGUAGE sql AS '...') is a body", () => {
    const sql =
      "CREATE FUNCTION kernel.h() RETURNS void LANGUAGE sql AS 'ALTER TABLE kernel.threads DROP COLUMN x';"
    const [s] = splitStatements(sql)
    expect(s?.bodies).toEqual(["ALTER TABLE kernel.threads DROP COLUMN x"])
    expect(checkMigration("x.sql", sql).map((f) => f.rule)).toContain("dynamic-sql")
  })
})

/** A migrations dir whose journal lists `tags` in order (idx 0..n-1), each file holding its SQL. */
function migrationsDir(files: Array<[tag: string, sql: string]>, extra: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "migration-safety-"))
  mkdirSync(join(dir, "meta"))
  const entries = files.map(([tag], idx) => ({
    idx,
    version: "7",
    when: idx,
    tag,
    breakpoints: true,
  }))
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  )
  for (const [tag, sql] of files) writeFileSync(join(dir, `${tag}.sql`), sql)
  for (const f of extra) writeFileSync(join(dir, f), "SELECT 1;")
  return dir
}

describe("check-migration-safety: the journal and the baseline", () => {
  const bad = "ALTER TABLE kernel.threads DROP COLUMN legacy_flag;"
  const withDir = (dir: string, fn: (dir: string) => void) => {
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("migrations at or below the baseline's journal idx are not checked", () => {
    withDir(
      migrationsDir([
        ["0000_a", bad],
        ["0001_old", bad],
        ["0002_new", bad],
      ]),
      (dir) => {
        const r = run({ migrationsDir: dir, baseline: { afterIdx: 1, tag: "0001_old" } })
        expect(r.exitCode).toBe(1)
        expect(r.checked).toEqual(["0002_new.sql"])
      },
    )
  })

  it("a reused number above the baseline is checked (selection is by journal idx, not number)", () => {
    withDir(
      migrationsDir([
        ["0000_a", "SELECT 1;"],
        ["0001_b", "SELECT 1;"],
        ["0001_reused", bad],
      ]),
      (dir) => {
        const r = run({ migrationsDir: dir, baseline: { afterIdx: 1, tag: "0001_b" } })
        expect(r.checked).toEqual(["0001_reused.sql"])
        expect(r.findings.map((f) => f.rule)).toEqual(["alter-lock-timeout", "drop-column"])
      },
    )
  })

  it("a journal entry whose name is off the NNNN_name pattern fails", () => {
    withDir(
      migrationsDir([
        ["0000_a", "SELECT 1;"],
        ["0001_b", "SELECT 1;"],
        ["2_Odd.Name", "SELECT 1;"],
      ]),
      (dir) => {
        const r = run({ migrationsDir: dir, baseline: { afterIdx: 1, tag: "0001_b" } })
        expect(r.exitCode).toBe(1)
        expect(r.findings.map((f) => f.rule)).toEqual(["journal-name"])
      },
    )
  })

  it("a .sql file the journal does not list fails (the migrator would never run it)", () => {
    withDir(
      migrationsDir(
        [
          ["0000_a", "SELECT 1;"],
          ["0001_b", "SELECT 1;"],
        ],
        ["0002_orphan.sql", "odd name.sql"],
      ),
      (dir) => {
        const r = run({ migrationsDir: dir, baseline: { afterIdx: 1, tag: "0001_b" } })
        expect(r.exitCode).toBe(1)
        expect(r.findings.map((f) => `${f.rule}:${f.file}`).sort()).toEqual([
          "not-in-journal:0002_orphan.sql",
          "not-in-journal:odd name.sql",
        ])
      },
    )
  })

  it("a journal entry with no file fails", () => {
    const dir = migrationsDir([
      ["0000_a", "SELECT 1;"],
      ["0001_b", "SELECT 1;"],
    ])
    withDir(dir, () => {
      rmSync(join(dir, "0001_b.sql"))
      const r = run({ migrationsDir: dir, baseline: { afterIdx: 0, tag: "0000_a" } })
      expect(r.findings.map((f) => f.rule)).toEqual(["journal-missing-file"])
    })
  })

  it("a baseline whose tag does not match its idx is refused", () => {
    withDir(
      migrationsDir([
        ["0000_a", "SELECT 1;"],
        ["0001_b", "SELECT 1;"],
      ]),
      (dir) => {
        expect(() => run({ migrationsDir: dir, baseline: { afterIdx: 1, tag: "0000_a" } })).toThrow(
          /baseline/,
        )
      },
    )
  })

  it("a function created by an earlier migration is an existing function for a later one", () => {
    withDir(
      migrationsDir([
        ["0001_f", "CREATE FUNCTION kernel.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;"],
        [
          "0002_f",
          "CREATE OR REPLACE FUNCTION kernel.f() RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql;",
        ],
      ]),
      (dir) => {
        const r = run({ migrationsDir: dir, baseline: { afterIdx: 0, tag: "0001_f" } })
        expect(r.findings.map((f) => f.rule)).toEqual(["replace-function"])
      },
    )
  })

  it("the recorded baseline is the 0224 migration, at its journal idx", () => {
    const baseline = JSON.parse(
      readFileSync(join(ROOT, "scripts/migration-safety-baseline.json"), "utf8"),
    )
    expect(baseline).toEqual({ afterIdx: 225, tag: "0224_session_rotation_lineage" })
  })

  it("every migration above the recorded baseline in this tree passes", () => {
    const baseline = JSON.parse(
      readFileSync(join(ROOT, "scripts/migration-safety-baseline.json"), "utf8"),
    )
    const r = run({ migrationsDir: join(ROOT, "apps/api/src/db/migrations"), baseline })
    expect(r.findings).toEqual([])
  })
})
