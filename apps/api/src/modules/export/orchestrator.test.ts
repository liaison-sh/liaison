// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { unzipSync } from "fflate"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { exportRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { exportApps, exportAppsWithManifest } from "~/modules/export/orchestrator"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await releaseTestLock()
})

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  userId = await withSystemDb("orchestrator-user", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    return rows[0].id
  })
})

function adminActor(): UserContext {
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: {
      "tickets:team": ["*"],
      "tickets:sensitivity": ["restricted"],
    },
  }
}

async function seedTicket(): Promise<void> {
  const id = crypto.randomUUID()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await withSystemDb("orchestrator-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, team, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
        message_count, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${`ticket-${suffix}`}, ${`Subj ${suffix}`}, 'open', 'normal', 'manual',
        'support-eu', 'internal', ${`TK${suffix.replace(/[^A-Za-z0-9]/g, "").slice(0, 14)}`},
        3600, now() + interval '1 hour', now(), 0, 0, now(), now()
      )
    `)
  })
}

async function seedTicketTeam(team: string): Promise<void> {
  const id = crypto.randomUUID()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await withSystemDb("orchestrator-seed-team", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, team, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
        message_count, created_at, updated_at
      ) VALUES (
        ${id}, ${orgId}, ${`ticket-${suffix}`}, ${`Subj ${suffix}`}, 'open', 'normal', 'manual',
        ${team}, 'internal', ${`TK${suffix.replace(/[^A-Za-z0-9]/g, "").slice(0, 14)}`},
        3600, now() + interval '1 hour', now(), 0, 0, now(), now()
      )
    `)
  })
}

function readManifest(buf: Uint8Array) {
  const files = unzipSync(buf)
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]))
  return { files, manifest }
}

