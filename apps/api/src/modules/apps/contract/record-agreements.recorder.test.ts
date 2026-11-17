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
    { type: "heading", text: "1. Term" },
    { type: "paragraph", text: "This agreement lasts two years." },
  ],
}

/** A person's own click on one of the app's gated tools, as the kernel's mint requires. */
const click = (tool: string) => ({
  origin: "human-ui",
  personScopes: ["agreements:agreements:read", "agreements:agreements:write"],
  callChain: [`agreements:${tool}`],
})

/**
 * The contract org's recording person holds no role in it, so the kernel's read of a version
 * (run with that person's own permissions before any link is minted) refuses, and no link
 * exists for the later steps. These record the refusal each tool gives; the working path runs
 * end to end in src/tests/integration/agreements-decided.integration.test.ts.
 */
const NO_LINK =
  "the recording person holds no role in the contract org, so no link is minted and the tool refuses as recorded; the working path runs in agreements-decided.integration.test.ts"
const VOID_REASON =
  "the version was never sent (no link could be minted here), so a void is refused as a document not waiting for signatures"
const NOT_SIGNED =
  "the agreement was never signed here (no link could be minted), so it has no evidence to read or check"
const refused = (p: Rec, reason = NO_LINK) => ({ params: p, expectError: { reason } })
const PARENT_UNSIGNED =
  "a change request goes only on a signed agreement; the contract org signs nothing, so it is refused before any card"
const changeRequest = (parent: unknown, version: unknown): Rec => ({
  parent_agreement_id: parent,
  title: "Single sign-on",
  work: ["Sign-in with the client's identity provider"],
  hours_minutes: 3600,
  hours_source: "past similar work",
  rate_minor: "10000",
  reply: {
    conversation_id: "00000000-0000-4000-8000-0000000000c1",
    body: "Here is a change request.",
  },
  passage: { version_id: version, section: "1" },
  mail_message_id: "contract-mail-1",
})

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
  {
    entry: "tool:agreement_prepare",
    input: (s) => params({ id: s.values.nda }),
    after: (answer, s) => {
      const a = answer as { version_id?: string; sha256?: string }
      s.values.version = String(a.version_id)
      s.values.sha = String(a.sha256)
    },
  },
  {
    entry: "tool:agreement_passage_get",
    input: (s) => params({ version_id: s.values.version, section: "1" }),
  },
  {
    entry: "preflight:agreement_send",
    input: (s) =>
      params({
        version_id: s.values.version,
        sha256: s.values.sha,
        signers: [{ email: "paul@maison-verre.example", name: "Paul Verre" }],
      }),
  },
  {
    // A person's own click on the send: the kernel reads the version before any link.
    entry: "tool:agreement_send",
    input: (s) =>
      refused({
        version_id: s.values.version,
        sha256: s.values.sha,
        signers: [{ email: "paul@maison-verre.example", name: "Paul Verre" }],
      }),
    bridgeOptions: () => click("agreement_send"),
    after: (answer, s) => {
      const a = answer as { client_actions?: Array<{ id: string }> }
      s.values.link = a.client_actions?.[0]?.id ?? "00000000-0000-4000-8000-0000000000a1"
    },
  },
  {
    entry: "tool:client_action_view_get",
    input: (s) => params({ targetType: "agreement_version", targetId: s.values.version }),
  },
  {
    entry: "preflight:agreement_reminder_send",
    input: (s) => refused({ client_action_ids: [s.values.link] }),
  },
  {
    entry: "tool:agreement_reminder_send",
    input: (s) => refused({ client_action_ids: [s.values.link] }),
    bridgeOptions: () => click("agreement_reminder_send"),
  },
  {
    entry: "preflight:agreement_new_link",
    input: (s) => refused({ client_action_id: s.values.link }),
  },
  {
    entry: "tool:agreement_new_link",
    input: (s) =>
      refused({ client_action_id: s.values.link, email: "paul.verre@maison-verre.example" }),
    bridgeOptions: () => click("agreement_new_link"),
  },
  {
    entry: "preflight:agreement_void",
    input: (s) => refused({ id: s.values.nda, reason: "Terms changed" }, VOID_REASON),
  },
  {
    entry: "tool:agreement_void",
    input: (s) => refused({ id: s.values.nda, reason: "Terms changed" }, VOID_REASON),
    bridgeOptions: () => click("agreement_void"),
  },
  { entry: "job:decided-reconcile", input: () => ({ params: {} }) },
  { entry: "job:dates-daily", input: () => ({ params: {} }) },
  { entry: "job:seal-retry", input: () => ({ params: {} }) },
  { entry: "job:timestamp-retry", input: () => ({ params: {} }) },
  { entry: "job:copies-retry", input: () => ({ params: {} }) },
  { entry: "job:evidence-verify", input: () => ({ params: {} }) },
  { entry: "job:upload-freeze", input: () => ({ params: {} }) },
  { entry: "job:upload-rescan", input: () => ({ params: {} }) },
  { entry: "job:change-request-effects", input: () => ({ params: {} }) },
  { entry: "job:scope-group-reconcile", input: () => ({ params: {} }) },
  {
    entry: "tool:agreement_import",
    input: () =>
      refused(
        {
          kind: "msa",
          title: "Framework agreement 2024",
          file_id: "00000000-0000-4000-8000-0000000000f1",
          signed_on: "2024-03-01",
          unverified_text: "1. Purpose",
        },
        "the contract org holds no uploaded PDF, so the file cannot be read and nothing is imported (the agreement made for it is withdrawn)",
      ),
  },
  {
    entry: "tool:agreement_evidence_get",
    input: (s) => refused({ id: s.values.nda }, NOT_SIGNED),
  },
  {
    entry: "tool:agreement_verify",
    input: (s) => refused({ id: s.values.nda }, NOT_SIGNED),
  },
  {
    entry: "preflight:change_request_send",
    input: (s) => refused(changeRequest(s.values.nda, s.values.version), PARENT_UNSIGNED),
  },
  {
    entry: "tool:change_request_send",
    input: (s) => refused(changeRequest(s.values.nda, s.values.version), PARENT_UNSIGNED),
    bridgeOptions: () => click("change_request_send"),
  },
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
    // A clean contract org: a rerun records the same rows. The plan freezes one version, which
    // is immutable: a rerun on the same database starts from a fresh contract org instead.
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
    expect(report.filter((l) => l.startsWith("FAIL") || l.startsWith("WEAK"))).toEqual([])
  }, 600_000)
})
