// SPDX-License-Identifier: FSL-1.1-ALv2
//
// docs/api-connector.md carries the adapter format reference as a table
// generated from packages/api-connector-core/adapter.schema.json (itself
// drift-tested against the zod schema). This test fails when the doc's
// generated block no longer matches the schema: regenerate with
// `bun run scripts/api-connector-schema-doc.ts --write`.
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BEGIN_MARKER,
  DOC_FILE,
  END_MARKER,
  extractGenerated,
  FIELD_NOTES,
  loadSchema,
  REFERENCE_FILE,
  ROLES_BEGIN_MARKER,
  ROLES_END_MARKER,
  renderRolesReference,
  renderSchemaReference,
  schemaRows,
} from "./api-connector-schema-doc"

describe("api-connector schema reference", () => {
  it("the doc's generated block matches the JSON Schema", () => {
    const doc = readFileSync(DOC_FILE, "utf8")
    expect(doc).toContain(BEGIN_MARKER)
    expect(doc).toContain(END_MARKER)
    expect(extractGenerated(doc)).toBe(renderSchemaReference(loadSchema()))
  })

  it("the doc's roles table matches the core role registry", () => {
    const doc = readFileSync(DOC_FILE, "utf8")
    expect(extractGenerated(doc, ROLES_BEGIN_MARKER, ROLES_END_MARKER)).toBe(renderRolesReference())
    expect(renderRolesReference()).toContain("`customer.lookup`")
  })

  it("covers every top-level and operation field", () => {
    const paths = schemaRows(loadSchema()).map((r) => r.path)
    for (const p of ["id", "baseUrl", "auth", "operations[].fields", "operations[].role"]) {
      expect(paths).toContain(p)
    }
    expect(paths).toContain("auth[type=oauth2ClientCredentials].tokenUrl")
    expect(paths).toContain("operations[].pagination[type=cursor].cursorPointer")
  })

  it("every hand-written note names a field the schema has (no stale notes)", () => {
    const paths = new Set(schemaRows(loadSchema()).map((r) => r.path))
    for (const key of Object.keys(FIELD_NOTES))
      expect({ key, known: paths.has(key) }).toEqual({ key, known: true })
  })

  it("a schema change changes the rendered reference (discriminator)", () => {
    const schema = loadSchema()
    const before = renderSchemaReference(schema)
    const mutated = structuredClone(schema)
    const props = mutated.properties as Record<string, unknown>
    props.timeoutMs = { type: "integer", minimum: 1 }
    expect(renderSchemaReference(mutated)).not.toBe(before)
    expect(renderSchemaReference(mutated)).toContain("`timeoutMs`")
  })
})

describe("the in-product authoring reference (connector_adapter_reference)", () => {
  it("carries the same generated field table as the doc", () => {
    const text = readFileSync(REFERENCE_FILE, "utf8")
    expect(text).toContain(BEGIN_MARKER)
    expect(extractGenerated(text)).toBe(renderSchemaReference(loadSchema()))
    expect(extractGenerated(text)).toContain("`operations[].fields`")
  })

  it("carries the same generated roles table as the doc", () => {
    const text = readFileSync(REFERENCE_FILE, "utf8")
    expect(extractGenerated(text, ROLES_BEGIN_MARKER, ROLES_END_MARKER)).toBe(
      renderRolesReference(),
    )
  })

  it("names the in-product tools, not the developer CLI", () => {
    const text = readFileSync(REFERENCE_FILE, "utf8")
    for (const tool of [
      "connector_adapter_save",
      "connector_adapter_test",
      "connector_adapter_get",
      "connector_adapter_restore",
      "request_secret",
      "web_search",
      "web_fetch",
    ]) {
      expect(text).toContain(tool)
    }
    expect(text).not.toContain("liaison api-connector")
    expect(text).not.toContain("docker compose")
  })
})

describe("api-connector-authoring skill", () => {
  const ROOT = join(import.meta.dir, "..")
  const SKILL = join(ROOT, ".claude/skills/api-connector-authoring/SKILL.md")

  it("has the frontmatter the skill loader needs", () => {
    const text = readFileSync(SKILL, "utf8")
    expect(text).toMatch(/^---\nname: api-connector-authoring\ndescription: \S/)
  })

  it("names the CLI, the config section, the dev flag and the reference doc", () => {
    const text = readFileSync(SKILL, "utf8")
    expect(text).toContain("liaison api-connector validate")
    expect(text).toContain("liaison api-connector test")
    expect(text).toContain("apiConnectors:")
    expect(text).toContain("LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true")
    expect(text).toContain("docs/api-connector.md")
  })

  it("every repo path the skill and the doc cite exists", () => {
    const cited = new Set<string>()
    for (const file of [SKILL, DOC_FILE]) {
      const text = readFileSync(file, "utf8")
      for (const m of text.matchAll(
        /`((?:apps|packages|docs|scripts|\.claude)\/[A-Za-z0-9_./-]+)`/g,
      )) {
        cited.add((m[1] ?? "").replace(/\/$/, ""))
      }
    }
    expect(cited.size).toBeGreaterThan(3)
    for (const path of cited)
      expect({ path, exists: existsSync(join(ROOT, path)) }).toEqual({ path, exists: true })
  })
})