describe("export orchestrator (E2/E5)", () => {
  test("zip contains one file per selected app + manifest.json", async () => {
    await seedTicket()
    const buf = await exportApps({
      orgId,
      actor: adminActor(),
      appNames: ["tickets", "contacts"],
      format: "json",
    })
    const { files, manifest } = readManifest(buf)
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["tickets.json", "contacts.json", "manifest.json"]),
    )
    expect(manifest.apps).toEqual(expect.arrayContaining(["tickets", "contacts"]))
    expect(manifest.schemaVersions.tickets).toBeTruthy()
    expect(manifest.files.tickets).toBe("tickets.json")
  })

  test("an app whose handler lacks the requested format is recorded as skipped, others still export", async () => {
    // Register a stub app that only declares json, then request csv.
    exportRegistry.set([orgId, "json-only-stub"], {
      formats: ["json"],
      handler: async () => [{ id: "x" }],
    })
    const buf = await exportApps({
      orgId,
      actor: adminActor(),
      appNames: ["tickets", "json-only-stub"],
      format: "csv",
    })
    const { files, manifest } = readManifest(buf)
    expect(manifest.skipped).toContainEqual(
      expect.objectContaining({ app: "json-only-stub", reason: expect.any(String) }),
    )
    expect(files["tickets.csv"]).toBeTruthy()
  })

  test("a handler that throws is captured per-app; the rest still export", async () => {
    exportRegistry.set([orgId, "throwing-stub"], {
      formats: ["json"],
      handler: async () => {
        throw new Error("boom")
      },
    })
    const buf = await exportApps({
      orgId,
      actor: adminActor(),
      appNames: ["tickets", "throwing-stub"],
      format: "json",
    })
    const { manifest } = readManifest(buf)
    expect(manifest.skipped).toContainEqual(expect.objectContaining({ app: "throwing-stub" }))
    expect(manifest.apps).toContain("tickets")
  })

  test("zero apps selected rejects before any work", async () => {
    await expect(
      exportApps({ orgId, actor: adminActor(), appNames: [], format: "json" }),
    ).rejects.toThrow()
  })

  test("exportAppsWithManifest returns the zip plus the parsed manifest (UI skip surfacing)", async () => {
    exportRegistry.set([orgId, "json-only-2"], {
      formats: ["json"],
      handler: async () => [{ id: "y" }],
    })
    const { zip, manifest } = await exportAppsWithManifest({
      orgId,
      actor: adminActor(),
      appNames: ["tickets", "json-only-2"],
      format: "csv",
    })
    expect(zip).toBeInstanceOf(Uint8Array)
    expect(manifest.skipped).toContainEqual(
      expect.objectContaining({ app: "json-only-2", reason: expect.any(String) }),
    )
    const { files } = readManifest(zip)
    expect(files["manifest.json"]).toBeTruthy()
  })

  test("empty result set still yields a valid file + manifest", async () => {
    const buf = await exportApps({
      orgId,
      actor: adminActor(),
      appNames: ["tickets"],
      format: "json",
    })
    const { files, manifest } = readManifest(buf)
    expect(files["tickets.json"]).toBeTruthy()
    expect(manifest.apps).toEqual(["tickets"])
    expect(manifest.skipped).toEqual([])
  })

  test("orchestrator applies the requesting actor's RLS — never over-exports (E3)", async () => {
    await seedTicketTeam("support-eu")
    await seedTicketTeam("support-eu")
    await seedTicketTeam("support-us")

    const euOnly: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["tickets:tickets:read"],
      dimensionGrants: {
        "tickets:team": ["support-eu"],
        "tickets:sensitivity": ["restricted"],
      },
    }

    const adminZip = await exportApps({
      orgId,
      actor: adminActor(),
      appNames: ["tickets"],
      format: "json",
    })
    const limitedZip = await exportApps({
      orgId,
      actor: euOnly,
      appNames: ["tickets"],
      format: "json",
    })

    const adminRows = JSON.parse(
      new TextDecoder().decode(readManifest(adminZip).files["tickets.json"]),
    ) as unknown[]
    const limitedRows = JSON.parse(
      new TextDecoder().decode(readManifest(limitedZip).files["tickets.json"]),
    ) as unknown[]

    // Admin sees all 3; the EU-only actor sees exactly the 2 EU tickets.
    // A privileged-handle regression in the orchestrator would make these equal.
    expect(adminRows.length).toBe(3)
    expect(limitedRows.length).toBe(2)
  })

  test("kernel.export agent tool returns a retrievable download reference (E5)", async () => {
    await registerKernelAgentTools(orgId)
    const entry = toolRegistry.get([orgId, "kernel", "export"])
    expect(entry).toBeDefined()
    expect(entry!.requiredScopes).toEqual(["kernel:users:admin"])
    const handler = entry!.handler as (p: unknown, c: unknown) => Promise<unknown>
    await seedTicket()
    const ref = await handler({ appName: "tickets", format: "json" }, { orgId, userId })
    const downloadRef = (ref as { downloadRef?: unknown }).downloadRef
    expect(typeof downloadRef).toBe("string")
    expect((downloadRef as string).includes("/api/export")).toBe(true)

    // RETRIEVABILITY: the ref must point at real data, not a dead path. The
    // GET /api/export route resolves `apps`/`format` query params through this
    // same orchestrator — replay them and assert a valid, populated zip.
    const q = new URL(`http://x${downloadRef as string}`).searchParams
    const apps = (q.get("apps") ?? "").split(",").filter(Boolean)
    const fmt = q.get("format") === "csv" ? "csv" : "json"
    expect(apps).toContain("tickets")
    const zip = await exportApps({ orgId, actor: adminActor(), appNames: apps, format: fmt })
    const { files, manifest } = readManifest(zip)
    expect(files["tickets.json"]).toBeTruthy()
    expect(manifest.apps).toContain("tickets")
    expect((JSON.parse(new TextDecoder().decode(files["tickets.json"])) as unknown[]).length).toBe(
      1,
    )
    toolRegistry.deleteByPrefix([orgId])
  })
})
