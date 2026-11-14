// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the invoicing app's contract fixtures for the planned vs done tools
// (fixtures/invoicing/tool__preview_totals.json, tool__draft_from_reconcile.json,
// tool__document_attachment_add.json): a card's preview against the issuer profile, a draft
// asked for a reconciliation projects does not know (refused, nothing made), and an annex whose
// file the caller cannot read (refused, nothing filed). Not part of any suite run (it skips
// unless CONTRACT_RECORD=1): run it by path when these tools' bridge calls change, read what it
// wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-invoicing-reconcile.recorder.test.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { insertAppRow } from "~/seed/factories/app-tables"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run.test-helpers"
import { CONTRACT_ORG_ID } from "./replay-bridge"

const APP = "invoicing"
const PROJECT = "7a000000-0000-4000-8000-00000000c1de"
const COMPANY = "7c000000-0000-4000-8000-00000000c1de"
const ISSUER = "7b000000-0000-4000-8000-00000000c1de"
const DRAFT = "7d000000-0000-4000-8000-0000000000a1"
const RECONCILIATION = "7e000000-0000-4000-8000-0000000000a1"
const FILE = "7f000000-0000-4000-8000-0000000000a1"

const PLAN: RecordingStep[] = [
  {
    entry: "tool:preview_totals",
    before: async () => {
      await withPrivilegedDb(CONTRACT_ORG_ID, "contract-recording", async (tx) => {
        await insertAppRow(tx, APP, "issuer_profiles", {
          id: ISSUER,
          org_id: CONTRACT_ORG_ID,
          legal_name: "Contract Issuer SAS",
          country: "FR",
          vat_id: "FR60902000009",
          address: "2 rue Test, 75001 Paris",
          default_currency: "EUR",
          default_language: "fr",
        })
      })
    },
    input: () => ({
      params: {
        projectId: PROJECT,
        basis: "daily",
        companyId: COMPANY,
        currency: "EUR",
        rateMinor: 93000,
        hoursPerDayMinutes: 420,
        lines: [{ billMinutes: 1260 }, { billMinutes: 1680 }],
      },
    }),
  },
  {
    entry: "tool:draft_from_reconcile",
    input: () => ({
      params: { reconciliationId: RECONCILIATION, revision: 1 },
      expectError: {
        reason:
          "the contract org has no projects app holding this reconciliation, so the billed lines cannot be read: pins that refusal (nothing made); the working path is proven by from-reconcile.test.ts",
      },
    }),
  },
  {
    entry: "tool:document_attachment_add",
    before: async () => {
      await withPrivilegedDb(CONTRACT_ORG_ID, "contract-recording", async (tx) => {
        await insertAppRow(tx, APP, "documents", {
          id: DRAFT,
          org_id: CONTRACT_ORG_ID,
          issuer_profile_id: ISSUER,
          type: "invoice",
          status: "draft",
          payment_status: "unpaid",
          currency: "EUR",
          subtotal_minor: "0",
          tax_total_minor: "0",
          grand_total_minor: "0",
        })
      })
    },
    input: () => ({
      params: { documentId: DRAFT, fileId: FILE, kind: "timesheet", partial: false },
      expectError: {
        reason:
          "no file with this id is readable by the recording actor, so the annex is refused and nothing is filed: pins that refusal; the filing path is proven by preview-totals.test.ts",
      },
    }),
  },
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record invoicing reconcile fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>

  const cleanup = async () => {
    await sql`DELETE FROM app_invoicing.document_attachments WHERE org_id = ${CONTRACT_ORG_ID} AND document_id = ${DRAFT}`
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${CONTRACT_ORG_ID} AND id = ${DRAFT}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${CONTRACT_ORG_ID} AND id = ${ISSUER}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    installed = await installForRecording(APP, {})
    await cleanup()
  }, 300_000)

  afterAll(async () => {
    await cleanup().catch(() => {})
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
        "the contract org on a local stack, record-invoicing-reconcile.recorder.test.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: {},
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => !l.startsWith("ok "))).toEqual([])
  }, 600_000)
})
