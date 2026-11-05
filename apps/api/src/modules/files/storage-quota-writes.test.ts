// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org storage quota on the two write paths that also carry content the org
// must not lose: sandbox attachment imports (`files_importAttachment`) and
// rendered PDFs (`renderPdf`). At the quota, a write a person or an agent starts
// is refused and stores nothing; system work (mail sync, a webhook, a job with
// no agent acting) and a legal record's file are stored anyway, and counted.
// The admins hear about it through the org cap notice: once when storage passes
// 80 %, not again while it stays above, and again after it fell back below.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type RlsClient, sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel/files"
import { schemaRef } from "~/db/schema-ref"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import * as objectStorageModule from "~/infra/storage/object-storage"
import { redis } from "~/lib/redis"
import { declaredEmits, manifestFileParentRegistry } from "~/modules/apps/app-registries"
import { manifestFileParentOf } from "~/modules/apps/catalog-derivations"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { capLevelsSettled } from "~/modules/org/caps"
import { PdfRegistryTestAccess, registerTemplate } from "~/modules/pdf/registry"
import { renderPdf } from "~/modules/pdf/render"
import { TEST_FIXTURE_SOURCE } from "~/modules/pdf/templates/test-fixture"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const GB = 1024 ** 3
const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

let orgId: string
let userId: string
let messageId: string
let padId: string | null = null

/** Sets the org's stored bytes to `bytes` (plus whatever the tests stored) under a 1 GB cap. */
async function padTo(bytes: number): Promise<void> {
  await withPrivilegedDb(orgId, "quota-test-pad", async (tx) => {
    if (padId) await tx.execute(drizzleSql`DELETE FROM kernel.files WHERE id = ${padId}`)
    const [pad] = await tx
      .insert(files)
      .values({
        orgId,
        app: "kernel",
        entityType: "cap_pad",
        entityId: randomUUID(),
        filename: "pad.bin",
        mimeType: "application/octet-stream",
        sizeBytes: bytes,
        storageKey: `orgs/${orgId}/cap-pad/${randomUUID()}`,
      })
      .returning({ id: files.id })
    padId = pad?.id ?? null
  })
}

