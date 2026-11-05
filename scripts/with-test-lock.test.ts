// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P8-FX22, with F2. test-run.ts publishes each suite's own --timeout as BUN_TEST_TIMEOUT_MS so a
// helper that bounds its own wait lands BELOW bun's cap. A direct run through with-test-lock.ts
// published nothing, so every such helper fell back to its 30 s default while bun ran at the
// --timeout the command named: the helper could never report, bun killed the case first. The
// wrapper now forwards what it is passing on.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
let probeDir: string
let probe: string

const PROBE = (expected: string) => `// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, it } from "bun:test"
it("sees the forwarded bun timeout", () => {
  expect(process.env.BUN_TEST_TIMEOUT_MS ?? "none").toBe(${JSON.stringify(expected)})
})
`

/**
 * Runs the wrapper over a real `bun test` of the probe. The slot and the
 * namespace are already held here, so the wrapper takes neither and touches no
 * database.
 */
async function runWrapper(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn({
    cmd: ["bun", "run", "scripts/with-test-lock.ts", "--", "bun", "test", ...args, probe],
    cwd: ROOT,
    env: {
      ...process.env,
      LIAISON_TEST_LOCK_HELD: "1",
      LIAISON_TEST_NS_HELD: "1",
      LIAISON_TEST_NS: "wtl_probe",
      LIAISON_TEST_PORT_BASE: "16000",
      ...env,
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, output: `${out}\n${err}` }
}

beforeAll(() => {
  probeDir = mkdtempSync(path.join(ROOT, "tmp-wtl-timeout-"))
})

afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true })
})

describe("with-test-lock publishes the bun timeout it forwards", () => {
  it("publishes the --timeout the command carries", async () => {
    probe = path.join(probeDir, "forwarded.test.ts")
    writeFileSync(probe, PROBE("123456"))

    const { code, output } = await runWrapper(["--timeout", "123456"], {
      BUN_TEST_TIMEOUT_MS: undefined,
    })
    expect(output.includes("1 pass")).toBe(true)
    expect(code).toBe(0)
  }, 120_000)

  it("publishes nothing when the command names no timeout", async () => {
    probe = path.join(probeDir, "absent.test.ts")
    writeFileSync(probe, PROBE("none"))

    const { code, output } = await runWrapper([], { BUN_TEST_TIMEOUT_MS: undefined })
    expect(output.includes("1 pass")).toBe(true)
    expect(code).toBe(0)
  }, 120_000)
})
