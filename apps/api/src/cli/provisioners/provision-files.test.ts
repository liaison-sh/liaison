// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `{ $file: <path> }` in an `apps[].provision` block: replaced by the file's
// text, never outside the config file's directory, never on the agent's path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProvisionFiles } from "~/cli/provisioners/app-provision"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "provision-files-"))
  mkdirSync(join(dir, "connectors"))
  writeFileSync(join(dir, "connectors", "crm.yaml"), "id: crm\n")
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("provision files", () => {
  test("a $file anywhere in the block becomes the file's text", () => {
    const out = resolveProvisionFiles(
      { connectors: [{ identifier: "crm", adapter: { $file: "connectors/crm.yaml" } }], n: 1 },
      dir,
      "apps.x.provision",
    )
    expect(out).toEqual({ connectors: [{ identifier: "crm", adapter: "id: crm\n" }], n: 1 })
  })

  test("an object with other keys beside $file is left as it is", () => {
    const value = { $file: "connectors/crm.yaml", other: 1 }
    expect(resolveProvisionFiles(value, dir, "p")).toEqual(value)
  })

  test("refuses a path outside the config directory, an absolute one and a missing file", () => {
    expect(() => resolveProvisionFiles({ $file: "../x.yaml" }, dir, "p")).toThrow(
      "escapes the config file directory",
    )
    expect(() => resolveProvisionFiles({ $file: "/etc/hosts" }, dir, "p")).toThrow(
      "must be relative to the config file directory",
    )
    expect(() => resolveProvisionFiles({ $file: "connectors/none.yaml" }, dir, "p")).toThrow(
      "cannot read 'connectors/none.yaml'",
    )
  })

  test("without a config file (the agent's config tools) a $file is refused", () => {
    expect(() => resolveProvisionFiles({ $file: "connectors/crm.yaml" }, undefined, "p")).toThrow(
      "pass the content inline",
    )
  })
})
