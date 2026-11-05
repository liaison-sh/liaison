// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lintRoot } from "./lint-db-connection-import"

describe("lint-db-connection-import", () => {
  it("passes when only allowlisted files import ~/db/connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "lint-conn-pass-"))
    try {
      mkdirSync(join(root, "apps/api/src/db"), { recursive: true })
      mkdirSync(join(root, "apps/api/src/modules/health"), { recursive: true })
      writeFileSync(
        join(root, "apps/api/src/db/privileged.ts"),
        `import { __privileged_db__ } from "./connection"`,
      )
      writeFileSync(
        join(root, "apps/api/src/modules/health/routes.ts"),
        `import { __privileged_db__ } from "~/db/connection"`,
      )
      const violations = await lintRoot(root)
      expect(violations).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails when a non-allowlisted file imports ~/db/connection (tilde form)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lint-conn-fail-"))
    try {
      mkdirSync(join(root, "apps/api/src/modules/apps"), { recursive: true })
      writeFileSync(
        join(root, "apps/api/src/modules/apps/runtime.ts"),
        `import { __privileged_db__ } from "~/db/connection"`,
      )
      const violations = await lintRoot(root)
      expect(violations).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails when a non-allowlisted file uses a relative-path bypass", async () => {
    const root = mkdtempSync(join(tmpdir(), "lint-conn-rel-"))
    try {
      mkdirSync(join(root, "apps/api/src/modules/foo"), { recursive: true })
      writeFileSync(
        join(root, "apps/api/src/modules/foo/leaky.ts"),
        `import { __privileged_db__ } from "../../db/connection"`,
      )
      const violations = await lintRoot(root)
      expect(violations).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("excludes test files from the lint", async () => {
    const root = mkdtempSync(join(tmpdir(), "lint-conn-test-exempt-"))
    try {
      mkdirSync(join(root, "apps/api/src/modules/foo"), { recursive: true })
      writeFileSync(
        join(root, "apps/api/src/modules/foo/leaky.test.ts"),
        `import { __privileged_db__ } from "~/db/connection"`,
      )
      const violations = await lintRoot(root)
      expect(violations).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
