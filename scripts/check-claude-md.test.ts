// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")

test("root CLAUDE.md points at the run-tests skill, not concrete commands", () => {
  const md = readFileSync(path.join(ROOT, ".claude/CLAUDE.md"), "utf8")
  // Doctrine lives in the skill — CLAUDE.md just routes there.
  expect(md).toContain(".claude/skills/run-tests/SKILL.md")
  // CLAUDE.md must not be a tutorial: no concrete debug_test invocations,
  // no hard-coded run-dir paths, no ladder/mode mechanics — those belong in
  // SKILL.md so they can evolve without touching every project doc.
  expect(md).not.toContain("debug_test({")
  expect(md).not.toMatch(/\/tmp\/strobe\/tests\/[^>]/)
  expect(md).not.toContain('mode: "collect-all"')
})

test("e2e CLAUDE.md points to per-test artifact dirs", () => {
  const md = readFileSync(path.join(ROOT, "apps/web/src/tests/e2e/CLAUDE.md"), "utf8")
  expect(md).toContain("tests/<")
  expect(md).toMatch(/screenshot|page-state/i)
})
