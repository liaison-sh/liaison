// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Org deletion leaves nothing of the org, counted independently of the purge.
//
// A target org and a neighbour are seeded the same way: rows through their own
// API (one object of each common kind), a bundled app's table row, a search
// document, an object under the org's storage prefix and Redis state (keys that
// name the org, and live agent turns whose meta hash names it). Every
// store holds something of the target before the deletion (floor > 0). The
// deletion runs through the operator command and the deletion job, as in
// production. Afterwards, with queries that do not reuse the purge's own
// residue scan:
//   rows:    no row of ANY table outside the system schemas mentions the
//            target's id in any column (the deletion ledger excepted: it is the
//            record that the deletion happened);
//   search:  no document of the index carries the target's id;
//   objects: no key of the whole bucket names the target's id;
//   redis:   no key of the database names the target's id, BullMQ's own job
//            keys excepted (a queued job of a deleted org is dropped at dispatch),
//            and no live agent turn's meta hash names it;
//   the neighbour's fingerprint and its stores are unchanged.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ListObjectsV2Command } from "@aws-sdk/client-s3"
import Redis from "ioredis"
import { MeiliSearch } from "meilisearch"
import { runOrgDeleteCli } from "~/cli/org-delete"
import { sql } from "~/db"
import { closeAllQueues } from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { getStorageClient, putObject } from "~/infra/storage/object-storage"
import { WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { bullPrefix, RESP_PROTOCOL } from "~/lib/redis"
import { recordAgentStreamEvent } from "~/modules/agent/runtime/stream-registry"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { processOrgDeleteJob } from "~/modules/org/delete/job"
import { IndexWriterTestAccess, writeIndexAndWait } from "~/modules/search/index-writer"
import { type AppInstallSnapshot, snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import {
  closeIsolationScans,
  type IsolationOrg,
  newIsolationOrg,
  orgFingerprint,
  seedOrgThroughApi,
  tablesMentioning,
} from "~/tests/helpers/org-isolation"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Apps this file installs are instance-wide rows: put them back after it.
let installs: AppInstallSnapshot | null = null

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const tag = crypto.randomUUID().slice(0, 8)
const INDEX = `test_org_residue_${tag}`
/** The record that a deletion happened: it names the org on purpose. */
const LEDGER_TABLES = new Set(["kernel.org_deletions"])

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})
const rawRedis = new Redis(env.REDIS_URL, { protocol: RESP_PROTOCOL, maxRetriesPerRequest: null })
const spies: Array<{ mockRestore(): void }> = []
let installRoot = ""
let prevAppsDir: string | undefined
let target: IsolationOrg & { slug: string }
let neighbour: IsolationOrg & { slug: string }

async function withSlug(org: IsolationOrg): Promise<IsolationOrg & { slug: string }> {
  const [row] = await sql<
    { slug: string }[]
  >`SELECT slug FROM kernel.organizations WHERE id = ${org.orgId}::uuid`
  return { ...org, slug: String(row?.slug) }
}

/** Seed one org in every store. */
async function seedEverywhere(org: IsolationOrg): Promise<void> {
  await seedOrgThroughApi(org, `residue-${org.orgId.slice(0, 8)}`)
  await sql`
    INSERT INTO app_monitoring.incidents (org_id, source, severity, title, first_seen_at, last_seen_at)
    VALUES (${org.orgId}::uuid, 'sec-invariant', 'warning', 'residue probe', now(), now())`
  await writeIndexAndWait({
    docs: [
      {
        id: `residue-${org.orgId}`,
        org_id: org.orgId,
        type: "document",
        title: `residue probe ${org.orgId}`,
      },
    ],
  })
  await putObject({
    key: `orgs/${org.orgId}/kernel/residue/probe.txt`,
    body: Buffer.from("probe"),
    contentType: "text/plain",
  })
  // Live presence, written the way a connected session writes it.
  const { redis } = await import("~/lib/redis")
  await new WebSocketManager(redis).setPresence(org.orgId, org.userId, "online")
  // A live agent turn: its keys are a hash of thread/agent/turn and do not name
  // the org, but they hold the turn's text and tool calls.
  const thread = crypto.randomUUID()
  await recordAgentStreamEvent(thread, org.orgId, "start")
  await recordAgentStreamEvent(thread, org.orgId, "delta", { delta: `turn text ${org.orgId}` })
}

async function searchDocs(orgId: string): Promise<number> {
  const page = await meili.index(INDEX).getDocuments({ limit: 1000 })
  return page.results.filter((d) => JSON.stringify(d).includes(orgId)).length
}

async function objectKeys(orgId: string): Promise<string[]> {
  const s3 = getStorageClient()
  const keys: string[] = []
  let token: string | undefined
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket: env.OBJECT_STORAGE_BUCKET, ContinuationToken: token }),
    )
    for (const o of r.Contents ?? []) if (o.Key?.includes(orgId)) keys.push(o.Key)
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function redisKeys(orgId: string): Promise<string[]> {
  const out: string[] = []
  let cursor = "0"
  do {
    const [next, keys] = await rawRedis.scan(cursor, "MATCH", `*${orgId}*`, "COUNT", 5000)
    cursor = next
    out.push(...keys.filter((k) => !k.startsWith(`${bullPrefix}:`)))
  } while (cursor !== "0")
  return out
}

