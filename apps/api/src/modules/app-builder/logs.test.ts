// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.app_logs (migration 0276) on real Postgres: the per-run caps, the
// scope-tag filter (a reader whose scopes miss a row's tag sees nothing of
// it), draft preview lines for their run's person only, org isolation, no
// line written from a person's transaction, the retention prune, the custom
// app bridge's ctx.logger hook, and GET /api/apps/:name/logs.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { app } from "~/app"
import type { RlsClient } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { appLogs } from "~/db/schema/kernel"
import { createDraft, draftAppName } from "~/modules/app-builder/drafts"
import {
  createRunLogSink,
  flushRunLogs,
  LOG_FIELDS_MAX_BYTES,
  LOG_MESSAGE_MAX_BYTES,
  pruneAppLogs,
  RUN_LOG_MAX_BYTES,
  RUN_LOG_MAX_LINES,
  readAppLogs,
} from "~/modules/app-builder/logs"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let otherOrgId = ""
let admin = ""
let reader = ""
let otherAdmin = ""

function as<T>(
  userId: string,
  scopes: string[],
  fn: (tx: RlsClient) => Promise<T>,
  org = orgId,
): Promise<T> {
  return withRlsContext({ actorType: "user", userId, orgId: org, scopes, dimensionGrants: {} }, fn)
}

const LOGS = ["kernel:apps:logs"]

async function logRun(
  appName: string,
  lines: number,
  opts: { tags?: string[]; draftId?: string; actor?: string; org?: string; size?: number } = {},
): Promise<string> {
  const sink = createRunLogSink({
    orgId: opts.org ?? orgId,
    app: appName,
    draftId: opts.draftId ?? null,
    actorUserId: opts.actor ?? null,
    scopeTags: opts.tags ?? [],
  })
  for (let i = 0; i < lines; i++) {
    sink.append("info", opts.size ? `${i}:${"m".repeat(opts.size)}` : `line ${i}`, { i })
  }
  await sink.flush()
  return sink.runId
}

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "App Logs Org" })
  orgId = org.orgId
  admin = org.adminUserId
  reader = (await minimal.person(orgId)).id
  const other = await minimal.secondOrg({ name: "App Logs Other Org" })
  otherOrgId = other.orgId
  otherAdmin = other.adminUserId
})

afterAll(async () => {
  await releaseTestLock()
})

describe("app log writer caps", () => {
  it("keeps at most 200 lines per run, the last one saying more were dropped", async () => {
    const runId = await logRun("capped", RUN_LOG_MAX_LINES + 50)
    const rows = await as(admin, ["*"], (tx) =>
      readAppLogs(tx, { app: "capped", runId, limit: 200 }),
    )
    expect(rows).toHaveLength(RUN_LOG_MAX_LINES)
    const notices = rows.filter((r) => r.message.includes("Log limit reached"))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.level).toBe("warn")
  })

  it("keeps at most 256 KiB per run and cuts long messages and fields", async () => {
    const runId = await logRun("heavy", 150, { size: 3000 })
    const rows = await as(admin, ["*"], (tx) =>
      readAppLogs(tx, { app: "heavy", runId, limit: 200 }),
    )
    const bytes = rows.reduce(
      (n, r) => n + Buffer.byteLength(r.message) + Buffer.byteLength(JSON.stringify(r.fields)),
      0,
    )
    expect(bytes).toBeLessThanOrEqual(RUN_LOG_MAX_BYTES + 1024)
    expect(rows.length).toBeLessThan(150)

    const sink = createRunLogSink({ orgId, app: "long", scopeTags: [] })
    sink.append("error", "é".repeat(LOG_MESSAGE_MAX_BYTES), {
      blob: "b".repeat(LOG_FIELDS_MAX_BYTES * 2),
    })
    await sink.flush()
    const [row] = await as(admin, ["*"], (tx) =>
      readAppLogs(tx, { app: "long", runId: sink.runId }),
    )
    expect(Buffer.byteLength(row!.message)).toBeLessThanOrEqual(LOG_MESSAGE_MAX_BYTES)
    expect(row!.fields.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(row!.fields))).toBeLessThanOrEqual(LOG_FIELDS_MAX_BYTES)
  })
})

