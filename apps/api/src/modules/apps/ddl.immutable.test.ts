// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  generateDropImmutableTriggerDdl,
  generateImmutableTriggerDdl,
  IMMUTABLE_TRIGGER_DELETING_BRANCH,
  IMMUTABLE_TRIGGER_NAME,
  immutableSpecFromTriggerBody,
  ORG_PURGE_SETTING,
} from "./ddl"

describe("immutable table trigger DDL", () => {
  test("write-once update, retention on delete, superuser-only override", () => {
    const ddl = generateImmutableTriggerDdl("app_x", "legal_originals", { retentionYears: 10 })
    const stmts = ddl.split(";\n").filter((s) => s.trim())
    // function, drop, create: the schema sync splits on ";\n", so the body must stay one statement.
    expect(stmts).toHaveLength(3)
    expect(stmts[0]).toContain(`"legal_originals_${IMMUTABLE_TRIGGER_NAME}_fn"`)
    expect(stmts[0]).toContain(`OLD."created_at" > now() - interval '10 years'`)
    expect(stmts[0]).toContain("o.value <> 'null'::jsonb AND o.value IS DISTINCT FROM n.value")
    expect(stmts[0]).toContain("rolsuper")
    // The demo purge exception: DELETE only, the privileged role only, the named org only.
    expect(stmts[0]).toContain("IF TG_OP = 'DELETE' AND current_user = 'liaison_admin'")
    expect(stmts[0]).toContain(
      `current_setting('${ORG_PURGE_SETTING}', true) = to_jsonb(OLD)->>'org_id'`,
    )
    // The org may go: its deletion has started, or it is a demo workspace.
    expect(stmts[0]).toContain(IMMUTABLE_TRIGGER_DELETING_BRANCH)
    expect(stmts[0]).toContain("jsonb_typeof(o.settings->'demo') = 'object'")
    // The marker is the one the schema allows, not any object under `demo`.
    expect(stmts[0]).toContain("o.settings->'demo'->>'variant' IN ('reserved', 'visitor')")
    // The org lookup honours the worker schema prefix like every other kernel reference.
    expect(stmts[0]).toContain(`FROM "${schemaRef("kernel")}".organizations o`)
    expect(stmts[2]).toContain('BEFORE UPDATE OR DELETE ON "app_x"."legal_originals" FOR EACH ROW')
  })

  test("custom anchor column and bounds", () => {
    expect(
      generateImmutableTriggerDdl("s", "t", { retentionYears: 6, anchor: "recorded_at" }),
    ).toContain(`OLD."recorded_at" > now() - interval '6 years'`)
    expect(() => generateImmutableTriggerDdl("s", "t", { retentionYears: 0 })).toThrow()
    expect(() => generateImmutableTriggerDdl("s", "t", { retentionYears: 2.5 })).toThrow()
    expect(() =>
      generateImmutableTriggerDdl("s", "t", { retentionYears: 10, anchor: "x; drop table y" }),
    ).toThrow()
  })

  test("the spec is read back from a generated body, so the purge can regenerate a stale one", () => {
    for (const spec of [
      { retentionYears: 10 },
      { retentionYears: 6, anchor: "recorded_at" },
      { retentionYears: 10, writeOnceColumns: ["document_id", "kind"] },
    ]) {
      const fn = generateImmutableTriggerDdl("s", "t", spec).split(";\n")[0] ?? ""
      const body = fn.slice(fn.indexOf("DECLARE"), fn.lastIndexOf("END") + 3)
      expect(immutableSpecFromTriggerBody(body)).toEqual({
        retentionYears: spec.retentionYears,
        anchor: spec.anchor ?? "created_at",
        ...(spec.writeOnceColumns ? { writeOnceColumns: spec.writeOnceColumns } : {}),
      })
    }
    expect(immutableSpecFromTriggerBody("BEGIN RETURN NEW; END")).toBeNull()
  })

  test("drop statement for a table that stops declaring it", () => {
    expect(generateDropImmutableTriggerDdl("s", "t")).toBe(
      `DROP TRIGGER IF EXISTS "${IMMUTABLE_TRIGGER_NAME}" ON "s"."t"`,
    )
  })
})

/** postgres.js runs a query only on `.then`: hand `expect().rejects` a real promise. */
async function run(q: PromiseLike<unknown>): Promise<void> {
  await q
}

