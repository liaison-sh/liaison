// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The French dictionaries are GENERATED from the English ones through
// scripts/i18n-fr-table.ts. French written straight into a locale file and not
// recorded in the table is silently turned back into English the next time
// anyone runs `bun run i18n:fr`. This happened twice on 2026-10-01 (sharing,
// chats list, task discussion strings) because nothing ran the generator's
// check: it lives here, beside the locale files, so editing them runs it.
import { describe, expect, it } from "bun:test"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../../../..")

describe("French dictionaries", () => {
  it("match what the translation table regenerates (bun run i18n:fr:check)", () => {
    const run = Bun.spawnSync(["bun", "run", "scripts/i18n-gen-fr.ts", "--check"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = `${run.stdout.toString()}${run.stderr.toString()}`
    expect(output).toContain("All en values have French translations")
    expect(run.exitCode).toBe(0)
  })
})
