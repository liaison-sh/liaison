// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the invoicing app's contract fixtures for the billing plan tools and the sweep of done
// milestones (fixtures/invoicing/tool__billing_plan_get.json, tool__billing_plan_set.json,
// tool__milestone_draft_create.json, tool__advance_draft_create.json,
// tool__advance_refund_prepare.json, preflight__advance_refund_prepare.json,
// job__billing-steps-sweep.json): an empty plan read, a plan
// whose project cannot be read (no projects app in the contract org), a task with no plan step, an
// advance with no customer, a refund of a document that is not an advance, and a sweep over an
// org with no plan. Not part of any suite run (it skips unless CONTRACT_RECORD=1): run it by path
// when these entries' bridge calls change, read what it wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-invoicing-billing-plan.recorder.test.ts)
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
const PROJECT = "7a000000-0000-4000-8000-00000000b1a1"
const ISSUER = "7b000000-0000-4000-8000-00000000b1a1"
const QUOTE = "7d000000-0000-4000-8000-00000000b1a1"
const TASK = "7e000000-0000-4000-8000-00000000b1a1"
const OTHER = "7f000000-0000-4000-8000-00000000b1a1"

const PLAN: RecordingStep[] = [
  { entry: "tool:billing_plan_get", input: () => ({ params: { projectId: PROJECT } }) },
  {
    entry: "tool:billing_plan_set",
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
        await insertAppRow(tx, APP, "documents", {
          id: QUOTE,
          org_id: CONTRACT_ORG_ID,
          issuer_profile_id: ISSUER,
          type: "quote",
          status: "accepted",
          payment_status: "unpaid",
          currency: "EUR",
          subtotal_minor: "1600000",
          tax_total_minor: "320000",
          grand_total_minor: "1920000",
        })
      })
    },
    input: () => ({
      params: {
        projectId: PROJECT,
        quoteDocumentId: QUOTE,
        steps: [{ kind: "final", label: "Launch", amountMinor: 1600000, taskId: TASK }],
      },
      expectError: {
        reason:
          "the contract org has no projects app, so the project's basis and tasks cannot be read: pins that refusal (no plan saved); the saving path is proven by billing-plan.test.ts",
      },
    }),
  },
  {
    entry: "tool:milestone_draft_create",
    input: () => ({
      params: { taskId: TASK },
      expectError: {
        reason:
          "the task invoices no plan step, so nothing is drafted: pins that refusal; the drafting path is proven by billing-plan.test.ts",
      },
    }),
  },
  {
    entry: "tool:advance_draft_create",
    input: () => ({
      params: { projectId: PROJECT, amountMinor: 100000 },
      expectError: {
        reason:
          "the project has no plan and no contact was given, so the advance has no customer and nothing is drafted: pins that refusal; the drafting path is proven by advances.test.ts",
      },
    }),
  },
  {
    entry: "tool:advance_refund_prepare",
    input: () => ({
      params: { advanceDocumentId: OTHER },
      expectError: {
        reason:
          "no advance invoice has this id, so no credit note is made: pins that refusal; the refund path is proven by advances.test.ts",
      },
    }),
  },
  {
    entry: "preflight:advance_refund_prepare",
    input: () => ({
      params: { advanceDocumentId: OTHER },
      expectError: {
        reason:
          "no advance invoice has this id, so the refund is refused before any approval is raised: pins that refusal; the refund path is proven by advances.test.ts",
      },
    }),
  },
  { entry: "job:billing-steps-sweep", input: () => ({ params: {} }) },
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")(
  "record invoicing billing plan fixtures",
  () => {
    let installed: Awaited<ReturnType<typeof installForRecording>>

    const cleanup = async () => {
      await sql`DELETE FROM app_invoicing.billing_steps WHERE org_id = ${CONTRACT_ORG_ID}`
      await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${CONTRACT_ORG_ID} AND id = ${QUOTE}`
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
          "the contract org on a local stack, record-invoicing-billing-plan.recorder.test.ts",
        fixturesDir: join(import.meta.dir, "fixtures"),
        appConfig: {},
      })
      console.log(`\n${report.join("\n")}\n`)
      expect(report.filter((l) => !/^ok[ ?] /.test(l))).toEqual([])
    }, 600_000)
  },
)