describe("app log readers", () => {
  it("shows a row only to a reader whose scopes cover its every tag", async () => {
    const runId = await logRun("tagged", 3, { tags: ["tickets:tickets:read"] })
    const read = (scopes: string[]) =>
      as(reader, scopes, (tx) => readAppLogs(tx, { app: "tagged", runId }))
    expect(await read(LOGS)).toHaveLength(0)
    expect(await read(["tickets:tickets:read"])).toHaveLength(0)
    expect(await read([...LOGS, "tickets:tickets:read"])).toHaveLength(3)
    expect(await read([...LOGS, "tickets"])).toHaveLength(3)
    // An untagged run: kernel:apps:logs alone.
    const plain = await logRun("tagged", 2)
    expect(
      await as(reader, LOGS, (tx) => readAppLogs(tx, { app: "tagged", runId: plain })),
    ).toHaveLength(2)
    expect(
      await as(reader, [], (tx) => readAppLogs(tx, { app: "tagged", runId: plain })),
    ).toHaveLength(0)
  })

  it("a draft preview's lines are their run's person's alone", async () => {
    const { draft } = await as(reader, ["kernel:apps:build"], (tx) =>
      createDraft(
        tx,
        { orgId, userId: reader },
        {
          baseName: "preview",
          title: "Preview",
          files: { "app.manifest.json": "{}", "handlers.ts": "" },
        },
      ),
    )
    const runId = await logRun(draftAppName(orgId, "preview"), 4, {
      draftId: draft.id,
      actor: reader,
    })
    const byDraft = (userId: string, scopes: string[]) =>
      as(userId, scopes, (tx) => readAppLogs(tx, { draftId: draft.id, runId }))
    expect(await byDraft(reader, ["kernel:apps:build"])).toHaveLength(4)
    expect(await byDraft(reader, LOGS)).toHaveLength(4)
    // An admin with every scope still does not read someone else's preview lines.
    expect(await byDraft(admin, ["*"])).toHaveLength(0)
    expect(
      await as(admin, ["*"], (tx) =>
        readAppLogs(tx, { app: draftAppName(orgId, "preview"), runId }),
      ),
    ).toHaveLength(0)
  })

  it("keeps orgs apart, and no person's transaction writes a line", async () => {
    const runId = await logRun("isolated", 2)
    expect(
      await as(otherAdmin, ["*"], (tx) => readAppLogs(tx, { app: "isolated", runId }), otherOrgId),
    ).toHaveLength(0)
    const forged = await as(admin, ["*"], (tx) =>
      tx.insert(appLogs).values({
        orgId,
        app: "isolated",
        runId,
        level: "info",
        message: "forged",
      }),
    ).catch(() => "refused")
    expect(forged).toBe("refused")
  })
})

describe("app log retention", () => {
  it("drops rows older than 7 days and keeps the newest rows per app", async () => {
    const oldRun = await logRun("retained", 3)
    await withSystemDb("test-age-app-logs", (db) =>
      db
        .update(appLogs)
        .set({ at: sql`now() - interval '8 days'` })
        .where(eq(appLogs.runId, oldRun)),
    )
    await logRun("retained", 8)
    await pruneAppLogs({ maxRowsPerApp: 5 })
    const left = await as(admin, ["*"], (tx) => readAppLogs(tx, { app: "retained", limit: 200 }))
    expect(left).toHaveLength(5)
    expect(left.some((r) => r.runId === oldRun)).toBe(false)
  })
})

describe("custom app bridge logger", () => {
  it("writes a custom app's ctx.logger lines, tagged and with their person, when the run ends", async () => {
    const appName = draftAppName(orgId, "hooked")
    const bridge = await as(admin, ["*"], async (tx) => {
      const b = createRpcBridge(appName, admin, orgId, tx, { name: appName, scopes: [] }, ["*"])
      b.log_info("hello from the app", JSON.stringify({ order: 42 }))
      b.log_warn("careful")
      return b
    })
    await flushRunLogs(bridge)
    const rows = await as(admin, ["*"], (tx) => readAppLogs(tx, { app: appName }))
    expect(rows.map((r) => r.message).sort()).toEqual(["careful", "hello from the app"])
    expect(rows.find((r) => r.message === "hello from the app")!.fields).toEqual({ order: 42 })
    expect(rows[0]!.actorUserId).toBe(admin)
  })

  it("a first-party app's lines stay out", async () => {
    const bridge = await as(admin, ["*"], async (tx) => {
      const b = createRpcBridge("tickets", admin, orgId, tx, { name: "tickets", scopes: [] }, ["*"])
      b.log_info("not stored")
      return b
    })
    await flushRunLogs(bridge)
    expect(await as(admin, ["*"], (tx) => readAppLogs(tx, { app: "tickets" }))).toHaveLength(0)
  })
})

describe("GET /api/apps/:name/logs", () => {
  it("needs kernel:apps:logs", async () => {
    await logRun("rest-app", 2)
    const adminSession = await minimal.sessionOf({ id: admin, orgId })
    const res = await app.request("/api/apps/rest-app/logs?limit=10", {
      headers: { Authorization: `Bearer ${adminSession.bearer}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ message: string }> }
    expect(body.data).toHaveLength(2)

    const member = await minimal.sessionOf({ id: reader, orgId })
    const denied = await app.request("/api/apps/rest-app/logs", {
      headers: { Authorization: `Bearer ${member.bearer}` },
    })
    expect(denied.status).toBe(403)

    const bad = await app.request("/api/apps/rest-app/logs?level=loud", {
      headers: { Authorization: `Bearer ${adminSession.bearer}` },
    })
    expect(bad.status).toBe(400)
  })
})
