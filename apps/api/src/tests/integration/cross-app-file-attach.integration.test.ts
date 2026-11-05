// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sandboxed app attaches one of its OWN files to a ticket through a declared
// cross-app call. The app stores the bytes on one of its registered fileParents
// with `files_importAttachment`, then calls `ctx.executeTool("tickets:addNote",
// {attachments: [fileId]})`. No grant mechanism is needed: the nested dispatch's
// RLS context is the target app's `tickets:*` unioned with the CALLER's actor
// scopes (execute-tool.ts `actorForRls`), so a file the caller can read is
// readable by the tickets attachment checks, and nothing the caller cannot read
// becomes readable.
//
// Driven on real Postgres + object storage through the host side of the sandbox
// bridge (`createRpcBridge`, the methods a bundle's `ctx` calls), in the shape a
// webhook delivery builds (modules/webhooks/routes.ts): a system actor holding
// the app's own namespace. The caller is the invoicing bundled app, registered
// with one extra `cross_app_calls` entry, and its `issuer_profile` fileParent.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const CALLER = "invoicing"
const CALLER_SCOPES = [`${CALLER}:*`]

/** The invoicing manifest, declaring `tickets:addNote` as a cross-app call. */
function callerDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", CALLER, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  const declared = (manifest.cross_app_calls as Array<{ target: string; reason: string }>) ?? []
  return {
    ...manifest,
    cross_app_calls: [
      ...declared,
      { target: "tickets:addNote", reason: "attach a stored file to a ticket note" },
    ],
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", CALLER, version, "bundle.js"),
  }
}

let orgId = ""
let issuerId = ""
let ticketId = ""

async function seed(): Promise<void> {
  const slug = `cross-app-attach-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("cross-app-attach-fixture", async (tx) => {
    orgId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Cross App Attach Org', ${slug}) RETURNING id`),
    )[0]!.id
    await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`${slug}@test.com`}, 'Member', 'active', 'hash', 1, 1)`)
    ticketId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
          sla_elapsed_seconds, message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`ticket-${slug}`}, 'Report', 'open', 'normal',
          'email', 'internal', ${`X${slug}`.slice(0, 40)}, 3600,
          now() + interval '1 hour', now(), 0, 0, now(), now()
        ) RETURNING id`),
    )[0]!.id
  })
}

/** The caller's own parent row, committed before the handler runs (as a row an
 *  earlier delivery created would be). */