async function fileCount(): Promise<number> {
  const rows = await withSystemDb("quota-test-count", async (db) =>
    extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.files WHERE org_id = ${orgId}::uuid AND entity_type <> 'cap_pad'`,
      ),
    ),
  )
  return rows[0]?.n ?? 0
}

async function storageNotices(): Promise<Array<{ threshold: number; summary: string }>> {
  await capLevelsSettled()
  const rows = await sql`
    SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId} AND payload->>'entity' = 'org_cap'
      AND payload->'data'->>'cap' = 'storageGb'
    ORDER BY seq`
  return rows.map((r) => (r.payload as { data: { threshold: number; summary: string } }).data)
}

function stubObjectStore(): () => void {
  const spy = spyOn(objectStorageModule, "putObject").mockImplementation((async () => {}) as never)
  return () => spy.mockRestore()
}

/** One `files_importAttachment` call onto the test mail message, as `bridgeUser`. */
async function importAttachment(
  bridgeUser: string,
  opts: { agentId?: string } = {},
): Promise<{ id?: string; error?: unknown }> {
  const restore = stubObjectStore()
  try {
    return await withPrivilegedDb(orgId, "quota-test-import", async (tx) => {
      const bridge = createRpcBridge(
        "mail",
        bridgeUser,
        orgId,
        tx as unknown as RlsClient,
        mailAppManifest as never,
        undefined,
        undefined,
        undefined,
        opts.agentId ? { spawnParentFrameOverride: { agentId: opts.agentId } } : undefined,
      ) as unknown as Record<string, (json: string) => Promise<string>>
      const res = await bridge.files_importAttachment(
        JSON.stringify({
          targetApp: "mail",
          targetEntityType: "message",
          targetEntityId: messageId,
          filename: "scan.pdf",
          mimeType: "application/pdf",
          bytesBase64: Buffer.alloc(2048, 0x41).toString("base64"),
          disposition: "attachment",
          ordinal: 0,
        }),
      )
      return { id: (JSON.parse(res) as { id: string }).id }
    })
  } catch (error) {
    return { error }
  } finally {
    restore()
  }
}

type Actor = { actorType: "user" | "agent" | "system" | "mcp"; actingAgentId: string | null }

async function render(
  actor: Actor,
  parent?: { entityType: string; entityId: string },
): Promise<{ id?: string; error?: unknown }> {
  const restore = stubObjectStore()
  try {
    const r = await renderPdf(null, {
      orgId,
      callingAppId: "invoicing",
      template_kind: "invoicing:quota_v1",
      data: { title: "Q" },
      pdf_a3: false,
      ...(parent ? { parent } : {}),
      actor,
    } as Parameters<typeof renderPdf>[1])
    return { id: r.file_id }
  } catch (error) {
    return { error }
  } finally {
    restore()
  }
}

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  const owner = await minimal.person((await createTestOrg()).id)
  orgId = owner.orgId
  userId = owner.id
  await withSystemDb("quota-test-cap", (db) =>
    db.execute(
      drizzleSql`UPDATE kernel.organizations SET caps = ${JSON.stringify({ storageGb: 1 })}::jsonb WHERE id = ${orgId}::uuid`,
    ),
  )
  // A shared org mailbox (no sealing) with one inbound message to hang files on.
  const accountId = randomUUID()
  const conversationId = randomUUID()
  messageId = randomUUID()
  await withSystemDb("quota-test-mail", async (db) => {
    await db.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${accountId}::uuid, ${orgId}::uuid, ${randomUUID()}::uuid, 'org', NULL, 'gmail',
              ${`${accountId}@quota.test`}, 'active', 'none')`)
    await db.execute(drizzleSql`
      INSERT INTO ${MAIL}.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
         is_read, is_starred, message_count)
      VALUES (${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid, 'org', NULL,
              ${`thread-${conversationId}`}, 'open', '[]'::jsonb, false, false, 1)`)
    await db.execute(drizzleSql`
      INSERT INTO ${MAIL}.messages
        (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
         message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
         is_read, is_starred, labels, direction, raw_headers)
      VALUES (${messageId}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
              'org', NULL, ${`ext-${messageId}`}, '[]'::jsonb,
              ${JSON.stringify({ email: "customer@quota.test" })}::jsonb, '[]'::jsonb, '[]'::jsonb,
              '[]'::jsonb, false, false, '[]'::jsonb, 'inbound',
              ${JSON.stringify({ "message-id": `<${messageId}@quota.test>` })}::jsonb)`)
  })
  PdfRegistryTestAccess.clear()
  registerTemplate("invoicing", "invoicing:quota_v1", TEST_FIXTURE_SOURCE)
  // The invoicing app's `legal_original` file parent, as the runtime registers it
  // from the installed manifest (retention included: its table is immutable).
  const { default: invoicingManifest } = await import(
    "../../../../../bundled-apps/invoicing/app.manifest.json"
  )
  const entities = (invoicingManifest as { entities: Record<string, unknown> }).entities
  const legal = manifestFileParentOf(invoicingManifest as never, entities.legal_original)
  if (!legal?.retention) throw new Error("invoicing legal_original carries no retention")
  manifestFileParentRegistry.set([orgId, "invoicing", "legal_original"], legal)
  await redis.del(`orgcap:level:${orgId}:storageGb`)
}, 120_000)

