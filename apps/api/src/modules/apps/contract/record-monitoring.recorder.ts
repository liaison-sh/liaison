// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the monitoring app's contract fixtures (fixtures/monitoring/*.json).
// The app has no provider: an alert is a signed delivery from the org's own
// watchdog, so the plan signs its deliveries with a stand-in secret. Not part of
// any suite: run it by path when the app's bridge calls change, read what it
// wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-monitoring.recorder.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run"
import { CONTRACT_ORG_ID } from "./replay-bridge"

const APP = "monitoring"
const SECRET = "contract-webhook-secret-not-real"
/** The contract isolate's virtual clock starts here (isolate.ts): a fresh delivery is signed now. */
const NOW = "2026-01-01T00:00:00.000Z"
const CONFIG = {
  monitoringWebhookSecret: SECRET,
  monitoringUrl: "https://status.example.com",
  monitoringSources: [{ source: "watchdog", label: "Watchdog", rank: 1, urgent: true }],
}

type Rec = Record<string, unknown>
const params = (p: Rec) => ({ params: p })

const ALERT = {
  source: "watchdog",
  severity: "critical",
  title: "API health check failing on node a",
  body: "GET /healthz answered 503 three times in a row",
  dedupKey: "api-health-node-a",
  url: "https://status.example.com/checks/api-health",
  ts: NOW,
}

function signed(body: Rec): { headers: Record<string, string>; body: string } {
  const text = JSON.stringify(body)
  return {
    headers: {
      "content-type": "application/json",
      "x-monitoring-signature": createHmac("sha256", SECRET).update(text).digest("base64"),
      "x-monitoring-delivery-id": "contract-delivery-1",
    },
    body: text,
  }
}

const INCIDENT = "INC-1"

const PLAN: RecordingStep[] = [
  {
    entry: "webhook-verify:alert",
    input: () => {
      const d = signed(ALERT)
      return params({ headers: d.headers, body: d.body, method: "POST", query: {} })
    },
  },
  {
    entry: "webhook:alert",
    input: () => {
      const d = signed(ALERT)
      return { params: JSON.parse(d.body), extraArgs: [d.headers] }
    },
  },
  { entry: "tool:incidents_list", input: () => params({ status: "open", limit: 10 }) },
  { entry: "tool:incidents_get", input: () => params({ incidentId: INCIDENT }) },
  {
    entry: "tool:incidents_comment",
    input: () =>
      params({ incidentId: INCIDENT, body: "Node a restarted, watching the next checks." }),
  },
  { entry: "tool:incidents_ack", input: () => params({ incidentId: INCIDENT }) },
  {
    entry: "tool:incidents_resolve",
    input: () =>
      params({ incidentId: INCIDENT, resolutionNote: "Disk full on node a; logs rotated." }),
  },
  { entry: "tool:incidents_summary", input: () => params({}) },
  { entry: "tool:webhook_info", input: () => params({}) },
  {
    entry: "job:assign-refs",
    // A new incident still waiting for its ref, as one that arrived while another numberer held the lease.
    before: async () => {
      await sql`INSERT INTO app_monitoring.incidents
        (org_id, source, severity, title, status, count, first_seen_at, last_seen_at, dedup_key)
        VALUES (${CONTRACT_ORG_ID}, 'watchdog', 'warning', 'Queue latency above 30 s', 'open', 1,
          ${NOW}, ${NOW}, 'queue-latency')`
    },
    input: () => params({}),
  },
]

describe("record monitoring contract fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>

  beforeAll(async () => {
    await acquireTestLock()
    installed = await installForRecording(APP, CONFIG)
    await sql`DELETE FROM app_monitoring.incident_comments WHERE org_id = ${CONTRACT_ORG_ID}`
    await sql`DELETE FROM app_monitoring.incidents WHERE org_id = ${CONTRACT_ORG_ID}`
    await sql`DELETE FROM kernel.app_sequences WHERE org_id = ${CONTRACT_ORG_ID}`.catch(
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
      recordedFrom: "the contract org on a local stack, record-monitoring.recorder.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: CONFIG,
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => !l.startsWith("ok "))).toEqual([])
  }, 600_000)
})