/** Live agent turns whose meta hash names the org (their key names do not). */
async function liveTurnKeys(orgId: string): Promise<string[]> {
  const out: string[] = []
  let cursor = "0"
  do {
    const [next, keys] = await rawRedis.scan(cursor, "MATCH", "*agent:turn:*:meta", "COUNT", 5000)
    cursor = next
    for (const k of keys) if ((await rawRedis.hget(k, "orgId")) === orgId) out.push(k)
  } while (cursor !== "0")
  return out
}

async function storesOf(orgId: string) {
  return {
    search: await searchDocs(orgId),
    objects: (await objectKeys(orgId)).length,
    redis: (await redisKeys(orgId)).length,
    liveTurns: (await liveTurnKeys(orgId)).length,
  }
}

beforeAll(async () => {
  await acquireTestLock()
  installs = await snapshotAppInstalls()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX))
  IndexWriterTestAccess.resetRebuildCache()
  const created = await meili.createIndex(INDEX, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const settings = await meili.index(INDEX).updateSettings({ filterableAttributes: ["org_id"] })
  await meili.tasks.waitForTask(settings.taskUid)

  installRoot = mkdtempSync(join(tmpdir(), "org-residue-apps-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
  // The instance's own (operator) org is the oldest and is never deletable:
  // made first so the target is an ordinary tenant.
  await newIsolationOrg()
  target = await withSlug(await newIsolationOrg())
  neighbour = await withSlug(await newIsolationOrg())
  const manifest = JSON.parse(
    readFileSync(join(REPO, "bundled-apps", "monitoring", "app.manifest.json"), "utf8"),
  ) as { scopes?: string[]; connections?: Record<string, unknown> }
  await installAppFromTarball({
    tarballPath: firstPartyAppTarball("monitoring"),
    installedBy: target.userId,
    grantedScopes: manifest.scopes ?? [],
    grantedConnections: Object.keys(manifest.connections ?? {}),
    requireSignature: false,
    approveUiFullAccess: true,
  })
  await reloadInstalledApps(target.orgId)
  await reloadInstalledApps(neighbour.orgId)
  await seedEverywhere(target)
  await seedEverywhere(neighbour)
}, 600_000)

afterAll(async () => {
  for (const s of spies) s.mockRestore()
  await meili.deleteIndex(INDEX).catch(() => undefined)
  await shutdownWorkerPool()
  await closeAllQueues()
  await closeIsolationScans()
  rawRedis.disconnect()
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  await installs?.restore()
  await releaseTestLock()
}, 120_000)

describe("org deletion leaves no residue in any store", () => {
  it("deletes the org through the operator command and leaves nothing that names it", async () => {
    const tablesBefore = await tablesMentioning(target.orgId)
    const storesBefore = await storesOf(target.orgId)
    const neighbourRows = await orgFingerprint(neighbour.orgId)
    const neighbourStores = await storesOf(neighbour.orgId)
    // Floor: the target is really in every store before its deletion.
    expect(Object.keys(tablesBefore).length).toBeGreaterThan(10)
    expect(tablesBefore["app_monitoring.incidents"]).toBeGreaterThan(0)
    expect(storesBefore.search).toBeGreaterThan(0)
    expect(storesBefore.objects).toBeGreaterThan(0)
    expect(storesBefore.redis).toBeGreaterThan(0)
    expect(storesBefore.liveTurns).toBeGreaterThan(0)
    console.log(
      `org deletion residue: before, ${Object.keys(tablesBefore).length} tables name the target; stores ${JSON.stringify(storesBefore)}`,
    )

    const res = await runOrgDeleteCli(
      [
        target.slug,
        "--yes",
        target.slug,
        "--no-legal-archive",
        "--without-export-i-accept-losing-the-org-data",
      ],
      {
        warn: () => undefined,
        pollMs: 50,
        operator: "test@host",
        recipient: null,
        enqueue: async (p) => {
          void processOrgDeleteJob(p, { sleep: async () => undefined, heartbeatMs: 1000 })
        },
      },
    )
    expect(res.message).toBeUndefined()
    expect(res.exitCode).toBe(0)
    expect((res.report as { status?: string } | null)?.status).toBe("completed")

    const left = await tablesMentioning(target.orgId)
    for (const t of LEDGER_TABLES) delete left[t]
    expect(left).toEqual({})
    expect(await searchDocs(target.orgId)).toBe(0)
    expect(await objectKeys(target.orgId)).toEqual([])
    expect(await redisKeys(target.orgId)).toEqual([])
    expect(await liveTurnKeys(target.orgId)).toEqual([])

    expect(await orgFingerprint(neighbour.orgId)).toEqual(neighbourRows)
    expect(await storesOf(neighbour.orgId)).toEqual(neighbourStores)
  }, 600_000)
})
