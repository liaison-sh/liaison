// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the invoicing app's contract fixtures for retainers and the card's own discard
// (fixtures/invoicing/tool__retainer_draft_from_reconcile.json, tool__reconcile_draft_discard.json,
// job__retainer-timebox-roll.json, tool__retainer_terms_renew.json) and the refund preflight (preflight__advance_refund_prepare.json):
// a retainer card that cannot be read (no projects app in the contract org), a discard of a
// document that is not a card's draft, a roll over an org with no retainer, a renewal of a project
// with no retainer, and a refund preflight
// of a document that is not an advance. Not part of any suite run (it skips unless
// CONTRACT_RECORD=1): run it by path when these entries' bridge calls change, read what it wrote,
// commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-invoicing-retainer.recorder.test.ts)
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
const REC = "7a000000-0000-4000-8000-00000000c2a1"
const OTHER = "7f000000-0000-4000-8000-00000000c2a1"

const PLAN: RecordingStep[] = [
  {
    entry: "tool:retainer_draft_from_reconcile",
    input: () => ({
      params: { reconciliationId: REC, revision: 1 },
      expectError: {
        reason:
          "the contract org has no projects app, so the retainer month's card cannot be read and nothing is drafted: pins that refusal; the drafting path is proven by retainer.test.ts",
      },
    }),
  },
  {
    entry: "tool:reconcile_draft_discard",
    input: () => ({
      params: { draft_id: OTHER },
      expectError: {
        reason:
          "no draft made from a card has this id, so nothing is discarded: pins that refusal; the discard path is proven by retainer.test.ts",
      },
    }),
  },
  {
    entry: "preflight:advance_refund_prepare",
    input: () => ({
      params: { advanceDocumentId: OTHER },
      expectError: {
        reason:
          "no advance invoice has this id, so the preflight refuses: pins that refusal; the refund path is proven by advances.test.ts",
      },
    }),
  },
  { entry: "job:retainer-timebox-roll", input: () => ({ params: {} }) },
  // A signed renewal for a project with no retainer schedule: it renews nothing.
  {
    entry: "tool:retainer_terms_renew",
    input: () => ({
      params: {
        projectId: "7a1d2c3e-0000-4000-8000-0000000000aa",
        agreementId: "7a1d2c3e-0000-4000-8000-0000000000ab",
        agreementNumber: "AG-2026-001",
        startsOn: "2026-12-01",
        minutes: 2640,
        feeMinor: "495000",
      },
      expectError: {
        reason:
          "the contract org has no retainer schedule, so the renewal renews nothing: pins that refusal; the renewal itself is proven by retainer-renewal.test.ts",
      },
    }),
  },
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record invoicing retainer fixtures", () => {
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
      recordedFrom: "the contract org on a local stack, record-invoicing-retainer.recorder.test.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: {},
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => !/^ok[ ?] /.test(l))).toEqual([])
  }, 600_000)
})
