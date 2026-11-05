// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkSpdxIn } from "./check-spdx"

describe("check-spdx", () => {
  it("flags a file missing the SPDX header", () => {
    const dir = mkdtempSync(join(tmpdir(), "spdx-"))
    try {
      const sub = join(dir, "scripts")
      mkdirSync(sub)
      writeFileSync(join(sub, "x.ts"), "export {}\n")
      const issues = checkSpdxIn([sub])
      expect(issues.length).toBe(1)
      expect(issues[0].reason).toBe("missing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("flags a file with a duplicate SPDX header", () => {
    const dir = mkdtempSync(join(tmpdir(), "spdx-"))
    try {
      const sub = join(dir, "scripts")
      mkdirSync(sub)
      writeFileSync(
        join(sub, "x.ts"),
        "// SPDX-License-Identifier: FSL-1.1-ALv2\n// SPDX-License-Identifier: FSL-1.1-ALv2\nexport {}\n",
      )
      const issues = checkSpdxIn([sub])
      expect(issues.length).toBe(1)
      expect(issues[0].reason).toBe("duplicate")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("passes when a single SPDX header is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "spdx-"))
    try {
      const sub = join(dir, "scripts")
      mkdirSync(sub)
      writeFileSync(join(sub, "x.ts"), "// SPDX-License-Identifier: FSL-1.1-ALv2\nexport {}\n")
      const issues = checkSpdxIn([sub])
      expect(issues.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ignores excluded extensions (json/lockfile)", () => {
    const dir = mkdtempSync(join(tmpdir(), "spdx-"))
    try {
      const sub = join(dir, "scripts")
      mkdirSync(sub)
      writeFileSync(join(sub, "config.json"), "{}\n")
      writeFileSync(join(sub, "package-lock.json"), "{}\n")
      const issues = checkSpdxIn([sub])
      expect(issues.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it("D39: a vendored Atelier file keeps upstream bytes and is skipped; a file outside vendor/ is still checked", () => {
    const dir = mkdtempSync(join(tmpdir(), "spdx-"))
    try {
      const sidecar = join(dir, "apps", "desktop", "sidecar")
      const vendored = join(sidecar, "vendor", "atelier", "hooks")
      mkdirSync(vendored, { recursive: true })
      writeFileSync(join(vendored, "stop.sh"), "#!/usr/bin/env bash\necho upstream\n")
      writeFileSync(join(sidecar, "atelier-bundle.ts"), "export {}\n")
      const issues = checkSpdxIn([join(dir, "apps")])
      expect(issues.map((i) => [i.path.slice(dir.length + 1), i.reason])).toEqual([
        ["apps/desktop/sidecar/atelier-bundle.ts", "missing"],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
