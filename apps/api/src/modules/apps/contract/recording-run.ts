// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shared half of an app's fixture recorder (`record-<app>.recorder.ts`):
// install the bundled app for the contract's own org and user
// (replay-bridge.ts ids), give it a connection, then run a recording plan,
// step by step, on the live bridge (recorder.ts): each step names a contract
// entry, builds its input from what earlier steps found or created, and may
// read the answer for later steps. A fixture is scrubbed, replayed twice and
// checked for the given secrets before it is written. Not part of any suite: a
// developer runs the app's recorder by path against the provider's sandbox
// account, reads what it wrote and commits it.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import { createWebhookVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { BUNDLED_APPS_DIR, bridgeSurfaceOf, verifySurface } from "./apps.test-helpers"
import { type ContractEntry, contractEntries } from "./entries"
import { bundledAppScripts, productionLimits } from "./harness"
import type { ContractIsolate } from "./isolate"
import { quickJsContractExecutor } from "./quickjs-isolate"
import {
  type RecordInput,
  type Replacement,
  recordEntry,
  scrubFixture,
  verifyFixture,
  writeFixture,
} from "./recorder"
import { CONTRACT_ORG_ID, CONTRACT_USER_ID } from "./replay-bridge"

export interface RecordingState {
  values: Record<string, unknown>
}

export interface RecordingStep<S extends RecordingState = RecordingState> {
  entry: string
  input: (s: S) => RecordInput | Promise<RecordInput>
  /** Read the answer (the handler's result, or `{ thrown }`) for later steps. */
  after?: (answer: unknown, s: S) => void | Promise<void>
  /** False: run it (a prerequisite) without writing a fixture. */
  record?: boolean
  /** Run before the entry, outside the recording (seed a row the entry needs). */
  before?: (s: S) => void | Promise<void>
}

type Manifest = Record<string, unknown> & { name: string; version: string }

export const RECORDING_ACTOR: UserContext = {
  actorType: "user",
  userId: CONTRACT_USER_ID,
  orgId: CONTRACT_ORG_ID,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}

export function readBundledManifest(app: string): Manifest {
  return JSON.parse(
    readFileSync(join(BUNDLED_APPS_DIR, app, "app.manifest.json"), "utf8"),
  ) as Manifest
}

/** The contract org and user, the app registered for them, its config set. */
export async function installForRecording(
  app: string,
  config: Record<string, unknown>,
): Promise<{ manifest: Manifest; bridgeManifest: unknown }> {
  const manifest = readBundledManifest(app)
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${CONTRACT_ORG_ID}, 'Contract recording', 'contract-recording') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${CONTRACT_USER_ID}, ${CONTRACT_ORG_ID}, 'recorder@example.com', 'Contract Recorder', 'x')
    ON CONFLICT DO NOTHING`
  await ensureAppsForOrg(CONTRACT_ORG_ID)
  await registerApps(
    [
      {
        ...manifest,
        trusted: false,
        _firstParty: true,
        _format: "manifest",
        _bundlePath: join(BUNDLED_APPS_DIR, app, manifest.version, "bundle.js"),
      },
    ] as never,
    CONTRACT_ORG_ID,
  )
  const tools = Object.keys((manifest.tools as Record<string, unknown>) ?? {})
  const bridgeManifest = (
    toolRegistry.get([CONTRACT_ORG_ID, app, tools[0] ?? ""]) as { _manifest?: unknown } | undefined
  )?._manifest
  if (!bridgeManifest) throw new Error(`${app} did not register`)
  await sql`INSERT INTO kernel.apps (org_id, name, version, config)
    VALUES (${CONTRACT_ORG_ID}, ${app}, ${manifest.version}, ${JSON.stringify(config)}::jsonb)
    ON CONFLICT (org_id, name) DO UPDATE SET config = EXCLUDED.config`
  return { manifest, bridgeManifest }
}

/** An org credentials connection for `app`, replacing any earlier one. */
export async function connectCredentials(
  app: string,
  connection: string,
  identifier: string,
  fields: Record<string, string>,
): Promise<string> {
  await sql`DELETE FROM kernel.connected_accounts
    WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = ${app}`
  const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.connected_accounts
    (org_id, app_name, connection_name, owner_type, provider_type, identifier, display_name,
     credentials_encrypted, status, created_by)
    VALUES (${CONTRACT_ORG_ID}, ${app}, ${connection}, 'org', 'credentials', ${identifier},
     ${identifier}, ${encryptSecret(JSON.stringify(fields), env.ENCRYPTION_KEY, CryptoContext.connectedAccountCredentials)},
     'active', ${CONTRACT_USER_ID})
    RETURNING id`
  return row!.id
}

export async function uninstallAfterRecording(app: string): Promise<void> {
  await teardownAppRegistrations(CONTRACT_ORG_ID, app)
  toolRegistry.deleteByPrefix([CONTRACT_ORG_ID])
  initializedOrgRuntimes.delete(CONTRACT_ORG_ID)
}

