// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the invoicing app's contract fixtures for the correction of a billed line
// (fixtures/invoicing/tool__credit_note_from_reconcile.json,
// preflight__credit_note_from_reconcile.json): a card that cannot be read (no projects app in the
// contract org), so no credit note is made. Not part of any suite run (it skips unless
// CONTRACT_RECORD=1): run it by path when these entries' bridge calls change, read what it wrote,
// commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-invoicing-corrections.recorder.test.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run.test-helpers"

const APP = "invoicing"
const REC = "7a000000-0000-4000-8000-00000000c3a1"
const LINE = "7b000000-0000-4000-8000-00000000c3a1"

const PLAN: RecordingStep[] = [
  ...(["tool", "preflight"] as const).map((kind) => ({
    entry: `${kind}:credit_note_from_reconcile`,
    input: () => ({
      params: { reconciliationId: REC, lineId: LINE, correctedQuantity: 2.5 },
      expectError: {
        reason:
          "the contract org has no projects app, so the card cannot be read and no credit note is made: pins that refusal; the correction path is proven by credit-from-reconcile.test.ts",
      },
    }),
  })),
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record invoicing correction fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>

  beforeAll(async () => {
    await acquireTestLock()
    installed = await installForRecording(APP, {})
  }, 300_000)

  afterAll(async () => {
    await uninstallAfterRecording(APP)
    await releaseTestLock()
  })

  it("records every planned entry", async () => {
    const report = await runRecordingPlan({
      app: APP,
      manifest: installed.manifest,
      bridgeManifest: installed.bridgeManifest,
      plan: PLAN,
      state: { values: {} } satisfies RecordingState,
      replacements: [],
      secrets: [],
      recordedFrom:
        "the contract org on a local stack, record-invoicing-corrections.recorder.test.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: {},
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => !/^ok[ ?] /.test(l))).toEqual([])
  }, 600_000)
})
