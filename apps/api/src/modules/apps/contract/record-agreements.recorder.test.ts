// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the agreements app's contract fixtures (fixtures/agreements/*.json). The app has no
// provider: every entry reads and writes its own tables. Not part of any suite run (it skips
// unless CONTRACT_RECORD=1): run it by path when the app's bridge calls change, read what it
// wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-agreements.recorder.test.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { schemaRef } from "~/db/schema-ref"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run.test-helpers"
import { CONTRACT_ORG_ID } from "./replay-bridge"

const APP = "agreements"

type Rec = Record<string, unknown>
const params = (p: Rec) => ({ params: p })
const id = (answer: unknown, path: "agreement" | "template"): string => {
  const a = answer as { agreement?: { id?: string }; template_id?: string }
  return String(path === "agreement" ? a.agreement?.id : a.template_id)
}

const BODY = {
  blocks: [
    { type: "heading", text: "Mutual non-disclosure agreement" },
    { type: "paragraph", text: "Each party keeps the other's information confidential." },
  ],
}

const PLAN: RecordingStep[] = [
  {
    entry: "tool:template_save",
    input: () => params({ name: "Mutual NDA", kind: "nda", language: "en", body: BODY }),
    after: (answer, s) => {
      s.values.template = id(answer, "template")
    },
  },
  { entry: "tool:templates_list", input: () => params({}) },
  { entry: "tool:template_get", input: (s) => params({ template_id: s.values.template }) },
  {
    entry: "tool:agreement_create",
    input: (s) =>
      params({ kind: "nda", title: "NDA with Maison Verre", template_id: s.values.template }),
    after: (answer, s) => {
      s.values.nda = id(answer, "agreement")
    },
  },
  {
    entry: "tool:agreement_create",
    record: false,
    input: () => params({ kind: "proposal", title: "Website proposal" }),
    after: (answer, s) => {
      s.values.proposal = id(answer, "agreement")
    },
  },
  {
    entry: "tool:agreement_update",
    input: (s) => params({ id: s.values.nda, lock_version: 1, renews_on: "2027-06-30" }),
  },
  {
    entry: "tool:agreement_price_set",
    input: (s) => params({ id: s.values.proposal, price_minor: "1200000", currency: "EUR" }),
  },
  { entry: "tool:agreement_prepare", input: (s) => params({ id: s.values.nda }) },
  { entry: "tool:agreement_get", input: (s) => params({ id: s.values.nda }) },
  { entry: "tool:agreements_search", input: () => params({ kind: "nda" }) },
  { entry: "tool:home_load", input: () => params({ limit: 20 }) },
  {
    entry: "tool:approval_route_read",
    input: (s) => params({ entityType: "agreements:agreement", entityId: s.values.nda }),
  },
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record agreements contract fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>

  beforeAll(async () => {
    await acquireTestLock()
    installed = await installForRecording(APP, {})
    // A clean contract org: a rerun records the same rows (no agreement table here is immutable
    // until a version is frozen, and the plan freezes none).
    for (const t of [
      "agreement_shares",
      "agreement_drafts",
      "agreements",
      "agreement_template_versions",
      "agreement_template_meta",
    ]) {
      await sql.unsafe(`DELETE FROM app_agreements.${t} WHERE org_id = $1`, [CONTRACT_ORG_ID])
    }
    await sql`DELETE FROM ${sql(schemaRef("kernel"))}.app_sequences WHERE org_id = ${CONTRACT_ORG_ID}`.catch(
      () => undefined,
    )
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
      recordedFrom: "the contract org on a local stack, record-agreements.recorder.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: {},
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => !l.startsWith("ok ") && !l.startsWith("  (prereq)"))).toEqual([])
  }, 600_000)
})