/** Run `plan` on the live bridge, writing one scrubbed, replay-checked fixture per recorded step. */
export async function runRecordingPlan<S extends RecordingState>(opts: {
  app: string
  manifest: Manifest
  bridgeManifest: unknown
  plan: RecordingStep<S>[]
  state: S
  replacements: Replacement[]
  /** Literals that must not survive scrubbing (tokens, keys). */
  secrets: string[]
  recordedFrom: string
  fixturesDir: string
  appConfig: Record<string, unknown>
}): Promise<string[]> {
  const { app, manifest } = opts
  const entries = new Map<string, ContractEntry>(contractEntries(manifest).map((e) => [e.entry, e]))
  const surface = bridgeSurfaceOf(app)
  const scripts = await bundledAppScripts(join(BUNDLED_APPS_DIR, app))
  const isolate: ContractIsolate = await quickJsContractExecutor.open(scripts.source, {
    memoryBytes: 64 * 1024 * 1024,
  })
  const liveBridge = (job?: { name: string; payload: Record<string, unknown> }): AppBridge =>
    createSessionRpcBridge(
      app,
      CONTRACT_USER_ID,
      CONTRACT_ORG_ID,
      { run: (fn) => withRlsContext(RECORDING_ACTOR, fn) },
      opts.bridgeManifest as never,
      ["*"],
      "user",
      undefined,
      {
        actor: RECORDING_ACTOR,
        ...(job
          ? {
              currentJob: {
                name: job.name,
                payload: job.payload,
                timeoutMs: 60_000,
                atomic: false,
              },
            }
          : {}),
      } as never,
    ) as AppBridge
  const only = process.env.CONTRACT_RECORD_ONLY ? new Set(process.env.CONTRACT_RECORD_ONLY.split(",")) : null
  const report: string[] = []
  try {
    for (const step of opts.plan) {
      const entry = entries.get(step.entry)
      if (!entry)
        throw new Error(`the plan names ${step.entry}, which the manifest does not declare`)
      await step.before?.(opts.state)
      const input = await step.input(opts.state)
      const params = input.params as Record<string, unknown> | undefined
      const job =
        entry.kind === "job" ? { name: entry.entry.slice(4), payload: params ?? {} } : undefined
      const verifier = entry.kind === "webhook-verify"
      const entrySurface = verifier ? verifySurface() : surface
      const real = verifier
        ? (createWebhookVerifyBridge({
            appOrgId: CONTRACT_ORG_ID,
            appName: app,
            appConfig: opts.appConfig,
            manifestConnections: manifest.connections as never,
          }) as AppBridge)
        : liveBridge(job)
      const { fixture, outcome } = await recordEntry({
        isolate,
        entry,
        input,
        real,
        surface: entrySurface,
        limits: productionLimits(entry),
        recordedFrom: opts.recordedFrom,
      })
      const answer = outcome.ok ? outcome.result : { thrown: outcome.error }
      await step.after?.(answer, opts.state)
      const summary = JSON.stringify(answer)?.slice(0, process.env.CONTRACT_RECORD_DEBUG ? 3000 : 160)
      if ((only && !only.has(step.entry)) || step.record === false) {
        report.push(`  (prereq) ${step.entry}: ${summary}`)
        continue
      }
      const rejected =
        !outcome.ok ||
        (answer !== null && typeof answer === "object" && "error" in (answer as object))
      if (rejected && fixture.calls.length === 0) {
        report.push(
          `WEAK ${step.entry}: rejected its input before any call, not written | ${summary}`,
        )
        continue
      }
      // A secret the app stores (a provider-minted webhook signing secret) is scrubbed to the
      // stand-in the key-based scrub gives the provider's answer, so the replay still matches.
      const stored = fixture.calls
        .filter((c) => c.method === "config_setSecret" && typeof c.args[1] === "string")
        .map((c) => ({ from: c.args[1] as string, to: "redacted" }))
      const scrubbed = scrubFixture(fixture, [...opts.replacements, ...stored])
      const problem = await verifyFixture({
        isolate,
        entry,
        fixture: scrubbed,
        surface: entrySurface,
        limits: productionLimits(entry),
      })
      if (problem) {
        report.push(`FAIL ${step.entry}: ${problem} | ${summary}`)
        continue
      }
      const text = JSON.stringify(scrubbed)
      const leaked = opts.secrets.filter((s) => s && text.includes(s))
      if (leaked.length > 0) throw new Error(`${step.entry}: a secret survived scrubbing`)
      writeFixture(opts.fixturesDir, app, scrubbed)
      report.push(
        `${rejected ? "ok?" : "ok "} ${step.entry} (${scrubbed.calls.length} calls): ${summary}`,
      )
    }
  } finally {
    isolate.dispose()
  }
  return report
}
