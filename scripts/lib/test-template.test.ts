// SPDX-License-Identifier: FSL-1.1-ALv2
// The template key: what makes a run reuse a migrated template, and what makes
// it build a new one. Pure file reads in a scratch tree, no database.

import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TEMPLATE_PREFIX, templateAppSchemas, templateHash, templateName } from "./test-template"

const created: string[] = []
afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop() as string, { recursive: true, force: true })
})

function scratchRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "liaison-tpl-"))
  created.push(root)
  const mig = path.join(root, "apps/api/src/db/migrations")
  fs.mkdirSync(path.join(mig, "meta"), { recursive: true })
  fs.writeFileSync(path.join(mig, "0000_initial.sql"), "CREATE TABLE a (id int);")
  fs.writeFileSync(path.join(mig, "meta/_journal.json"), '{"entries":[]}')
  fs.writeFileSync(path.join(root, "apps/api/src/db/migrate.ts"), "// migrator")
  return root
}

describe("templateHash", () => {
  it("is stable for an unchanged tree", () => {
    const root = scratchRepo()
    expect(templateHash(root)).toBe(templateHash(root))
    expect(templateHash(root)).toMatch(/^[0-9a-f]{16}$/)
  })

  it("changes when a migration is edited, added, or the journal moves", () => {
    const root = scratchRepo()
    const mig = path.join(root, "apps/api/src/db/migrations")
    const h0 = templateHash(root)
    fs.writeFileSync(path.join(mig, "0000_initial.sql"), "CREATE TABLE a (id bigint);")
    const h1 = templateHash(root)
    expect(h1).not.toBe(h0)
    fs.writeFileSync(path.join(mig, "0001_next.sql"), "ALTER TABLE a ADD b int;")
    const h2 = templateHash(root)
    expect(h2).not.toBe(h1)
    fs.writeFileSync(path.join(mig, "meta/_journal.json"), '{"entries":[1]}')
    expect(templateHash(root)).not.toBe(h2)
  })

  it("changes when the migrator changes", () => {
    const root = scratchRepo()
    const h0 = templateHash(root)
    fs.writeFileSync(path.join(root, "apps/api/src/db/migrate.ts"), "// migrator v2")
    expect(templateHash(root)).not.toBe(h0)
  })

  it("ignores the test files that sit next to the migrations", () => {
    const root = scratchRepo()
    const h0 = templateHash(root)
    fs.writeFileSync(
      path.join(root, "apps/api/src/db/migrations/0000_initial.test.ts"),
      "// a test",
    )
    expect(templateHash(root)).toBe(h0)
  })

  it("changes when an in-tree app's manifest or descriptor changes, not its other files", () => {
    const root = scratchRepo()
    const app = path.join(root, "apps/api/src/apps/tickets")
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, "app.manifest.json"), '{"name":"tickets","schema":{}}')
    fs.writeFileSync(path.join(app, "manifest-descriptor.ts"), "// descriptor")
    const h0 = templateHash(root, {})
    fs.writeFileSync(path.join(app, "handlers.ts"), "// handlers")
    expect(templateHash(root, {})).toBe(h0)
    fs.writeFileSync(path.join(app, "app.manifest.json"), '{"name":"tickets","schema":{"a":{}}}')
    const h1 = templateHash(root, {})
    expect(h1).not.toBe(h0)
    fs.writeFileSync(path.join(app, "manifest-descriptor.ts"), "// descriptor v2")
    const h2 = templateHash(root, {})
    expect(h2).not.toBe(h1)
    const fixture = path.join(root, "apps/api/test-support/apps/test")
    fs.mkdirSync(fixture, { recursive: true })
    fs.writeFileSync(path.join(fixture, "app.manifest.json"), '{"name":"test"}')
    expect(templateHash(root, {})).not.toBe(h2)
  })

  it("changes when the code that turns a manifest into DDL changes", () => {
    const root = scratchRepo()
    const ddl = path.join(root, "apps/api/src/modules/apps/ddl.ts")
    fs.mkdirSync(path.dirname(ddl), { recursive: true })
    fs.writeFileSync(ddl, "// ddl")
    const h0 = templateHash(root, {})
    fs.writeFileSync(ddl, "// ddl v2")
    expect(templateHash(root, {})).not.toBe(h0)
  })

  it("keys the migrations-only opt-out apart, and ignores the manifests there", () => {
    const root = scratchRepo()
    const off = { LIAISON_TEST_TEMPLATE_APP_SCHEMAS: "0" }
    expect(templateAppSchemas({})).toBe(true)
    expect(templateAppSchemas(off)).toBe(false)
    const h0 = templateHash(root, off)
    expect(h0).not.toBe(templateHash(root, {}))
    const app = path.join(root, "apps/api/src/apps/mail")
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, "app.manifest.json"), '{"name":"mail"}')
    expect(templateHash(root, off)).toBe(h0)
  })

  it("names the template after the hash", () => {
    expect(templateName("abc123")).toBe(`${TEMPLATE_PREFIX}abc123`)
    expect(TEMPLATE_PREFIX).toBe("liaison_tpl_")
  })
})
