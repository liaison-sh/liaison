// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ticket 10309 (Morgan: "tous mes tickets sont signes Pat Rivera"): a
// routine-drafted reply signed with the routine OWNER's personal signature.
//
// Two prior passes at this fix were both unreachable in production:
//
//   1. Wiring the override through `ctx.originRoutineId` alone: that field was
//      never populated on the live reply-drafting call (handlers.ts's
//      ticketsReply -> ctx.tickets_admin("tools.draftSignature") -> the RPC
//      bridge -> runAdminOp, none of which threaded a routine id).
//   2. Reading `currentRunContext()?.routineId` directly inside
//      ticketsDraftSignature: that call arrives as a HOST-BRIDGE CALLBACK
//      invoked FROM sandbox (QuickJS) code, which runs OUTSIDE the ALS frame
//      currentRunContext() reads -- rpc-bridge.ts has a forensic incident
//      note (the BL-275 class: competitor-firmware-news-watch duplicate-doc
//      flake) recording exactly this failure for the knowledge bridge, fixed
//      there by capturing the routine id IN-FRAME at bridge-construction time
//      (`bridgeRoutineId`, rpc-bridge.ts) and threading it explicitly instead
//      of re-reading the ALS on the far side of the sandbox call.
//
// The real fix (this pass) threads `bridgeRoutineId` explicitly:
// rpc-bridge.ts's `tickets_admin` method -> `runAdminOp`'s actor.originRoutineId
// -> `ToolCtx.originRoutineId` -> ticketsDraftSignature. No ALS read left in
// ticketsDraftSignature itself.
//
// This test proves it by actually crossing the sandbox boundary: a synthetic
// QuickJS-executed tool (registered like execute-tool-sandbox.test.ts's
// harness tools) calls `ctx.tickets_admin("tools.draftSignature", ...)` and
// appends the returned signature to a body exactly the way handlers.ts's real
// ticketsReply does (handlers.ts: `textBody = textBody + "\n\n" +
// sig.signatureText`), driven through the REAL `executeTool` -> sandbox pool
// -> QuickJS -> rpc-bridge round trip, with the routine's ALS frame set up
// the way routine-worker.ts's tick actually sets it up. The assertion is the
// literal body text a customer would read, not a resolver return value.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"

const rows = (r: unknown): any[] => (r as any).rows ?? r

const ORG_NAME = "Routine Signature Org"

let orgId: string
let ownerUserId: string
let accountId: string
let inboxId: string
let routineId: string
let ticketWithInboxId: string
let ticketNoInboxId: string

beforeAll(async () => {
  const slug = `routine-sig-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("routine-sig-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), ${ORG_NAME}, ${slug}) RETURNING id`),
    )[0].id
    ownerUserId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version, settings)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'Pat Rivera', 'active', 'h', 1, 1,
          '{"tickets": {"signature": {"text": "Pat Rivera"}}}'::jsonb)
        RETURNING id`),
    )[0].id
    accountId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', 'support@fabrikam.test', 'active', ${ownerUserId}, 'enc')
        RETURNING id`),
    )[0].id
    inboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'Support', 'support@fabrikam.test', 'Fabrikam Support', true, now(), now())
        RETURNING id`),
    )[0].id
    routineId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.routines (id, org_id, owner_user_id, name, description, prompt, scopes, created_by_actor_type, kind, event)
        VALUES (gen_random_uuid(), ${orgId}, ${ownerUserId}, 'Support triage routine', 'auto-drafts replies', 'draft a reply', '{}', 'user', 'event', 'tickets:message:create')
        RETURNING id`),
    )[0].id
    ticketWithInboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, source_inbox_id, source_account_id,
          sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`ticket_${slug}_a`}, 'Need help', 'open', 'normal', 'email', 'internal',
          ${`tok_${slug}_a`}, ${inboxId}, ${accountId},
          3600, now() + interval '1 hour', now(), 0,
          0, now(), now()
        )
        RETURNING id
      `),
    )[0].id
    ticketNoInboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, source_inbox_id, source_account_id,
          sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`ticket_${slug}_b`}, 'Internal task', 'open', 'normal', 'email', 'internal',
          ${`tok_${slug}_b`}, null, null,
          3600, now() + interval '1 hour', now(), 0,
          0, now(), now()
        )
        RETURNING id
      `),
    )[0].id
  })
  await initSandboxPool()
})

afterAll(async () => {
  await shutdownSandboxPool()
})

afterEach(() => resetAppRegistries())

/**
 * Registers a synthetic QuickJS-executed tool under appName "tickets" (same
 * harness pattern as execute-tool-sandbox.test.ts) whose body mirrors the
 * REAL production line in handlers.ts's ticketsReply: draft the signature via
 * ctx.tickets_admin, then append it to the body exactly as handlers.ts does.
 * This is what actually crosses the sandbox boundary in production, so the
 * test must cross it too instead of calling runAdminOp directly.
 */
