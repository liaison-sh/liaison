// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `tickets:create` takes an optional `idempotencyKey`, as `tickets:addNote` does: a replay with
// the same key returns the original ticket instead of opening a duplicate. The kernel's
// idempotency store (modules/apps/idempotency.ts, reserved in executeToolCore) does the work;
// the tool only has to declare the param so the validator lets it through. The case that needs
// it: a sandboxed app's webhook handler opens a ticket per delivery, and the sender retries a
// delivery it did not see acknowledged.
//
// Driven on real Postgres + Redis, directly and through the host side of the sandbox bridge
// (`createRpcBridge`, the methods a bundle's `ctx` calls) in the shape a webhook delivery builds.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ticketsSettingsDefaults } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const CALLER = "invoicing"
const CALLER_SCOPES = [`${CALLER}:*`]

interface TicketCreateData {
  ticketId: string
  ticketHandle: string
}

let orgId = ""
let actor: ActorContext

/** A sandboxed caller app declaring `tickets:create` as a cross-app call. */
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
      { target: "tickets:create", reason: "open a ticket from a webhook delivery" },
    ],
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", CALLER, version, "bundle.js"),
  }
}

/** Run `fn` with the caller app's bridge, in the shape of a webhook delivery. */
function asCallerApp<T>(fn: (bridge: Record<string, any>) => Promise<T>): Promise<T> {
  const webhookActor: ActorContext = {
    actorType: "system",
    orgId,
    purpose: "webhook",
    scopes: CALLER_SCOPES,
  }
  return withRlsContext(webhookActor, async (tx) => {
    const bridge = createRpcBridge(
      CALLER,
      "system",
      orgId,
      tx,
      callerDescriptor() as never,
      CALLER_SCOPES,
      "system",
      undefined,
      { actor: webhookActor },
    )
    return fn(bridge)
  })
}

async function ticketIdsWithSubject(subject: string): Promise<string[]> {
  return withSystemDb("tickets-create-idem-count", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM app_tickets.tickets
        WHERE org_id = ${orgId} AND subject = ${subject}`),
    ).map((r) => r.id),
  )
}

function uniqueSubject(label: string): string {
  return `${label} ${crypto.randomUUID()}`
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  const slug = `tickets-create-idem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const userId = await withSystemDb("tickets-create-idem-fixture", async (tx) => {
    orgId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Tickets Create Idempotency Org', ${slug}) RETURNING id`),
    )[0]!.id
    return extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`${slug}@test.com`}, 'Member', 'active', 'hash', 1, 1)
        RETURNING id`),
    )[0]!.id
  })
  await ensureAppsForOrg(orgId, {})
  await withSystemDb("tickets-create-idem-settings", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)
      WHERE id = ${orgId}`)
  })
  await registerApps([callerDescriptor() as never], orgId)
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
})

afterAll(async () => {
  await releaseTestLock()
  await withSystemDb("tickets-create-idem-cleanup", async (tx) => {
    await tx.execute(drizzleSql`DELETE FROM app_tickets.messages WHERE org_id = ${orgId}`)
    await tx.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}`)
  })
})

describe("tickets:create idempotencyKey", () => {
  it("a replay with the same key returns the original ticket and opens no second one", async () => {
    const subject = uniqueSubject("Replayed delivery")
    const params = { subject, channel: "manual", idempotencyKey: `idem-${crypto.randomUUID()}` }
    const r1 = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params,
    })
    const r2 = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params,
    })
    expect(r1.data.ticketId).toBeString()
    expect(r2.data.ticketId).toBe(r1.data.ticketId)
    expect(await ticketIdsWithSubject(subject)).toEqual([r1.data.ticketId])
  })

  it("two simultaneous calls with the same key open one ticket", async () => {
    const subject = uniqueSubject("Concurrent delivery")
    const params = { subject, channel: "manual", idempotencyKey: `idem-${crypto.randomUUID()}` }
    const results = await Promise.allSettled([
      executeTool<TicketCreateData>({ toolName: "tickets:create", orgId, actor, params }),
      executeTool<TicketCreateData>({ toolName: "tickets:create", orgId, actor, params }),
    ])
    const ids = await ticketIdsWithSubject(subject)
    expect(ids).toHaveLength(1)
    // The loser either replays the winner's result or is told to retry (in flight, a thrown
    // tool error); never a second ticket, never a different id.
    for (const r of results) {
      if (r.status === "rejected") {
        expect((r.reason as { code?: string }).code).toBe("idempotency_in_flight")
      } else {
        expect(r.value.data.ticketId).toBe(ids[0])
      }
    }
  })

  it("different keys open two tickets", async () => {
    const subject = uniqueSubject("Two deliveries")
    const r1 = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject, channel: "manual", idempotencyKey: `idem-${crypto.randomUUID()}` },
    })
    const r2 = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params: { subject, channel: "manual", idempotencyKey: `idem-${crypto.randomUUID()}` },
    })
    expect(r2.data.ticketId).not.toBe(r1.data.ticketId)
    expect((await ticketIdsWithSubject(subject)).sort()).toEqual(
      [r1.data.ticketId, r2.data.ticketId].sort(),
    )
  })

  it("without a key, each call opens a ticket as before", async () => {
    const subject = uniqueSubject("No key")
    const params = { subject, channel: "manual" }
    const r1 = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params,
    })
    const r2 = await executeTool<TicketCreateData>({
      toolName: "tickets:create",
      orgId,
      actor,
      params,
    })
    expect(r1.data.ticketHandle).toMatch(/^ticket-\d+$/)
    expect(r2.data.ticketId).not.toBe(r1.data.ticketId)
    expect(await ticketIdsWithSubject(subject)).toHaveLength(2)
  })

  it("through the sandbox bridge, a webhook handler's replay with the same key opens one ticket", async () => {
    const subject = uniqueSubject("Webhook delivery")
    const paramsJson = JSON.stringify({
      subject,
      channel: "api",
      idempotencyKey: `webhook:${crypto.randomUUID()}`,
    })
    type BridgeEnvelope = {
      status?: string
      code?: string
      result?: { ticketId?: string }
    }
    const first = JSON.parse(
      await asCallerApp((bridge) => bridge.executeTool("tickets:create", paramsJson)),
    ) as BridgeEnvelope
    const replay = JSON.parse(
      await asCallerApp((bridge) => bridge.executeTool("tickets:create", paramsJson)),
    ) as BridgeEnvelope
    expect(first).toMatchObject({ status: "completed", result: { ticketId: expect.any(String) } })
    expect(replay).toMatchObject({
      status: "completed",
      result: { ticketId: first.result?.ticketId },
    })
    expect(await ticketIdsWithSubject(subject)).toEqual([first.result!.ticketId!])
  })
})
