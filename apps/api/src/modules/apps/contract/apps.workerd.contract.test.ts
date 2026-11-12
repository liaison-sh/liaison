// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wake-up contract on workerd: the same entries, fixtures and limits as
// apps.contract.test.ts, each entry run twice in one reused workerd isolate of
// the sandbox service, its ctx.* calls answered through the app's bridge
// route. For the apps that are done with the contract (no expected failure,
// no trivial pass on QuickJS), workerd must agree: every entry keeps it.
import { afterAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { loadAppUnderContract } from "./apps.test-helpers"
import { EXPECTED_FAILURES_PATH, failuresOf, readFailures, trivialEntriesOf } from "./expected"
import { runAppContract } from "./harness"
import {
  stopWorkerdContractService,
  workerdContractExecutor,
  workerModuleSource,
} from "./workerd-isolate"

const APPS = ["shopify", "invoicing"]
const expected = readFailures(EXPECTED_FAILURES_PATH)

afterAll(async () => {
  await stopWorkerdContractService()
})

describe("app wake-up contract on workerd", () => {
  for (const app of APPS) {
    it(`${app}: every entry keeps the contract, as on QuickJS`, async () => {
      expect(expected.filter((f) => f.app === app)).toEqual([])
      const loaded = await loadAppUnderContract(app)
      const workerd = {
        ...loaded,
        source: await workerModuleSource(join(loaded.dir, "handlers.ts")),
        templateSource: (rel: string) => workerModuleSource(join(loaded.dir, rel)),
      }
      const verdicts = await runAppContract(workerd, workerdContractExecutor)
      expect(verdicts.length).toBe(loaded.entries.length)
      const failed = failuresOf(app, verdicts, []).map(
        (f) => `${f.entry}: ${verdicts.find((v) => v.entry === f.entry)?.detail ?? ""}`,
      )
      expect({ failed, trivial: trivialEntriesOf(verdicts) }).toEqual({ failed: [], trivial: [] })
    }, 300_000)
  }
})