async function registerDraftAndAppendTool(): Promise<void> {
  const bundleSource = `
    async function draftAndAppend(params, ctx) {
      var sigRaw = await ctx.tickets_admin("tools.draftSignature", JSON.stringify({ ticketId: params.ticketId }))
      var sig = JSON.parse(sigRaw)
      var textBody = params.textBody
      if (sig.signatureText) {
        textBody = textBody + "\\n\\n" + sig.signatureText
      }
      return { textBody: textBody, signatureText: sig.signatureText }
    }
  `
  const bundlePath = "/tmp/test-routine-sig-draft-and-append.js"
  await Bun.write(bundlePath, bundleSource)
  toolRegistry.set([orgId, "tickets", "draftAndAppend"], {
    appName: "tickets",
    name: "draftAndAppend",
    description: "test-only: mirrors handlers.ts ticketsReply's signature append",
    requiredScopes: ["tickets:tickets:write"],
    // The fixture WRITES NOTHING: it asks tickets_admin for the signature and
    // returns the composed body, which is the half this test is about. Without
    // the marker the scope-taint guard refuses it as an undeclared write (the
    // tick has read ticket data first), and the seam under test never runs.
    readOnly: true,
    handler: { bundlePath, exportName: "draftAndAppend", trusted: true },
    _manifest: { name: "tickets", schema: {}, events: {}, connections: {}, network: {} },
  } as any)
}

/** Drives the exact production hop: `executeTool` -> the sandbox pool -> the
 *  REAL QuickJS worker -> the rpc-bridge -> `runAdminOp`, with the routine
 *  tick's ALS frame set up around the call the way routine-worker.ts's tick
 *  actually sets it up (runContextStore.run wraps the whole tick, INCLUDING
 *  the host-side sandbox dispatch that captures `bridgeRoutineId`). */
function draftAndAppendAsRoutineTick(
  ticketId: string,
  textBody: string,
  tickRoutineId: string,
): Promise<{ data?: { textBody: string; signatureText: string | null } }> {
  const runId = crypto.randomUUID()
  return runContextStore.run(
    {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      background: true,
      routineId: tickRoutineId,
    },
    () =>
      executeTool({
        toolName: "tickets:draftAndAppend",
        orgId,
        actor: {
          actorType: "agent",
          userId: ownerUserId,
          orgId,
          scopes: ["tickets:tickets:write"],
          dimensionGrants: {},
        } as never,
        params: { ticketId, textBody },
      }) as never,
  )
}

describe("routine-drafted reply signature (real seam: crossing the sandbox boundary)", () => {
  it("appends the routine's own name to the body, never the owner's personal signature", async () => {
    await registerDraftAndAppendTool()
    // The owner's personal signature is "Pat Rivera" (set in the
    // fixture) and the inbox carries none. FALSIFIABLE: without threading
    // bridgeRoutineId through tickets_admin -> runAdminOp -> ToolCtx, this
    // call never sees a routine at all on the far side of the sandbox
    // boundary and falls through to the owner's personal signature -- this
    // assertion catches exactly that.
    const result = await draftAndAppendAsRoutineTick(
      ticketWithInboxId,
      "Thanks for reaching out.",
      routineId,
    )
    expect(result.data?.textBody).toBe("Thanks for reaching out.\n\nSupport triage routine")
    expect(result.data?.textBody).not.toContain("Pat Rivera")
  })

  it("never ships unsigned when the routine name cannot be resolved: falls back to the inbox display name", async () => {
    await registerDraftAndAppendTool()
    const bogusRoutineId = crypto.randomUUID() // valid uuid, no kernel.routines row
    const result = await draftAndAppendAsRoutineTick(
      ticketWithInboxId,
      "Thanks for reaching out.",
      bogusRoutineId,
    )
    // Regression check: a null/empty signature here would ship a completely
    // unsigned customer email (worse than a wrong name).
    expect(result.data?.textBody).toBe("Thanks for reaching out.\n\nFabrikam Support")
    expect(result.data?.textBody).not.toContain("Pat Rivera")
  })

  it("falls back to the org name when neither the routine name nor an inbox display name resolves", async () => {
    await registerDraftAndAppendTool()
    const bogusRoutineId = crypto.randomUUID()
    const result = await draftAndAppendAsRoutineTick(
      ticketNoInboxId,
      "Thanks for reaching out.",
      bogusRoutineId,
    )
    expect(result.data?.textBody).toBe(`Thanks for reaching out.\n\n${ORG_NAME}`)
    expect(result.data?.textBody).not.toContain("Pat Rivera")
  })

  it("sanity: the fixture's routine row really does carry the expected name", async () => {
    const r = await withPrivilegedDb(orgId, "routine-sig-sanity", (tx) =>
      tx.execute(drizzleSql`SELECT name FROM kernel.routines WHERE id = ${routineId}`),
    )
    expect(extractRows<{ name: string }>(r)[0]?.name).toBe("Support triage routine")
  })
})