async function seedParent(): Promise<void> {
  issuerId = extractRows<{ id: string }>(
    await withSystemDb("cross-app-attach-parent", async (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO app_invoicing.issuer_profiles
          (id, org_id, legal_name, country, vat_id, address, default_currency, default_language)
        VALUES (gen_random_uuid(), ${orgId}, 'Fictive Issuer SAS', 'FR', 'FR60902000009',
          '2 rue Test, 75001 Paris', 'EUR', 'fr')
        RETURNING id::text AS id`),
    ),
  )[0]!.id
}

/** Run `fn` with the caller app's bridge, in the shape of a webhook delivery. */
function asCallerApp<T>(fn: (bridge: Record<string, any>) => Promise<T>): Promise<T> {
  const actor: ActorContext = {
    actorType: "system",
    orgId,
    purpose: "webhook",
    scopes: CALLER_SCOPES,
  }
  return withRlsContext(actor, async (tx) => {
    const bridge = createRpcBridge(
      CALLER,
      "system",
      orgId,
      tx,
      callerDescriptor() as never,
      CALLER_SCOPES,
      "system",
      undefined,
      { actor },
    )
    return fn(bridge)
  })
}

async function importOwnFile(bridge: Record<string, any>, filename: string): Promise<string> {
  const out = JSON.parse(
    await bridge.files_importAttachment(
      JSON.stringify({
        targetApp: CALLER,
        targetEntityType: "issuer_profile",
        targetEntityId: issuerId,
        filename,
        mimeType: "text/plain",
        bytesBase64: Buffer.from(`bytes of ${filename}\n`).toString("base64"),
      }),
    ),
  ) as { id?: string; fileId?: string }
  const id = out.id ?? out.fileId
  expect(id).toBeTruthy()
  // The caller reads its own file under its own RLS context.
  const own = JSON.parse(
    await bridge.files_listAttachments(
      JSON.stringify({ app: CALLER, entityType: "issuer_profile", entityId: issuerId }),
    ),
  ) as Array<{ id: string }>
  expect(own.map((f) => f.id)).toContain(id!)
  return id!
}

async function noteAttachments(messageId: string): Promise<string[]> {
  return withSystemDb("cross-app-attach-read", async (tx) =>
    extractRows<{ filename: string }>(
      await tx.execute(drizzleSql`
        SELECT filename FROM kernel.files
        WHERE org_id = ${orgId} AND app = 'tickets' AND entity_type = 'message'
          AND entity_id = ${messageId}`),
    ).map((r) => r.filename),
  )
}

async function noteCount(): Promise<number> {
  return withSystemDb("cross-app-attach-count", async (tx) => {
    const rows = extractRows<{ n: string }>(
      await tx.execute(drizzleSql`
        SELECT COUNT(*)::text AS n FROM app_tickets.messages
        WHERE org_id = ${orgId} AND ticket_id = ${ticketId} AND kind = 'note'`),
    )
    return Number(rows[0]!.n)
  })
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  await seed()
  await ensureAppsForOrg(orgId, {})
  // Registering the app creates its tables.
  await registerApps([callerDescriptor() as never], orgId)
  await seedParent()
  // The kernel.files SELECT policy from the registered fileParents (boot builds
  // it from the installed catalog, which may not hold the caller here).
  await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
})

afterAll(async () => {
  await rebuildFilesSelectPolicy()
  await releaseTestLock()
  await withSystemDb("cross-app-attach-cleanup", async (tx) => {
    await tx.execute(drizzleSql`DELETE FROM kernel.files WHERE org_id = ${orgId}`)
    await tx.execute(drizzleSql`DELETE FROM app_tickets.messages WHERE org_id = ${orgId}`)
    await tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}`)
    await tx.execute(drizzleSql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${orgId}`)
  })
})

describe("a sandboxed app attaches its own file to a ticket through executeTool", () => {
  it("stores a file on its own parent with files_importAttachment, then tickets:addNote attaches it", async () => {
    const result = await asCallerApp(async (bridge) => {
      const fileId = await importOwnFile(bridge, "report-1.txt")
      return JSON.parse(
        await bridge.executeTool(
          "tickets:addNote",
          JSON.stringify({ ticketId, text: "Attachment 1: report-1.txt", attachments: [fileId] }),
        ),
      ) as { status?: string; result?: { messageId?: string }; data?: { messageId?: string } }
    })
    const messageId = result.result?.messageId ?? result.data?.messageId
    expect({ result, messageId: typeof messageId }).toMatchObject({ messageId: "string" })
    expect(await noteAttachments(messageId!)).toEqual(["report-1.txt"])
  })

  it("the same file is not attachable by a caller that cannot read it", async () => {
    // A support member holding tickets scopes only: the caller app's parent row
    // is invisible to them, so its file is too. The dispatch widened nothing.
    const fileId = await asCallerApp((bridge) => importOwnFile(bridge, "report-2.txt"))
    const before = await noteCount()
    await expect(
      executeTool({
        toolName: "tickets:addNote",
        orgId,
        actor: {
          actorType: "user",
          userId: "00000000-0000-0000-0000-000000000000",
          orgId,
          scopes: ["tickets:tickets:read", "tickets:tickets:write"],
          dimensionGrants: {},
        },
        params: { ticketId, text: "x", attachments: [fileId] },
      }),
    ).rejects.toMatchObject({ code: "parent_not_found" })
    expect(await noteCount()).toBe(before)
  })
})