describe("writeOnceColumns: a ledger row keeps its identity, its state may advance", () => {
  const schema = `wo_${Math.random().toString(36).slice(2, 8)}`
  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  })

  test("only the listed columns are write-once; delete stays refused within retention", async () => {
    expect(() =>
      generateImmutableTriggerDdl("s", "t", { retentionYears: 10, writeOnceColumns: [] }),
    ).toThrow()
    expect(() =>
      generateImmutableTriggerDdl("s", "t", { retentionYears: 10, writeOnceColumns: ["x'; --"] }),
    ).toThrow()
    await sql.unsafe(`CREATE SCHEMA ${schema}`)
    await sql.unsafe(
      `CREATE TABLE ${schema}.tx (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz, idempotency_key text, provider_ref text, state text)`,
    )
    const ddl = generateImmutableTriggerDdl(schema, "tx", {
      retentionYears: 10,
      writeOnceColumns: ["idempotency_key", "provider_ref"],
    })
    for (const stmt of ddl.split(";\n").filter((x) => x.trim())) await sql.unsafe(stmt)
    const [row] = await sql.unsafe(
      `INSERT INTO ${schema}.tx (idempotency_key, state) VALUES ('k1', 'prepared') RETURNING id`,
    )
    const id = (row as unknown as { id: string }).id
    await sql.unsafe(
      `UPDATE ${schema}.tx SET state = 'imported', provider_ref = 'p1' WHERE id = '${id}'`,
    )
    await sql.unsafe(`UPDATE ${schema}.tx SET state = 'sent' WHERE id = '${id}'`)
    await expect(
      run(sql.unsafe(`UPDATE ${schema}.tx SET provider_ref = 'p2' WHERE id = '${id}'`)),
    ).rejects.toThrow(/immutable_row/)
    await expect(
      run(sql.unsafe(`UPDATE ${schema}.tx SET idempotency_key = 'k2' WHERE id = '${id}'`)),
    ).rejects.toThrow(/immutable_row/)
    await expect(run(sql.unsafe(`DELETE FROM ${schema}.tx WHERE id = '${id}'`))).rejects.toThrow(
      /immutable_retention/,
    )
    const [after] = (await sql.unsafe(
      `SELECT state, provider_ref FROM ${schema}.tx WHERE id = '${id}'`,
    )) as unknown as Array<Record<string, unknown>>
    expect(after).toEqual({ state: "sent", provider_ref: "p1" })
  })
})

/**
 * The one sanctioned exception: the org purge may delete the legal records of the org it is
 * deleting (its deletion started, or a demo workspace). Each case runs in its own transaction, under the role a real caller would hold.
 */