afterAll(async () => {
  if (orgId) {
    await withSystemDb("quota-test-cleanup", async (db) => {
      await db.execute(drizzleSql`DELETE FROM kernel.files WHERE org_id = ${orgId}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await db.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
    })
    await redis.del(`orgcap:level:${orgId}:storageGb`)
  }
  await shutdownSandboxPool()
  await releaseTestLock()
})

function quotaCode(err: unknown): string | undefined {
  const e = err as { code?: string; message?: string } | undefined
  return (
    e?.code ??
    (e?.message?.startsWith("storage_quota_exceeded") ? "STORAGE_QUOTA_EXCEEDED" : undefined)
  )
}

describe("at the org's storage quota (1 GB cap, 1 GB stored)", () => {
  beforeAll(async () => {
    await padTo(GB)
  })

  test("files_importAttachment: a person's import is refused and stores no file", async () => {
    const before = await fileCount()
    const r = await importAttachment(userId)
    expect(r.id).toBeUndefined()
    expect(quotaCode(r.error)).toBe("STORAGE_QUOTA_EXCEEDED")
    expect(await fileCount()).toBe(before)
  })

  test("files_importAttachment: a system bridge with an agent acting is refused too", async () => {
    const before = await fileCount()
    const r = await importAttachment("system", { agentId: randomUUID() })
    expect(quotaCode(r.error)).toBe("STORAGE_QUOTA_EXCEEDED")
    expect(await fileCount()).toBe(before)
  })

  test("files_importAttachment: mail sync (system, no agent) is stored and counted", async () => {
    const before = await fileCount()
    const r = await importAttachment("system")
    expect(r.error).toBeUndefined()
    expect(typeof r.id).toBe("string")
    expect(await fileCount()).toBe(before + 1)
  })

  test("renderPdf: an agent's render is refused and stores no file", async () => {
    const before = await fileCount()
    const r = await render({ actorType: "agent", actingAgentId: randomUUID() })
    expect(r.id).toBeUndefined()
    expect(quotaCode(r.error)).toBe("STORAGE_QUOTA_EXCEEDED")
    expect(await fileCount()).toBe(before)
  })

  test("renderPdf: a render with no host actor is refused like a person's", async () => {
    const restore = stubObjectStore()
    try {
      const err = await renderPdf(null, {
        orgId,
        callingAppId: "invoicing",
        template_kind: "invoicing:quota_v1",
        data: {},
        pdf_a3: false,
      }).catch((e) => e)
      expect(quotaCode(err)).toBe("STORAGE_QUOTA_EXCEEDED")
    } finally {
      restore()
    }
  })

  test("renderPdf: an invoicing legal original is stored even when an agent issues it", async () => {
    const before = await fileCount()
    const r = await render(
      { actorType: "agent", actingAgentId: randomUUID() },
      { entityType: "legal_original", entityId: randomUUID() },
    )
    expect(r.error).toBeUndefined()
    expect(await fileCount()).toBe(before + 1)
  })

  test("renderPdf: system work (no person, no agent) is stored", async () => {
    const r = await render({ actorType: "system", actingAgentId: null })
    expect(r.error).toBeUndefined()
  })
})

describe("the 80 % storage notice to the admins", () => {
  const system: Actor = { actorType: "system", actingAgentId: null }

  test("fires once on crossing, not again while above, and again after a drop below", async () => {
    await redis.del(`orgcap:level:${orgId}:storageGb`)
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId} AND payload->>'entity' = 'org_cap'`
    await padTo(Math.floor(0.5 * GB))
    expect((await render(system)).error).toBeUndefined()
    expect(await storageNotices()).toEqual([])

    // A write lands the org at 85 %: one notice, from that write.
    await padTo(Math.floor(0.85 * GB))
    expect((await render(system)).error).toBeUndefined()
    const first = await storageNotices()
    expect(first.map((n) => n.threshold)).toEqual([80])
    expect(first[0]?.summary).toContain("Upgrade your plan or free space")
    expect(first[0]?.summary).toContain("new files will be refused")

    // Still above 80 %: further writes say nothing more.
    expect((await render(system)).error).toBeUndefined()
    expect((await importAttachment("system")).error).toBeUndefined()
    expect((await storageNotices()).map((n) => n.threshold)).toEqual([80])

    // Back under 80 % re-arms; the next crossing notifies again.
    await padTo(Math.floor(0.4 * GB))
    expect((await render(system)).error).toBeUndefined()
    await padTo(Math.floor(0.85 * GB))
    expect((await render(system)).error).toBeUndefined()
    expect((await storageNotices()).map((n) => n.threshold)).toEqual([80, 80])
  })
})
