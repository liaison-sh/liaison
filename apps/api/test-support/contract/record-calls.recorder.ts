// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the calls app's contract fixtures (fixtures/calls/*.json). The app
// has no provider of its own: a transcript adapter signs segment deliveries
// with the org's webhook secret, and the app keeps one knowledge document per
// call through the knowledge app. The plan signs its deliveries with a stand-in
// secret; the knowledge calls are real (the recording org's own knowledge app).
// Not part of any suite run (it skips unless CONTRACT_RECORD=1): run it by
// path when the app's bridge calls change, read what it wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./test-support/contract/record-calls.recorder.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { runReindex } from "~/modules/search/reindex"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run"
import { CONTRACT_ORG_ID } from "~/modules/apps/contract/replay-bridge"

const APP = "calls"
const SECRET = "contract-calls-secret-not-real"
/** The contract isolate's virtual clock starts here (isolate.ts): a fresh delivery is signed now. */
const NOW = "2026-01-01T00:00:00.000Z"
const CONFIG = { callsWebhookSecret: SECRET }
const CALL_REF = "meet-2026-01-01-weekly-sync"

type Rec = Record<string, unknown>
const params = (p: Rec) => ({ params: p })

function signed(body: Rec, deliveryId: string): { headers: Record<string, string>; body: string } {
  const text = JSON.stringify(body)
  return {
    headers: {
      "content-type": "application/json",
      "x-calls-signature": createHmac("sha256", SECRET).update(text).digest("base64"),
      "x-calls-delivery-id": deliveryId,
    },
    body: text,
  }
}

const SEGMENT_1 = {
  callRef: CALL_REF,
  kind: "segment",
  segmentId: "seg-0001",
  ts: "2025-12-31T23:58:10.000Z",
  speaker: "Host",
  text: "Thanks for joining. Today we go through the spring order and the delivery dates.",
}
const SEGMENT_2 = {
  callRef: CALL_REF,
  kind: "segment",
  segmentId: "seg-0002",
  ts: NOW,
  speaker: "Customer",
  text: "We need the first 40 units before the 15th of March, the rest can follow in April.",
}

const delivery = (body: Rec, id: string) => {
  const d = signed(body, id)
  return { params: JSON.parse(d.body), extraArgs: [d.headers] }
}

const PLAN: RecordingStep[] = [
  {
    entry: "webhook-verify:segment",
    input: () => {
      const d = signed(SEGMENT_2, "delivery-0002")
      return params({ headers: d.headers, body: d.body, method: "POST", query: {} })
    },
  },
  // The call's first segment creates its document; the recorded one appends to it.
  { entry: "webhook:segment", record: false, input: () => delivery(SEGMENT_1, "delivery-0001") },
  { entry: "webhook:segment", input: () => delivery(SEGMENT_2, "delivery-0002") },
  {
    entry: "tool:calls_list",
    // The list searches knowledge: build the namespace index first, as the indexer would.
    before: async () => {
      await runReindex()
    },
    input: () => params({ limit: 10 }),
  },
  {
    entry: "tool:calls_segments_since",
    input: () => params({ callRef: CALL_REF, since: SEGMENT_1.ts, limit: 50 }),
  },
  {
    entry: "tool:calls_set_links",
    input: () =>
      params({
        callRef: CALL_REF,
        contactId: "6f1c2a4e-8b0d-4c3e-9a51-2d7e0b9c4f10",
        dealTaskId: "3b9e7d21-54a0-4f6c-8e12-90c4d5a6b7e8",
      }),
  },
  { entry: "tool:webhook_info", input: () => params({}) },
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record calls contract fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>

  beforeAll(async () => {
    await acquireTestLock()
    installed = await installForRecording(APP, CONFIG)
    // A clean slate: the call's document from an earlier recording run goes.
    await sql`DELETE FROM app_knowledge.documents
      WHERE org_id = ${CONTRACT_ORG_ID} AND title LIKE ${`%${CALL_REF}`}`
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
      replacements: [{ from: SECRET, to: "calls-webhook-secret-stand-in" }],
      secrets: [SECRET],
      recordedFrom: "the contract org on a local stack, record-calls.recorder.ts",
      fixturesDir: join(import.meta.dir, "../../src/modules/apps/contract/fixtures"),
      appConfig: CONFIG,
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => !l.startsWith("ok ") && !l.startsWith("  (prereq)"))).toEqual([])
  }, 600_000)
})
