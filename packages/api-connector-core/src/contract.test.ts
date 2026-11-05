// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AUTH_CREDENTIAL_FIELDS, CONNECTION_SLUG_PATTERN } from "./contract"
import { AuthSchema } from "./schema"

describe("route contract", () => {
  it("names the credential fields of exactly the auth types the schema accepts", () => {
    const schemaTypes = AuthSchema.options.map((o) => o.shape.type.value).sort()
    expect(Object.keys(AUTH_CREDENTIAL_FIELDS).sort()).toEqual(schemaTypes)
  })

  it("restates the kernel's multiInstance identifier rule", () => {
    const service = readFileSync(
      join(import.meta.dir, "../../../apps/api/src/modules/apps/connections/service.ts"),
      "utf8",
    )
    expect(service).toContain(
      `export const MULTI_INSTANCE_IDENTIFIER_RE = ${CONNECTION_SLUG_PATTERN.toString()}`,
    )
  })

  it("is importable without the validator: type-only imports and constants", () => {
    const source = readFileSync(join(import.meta.dir, "contract.ts"), "utf8")
    const imports = source.match(/^import .*$/gm) ?? []
    expect(imports.every((line) => line.startsWith("import type "))).toBe(true)
  })
})