describe("the org purge exception", () => {
  const schema = `dp_${Math.random().toString(36).slice(2, 8)}`
  const tag = schema.replace("_", "-")
  const orgs: Record<
    "demoA" | "demoB" | "plain" | "emptyMarker" | "oddVariant" | "deleting",
    string
  > = {
    deleting: "",
    demoA: "",
    demoB: "",
    plain: "",
    emptyMarker: "",
    oddVariant: "",
  }
  const VISITOR = `{"demo":{"variant":"visitor","expiresAt":"2000-01-01T00:00:00.000Z"}}`

  async function makeOrg(key: keyof typeof orgs, settings: string): Promise<void> {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE liaison_admin")
      return tx.unsafe(
        `INSERT INTO ${schemaRef("kernel")}.organizations (name, slug, settings) VALUES ('${key}', '${tag}-${key.toLowerCase()}', '${settings}'::jsonb) RETURNING id`,
      )
    })
    orgs[key] = String((rows[0] as unknown as { id: string }).id)
  }

  /** Delete `rowOrg`'s rows as `role`, with the setting naming `settingOrg` (or unset). */
  async function deleteAs(
    role: string,
    settingOrg: string | null,
    rowOrg: string,
  ): Promise<number> {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`)
      if (settingOrg !== null) {
        await tx.unsafe(`SELECT set_config('${ORG_PURGE_SETTING}', '${settingOrg}', true)`)
      }
      return tx.unsafe(`DELETE FROM ${schema}.legal WHERE org_id = '${rowOrg}' RETURNING 1`)
    })
    return rows.length
  }

  async function rowsOf(org: string): Promise<number> {
    const rows = await sql.unsafe(`SELECT 1 FROM ${schema}.legal WHERE org_id = '${org}'`)
    return rows.length
  }

  beforeAll(async () => {
    await makeOrg("demoA", VISITOR)
    await makeOrg("demoB", VISITOR)
    await makeOrg("plain", "{}")
    // Objects under `demo` that the marker schema refuses: hand-written, not a demo org.
    await makeOrg("emptyMarker", `{"demo":{}}`)
    await makeOrg("oddVariant", `{"demo":{"variant":"staging","expiresAt":null}}`)
    // An ordinary org whose deletion has started (`liaison org delete`, modules/org/purge/).
    await makeOrg("deleting", "{}")
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE liaison_admin")
      await tx.unsafe(
        `UPDATE ${schemaRef("kernel")}.organizations SET deleting_at = now() WHERE id = '${orgs.deleting}'`,
      )
    })
    await sql.unsafe(`CREATE SCHEMA ${schema}`)
    await sql.unsafe(
      `CREATE TABLE ${schema}.legal (id uuid primary key default gen_random_uuid(), org_id uuid not null, created_at timestamptz not null default now(), sha text)`,
    )
    await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO liaison_admin, liaison_rls`)
    await sql.unsafe(`GRANT ALL ON ${schema}.legal TO liaison_admin, liaison_rls`)
    const ddl = generateImmutableTriggerDdl(schema, "legal", { retentionYears: 10 })
    for (const stmt of ddl.split(";\n").filter((x) => x.trim())) await sql.unsafe(stmt)
    for (const org of Object.values(orgs)) {
      await sql.unsafe(`INSERT INTO ${schema}.legal (org_id, sha) VALUES ('${org}', 'h')`)
    }
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE liaison_admin")
      await tx.unsafe(`DELETE FROM ${schemaRef("kernel")}.organizations WHERE slug LIKE '${tag}-%'`)
    })
  })

  test("a non-demo org's legal record stays undeletable, even with the setting naming it", async () => {
    await expect(run(deleteAs("liaison_admin", orgs.plain, orgs.plain))).rejects.toThrow(
      /immutable_retention/,
    )
    expect(await rowsOf(orgs.plain)).toBe(1)
  })

  test("an empty or unknown-variant demo object is not a marker, even with the role and the setting", async () => {
    for (const org of [orgs.emptyMarker, orgs.oddVariant]) {
      await expect(run(deleteAs("liaison_admin", org, org))).rejects.toThrow(/immutable_retention/)
      expect(await rowsOf(org)).toBe(1)
    }
  })

  test("the setting naming org A does not let org B's rows go", async () => {
    await expect(run(deleteAs("liaison_admin", orgs.demoA, orgs.demoB))).rejects.toThrow(
      /immutable_retention/,
    )
    expect(await rowsOf(orgs.demoB)).toBe(1)
  })

  test("a request role cannot use the setting, even for a demo org", async () => {
    await expect(run(deleteAs("liaison_rls", orgs.demoB, orgs.demoB))).rejects.toThrow(
      /immutable_retention/,
    )
    expect(await rowsOf(orgs.demoB)).toBe(1)
  })

  test("without the setting a demo org's record is refused like any other", async () => {
    await expect(run(deleteAs("liaison_admin", null, orgs.demoB))).rejects.toThrow(
      /immutable_retention/,
    )
  })

  test("the setting never relaxes write-once", async () => {
    await expect(
      run(
        sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE liaison_admin")
          await tx.unsafe(`SELECT set_config('${ORG_PURGE_SETTING}', '${orgs.demoB}', true)`)
          await tx.unsafe(`UPDATE ${schema}.legal SET sha = 'other' WHERE org_id = '${orgs.demoB}'`)
        }),
      ),
    ).rejects.toThrow(/immutable_row/)
  })

  test("the setting naming a deleting org does not let a live org's rows go", async () => {
    await expect(run(deleteAs("liaison_admin", orgs.deleting, orgs.plain))).rejects.toThrow(
      /immutable_retention/,
    )
    expect(await rowsOf(orgs.plain)).toBe(1)
  })

  test("a request role cannot use the setting for a deleting org either", async () => {
    await expect(run(deleteAs("liaison_rls", orgs.deleting, orgs.deleting))).rejects.toThrow(
      /immutable_retention/,
    )
    expect(await rowsOf(orgs.deleting)).toBe(1)
  })

  test("a non-demo org with deleting_at set and the purge setting can delete its immutable rows", async () => {
    expect(await deleteAs("liaison_admin", orgs.deleting, orgs.deleting)).toBe(1)
    expect(await rowsOf(orgs.deleting)).toBe(0)
    expect(await rowsOf(orgs.plain)).toBe(1)
  })

  test("the privileged role, the setting and the demo marker together delete that org's rows", async () => {
    expect(await deleteAs("liaison_admin", orgs.demoA, orgs.demoA)).toBe(1)
    expect(await rowsOf(orgs.demoA)).toBe(0)
    expect(await rowsOf(orgs.demoB)).toBe(1)
    expect(await rowsOf(orgs.plain)).toBe(1)
  })
})
