// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Outbound text never reaches an approval card with an unfilled placeholder.
//
// Seen live: a routine drafted a customer reply ending "...and send it to you by [DATE].", the
// owner approved it, and the customer received the literal "[DATE]". Every tool that sends text
// to a person outside the org declares those params (`outboundTextParams`), and executeToolCore
// refuses a placeholder there BEFORE any gate stages an approval; a handler-parked approval and
// an agent's edit of a pending payload are held to the same rule. A clean draft stages as before.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import * as eventBusModule from "~/infra/events/event-bus"
import { updatePayload } from "~/modules/approvals/edit"
import { approvalEditableFieldsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { createHandlerApprovalRequest, executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const REPO = join(import.meta.dir, "../../../../..")
const manifestTools = (path: string): Record<string, { outboundTextParams?: string[] }> =>
  JSON.parse(readFileSync(join(REPO, path), "utf8")).tools

let orgId: string
let userId: string
let admin: UserContext
let threadId: string
let ticketId: string

const PLACEHOLDER = /Your draft contains a placeholder \(\[DATE\]\)/

async function approvalCount(): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
  return row!.n
}

const call = (toolName: string, params: Record<string, unknown>, origin = "in-app-agent") =>
  executeTool({
    toolName,
    orgId,
    actor: admin,
    params,
    threadId,
    origin: origin as "in-app-agent" | "human-ui",
    stepBundleId: null,
  })

/** The call's outcome as text: the refusal message, or "ok" when it staged or ran. */
async function outcome(toolName: string, params: Record<string, unknown>, origin?: string) {
  try {
    await call(toolName, params, origin)
    return "ok"
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  admin = a.actor
  threadId = await minimal.thread(orgId, userId)
  await sql`UPDATE kernel.users SET timezone = 'Europe/Paris' WHERE id = ${userId}`
  await ensureAppsForOrg(orgId)

  // A real ticket with a mailbox inbox, so a clean tickets:reply stages a real approval.
  ticketId = await withPrivilegedDb(orgId, "outbound-placeholder-fixture", async (tx) => {
    const rows = <T>(r: unknown) => extractRows<T>(r)
    const slug = `ph-${Date.now()}`
    const [account] = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', ${`support-${slug}@fabrikam.test`}, 'active', ${userId}, 'enc')
        RETURNING id`),
    )
    const [inbox] = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${account!.id}, 'Support', ${`support-${slug}@fabrikam.test`}, 'Fabrikam Support', true, now(), now())
        RETURNING id`),
    )
    const [ticket] = rows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, source_inbox_id, source_account_id,
          sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`ticket_${slug}`}, 'When does my order ship?', 'open', 'normal', 'email', 'internal',
          ${slug}, ${inbox!.id}, ${account!.id},
          3600, now() + interval '1 hour', now(), 0,
          0, now(), now()
        )
        RETURNING id`),
    )
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (
        id, org_id, ticket_id, kind, from_email, from_name, text_body, sent_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${ticket!.id}, 'inbound', 'customer@example.com', 'Cust',
        'When will you send it?', now(), now(), now()
      )`)
    return ticket!.id
  })

  // Probe tools carrying the bundled apps' own declarations (social, invoicing), so their
  // outbound tools are judged through the same registry path a sandboxed app registers by.
  const probes: Record<string, string[]> = {
    probe_social_send_dm: manifestTools("bundled-apps/social/app.manifest.json").send_dm!
      .outboundTextParams!,
    probe_invoicing_send: manifestTools("bundled-apps/invoicing/app.manifest.json")
      .documents_send_to_customer!.outboundTextParams!,
  }
  for (const [name, outboundTextParams] of Object.entries(probes)) {
    toolRegistry.set([orgId, "kernel", name], {
      appName: "kernel",
      name,
      description: "Probe tool for outbound placeholders.",
      requiredScopes: ["kernel:threads:read"],
      gated: true,
      approvalImpact: "external",
      outboundTextParams,
      params: z.object({
        subject: z.string().optional(),
        body: z.string().optional(),
      }),
      handler: async () => ({ sent: true }),
    })
    registerApprovalSummarizer(orgId, "kernel", name, async () => ({
      kind: "probe",
      title: "Probe",
      lines: ["probe"],
    }))
  }
  approvalEditableFieldsRegistry.set(
    [orgId, "kernel", "probe_social_send_dm"],
    [{ field: "body", label: "Body", widget: "text" }],
  )
})

afterAll(async () => {
  broadcastSpy.mockRestore()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("outbound tools declare their outbound text", () => {
  it("mail and tickets register the declaration", () => {
    const expected: Array<[string, string, string[]]> = [
      ["mail", "reply", ["textBody", "htmlBody"]],
      ["mail", "forward", ["note"]],
      ["mail", "compose", ["subject", "textBody", "htmlBody"]],
      ["tickets", "reply", ["textBody", "htmlBody"]],
      ["tickets", "nudge", ["textBody", "htmlBody"]],
      ["tickets", "close", ["textBody", "htmlBody"]],
    ]
    for (const [app, tool, params] of expected) {
      expect(toolRegistry.get([orgId, app, tool])?.outboundTextParams).toEqual(params)
    }
  })
  it("social and invoicing declare theirs in the manifest", () => {
    const social = manifestTools("bundled-apps/social/app.manifest.json")
    expect(social.reply_to_finding?.outboundTextParams).toEqual(["reply_text"])
    expect(social.send_dm?.outboundTextParams).toEqual(["body"])
    const invoicing = manifestTools("bundled-apps/invoicing/app.manifest.json")
    expect(invoicing.documents_send_to_customer?.outboundTextParams).toEqual(["subject", "body"])
  })
})

describe("a placeholder is refused before any approval is staged", () => {
  const conversationId = "00000000-0000-4000-8000-000000000001"
  const accountId = "00000000-0000-4000-8000-000000000002"
  const cases: Array<[string, (body: string) => Record<string, unknown>]> = [
    ["mail:reply", (b) => ({ conversationId, textBody: b })],
    ["mail:forward", (b) => ({ conversationId, to: ["ana@example.com"], note: b })],
    [
      "mail:compose",
      (b) => ({ accountId, to: ["ana@example.com"], subject: "Your order", textBody: b }),
    ],
    ["tickets:nudge", (b) => ({ ticketId, textBody: b })],
    ["tickets:close", (b) => ({ ticketId, closedReason: "resolved", textBody: b })],
    ["kernel:probe_social_send_dm", (b) => ({ body: b })],
    ["kernel:probe_invoicing_send", (b) => ({ subject: "Invoice", body: b })],
  ]
  for (const [toolName, params] of cases) {
    it(`${toolName}: refused with a placeholder, not refused when clean`, async () => {
      const before = await approvalCount()
      const refused = await outcome(toolName, params("We will send it to you by [DATE]."))
      expect(refused).toMatch(PLACEHOLDER)
      expect(refused).toContain("(Europe/Paris)")
      expect(await approvalCount()).toBe(before)
      // The clean draft goes on to the tool's own checks and gate (which may refuse an
      // unknown conversation for their own reasons): never the placeholder refusal.
      const clean = await outcome(toolName, params("We will send it to you by Friday."))
      expect(clean).not.toMatch(/placeholder/i)
    })
  }

  it("tickets:reply: refused with a placeholder, a clean reply stages its approval", async () => {
    const before = await approvalCount()
    await expect(
      call("tickets:reply", { ticketId, htmlBody: "<p>Hi {{firstName}}, by [DATE].</p>" }),
    ).rejects.toThrow(/Your draft contains a placeholder \(\{\{firstName\}\}, \[DATE\]\)/)
    expect(await approvalCount()).toBe(before)
    const res = await call("tickets:reply", {
      ticketId,
      textBody: "We will send it to you by Friday, October 30.",
    })
    expect(res.blocked?.reason).toBe("gated")
    expect(await approvalCount()).toBe(before + 1)
  })

  it("a clean probe draft stages its approval", async () => {
    const before = await approvalCount()
    const res = await call("kernel:probe_social_send_dm", { body: "Thanks, it ships Friday." })
    expect(res.blocked?.approvalRequestId).toBeDefined()
    expect(await approvalCount()).toBe(before + 1)
  })

  it("a person's own text from the UI is not judged", async () => {
    expect(await outcome("kernel:probe_social_send_dm", { body: "Date: TBD" }, "human-ui")).toBe(
      "ok",
    )
  })
})

describe("the same rule holds on the other ways a draft reaches a card", () => {
  it("a handler-parked approval with a placeholder is refused", async () => {
    const before = await approvalCount()
    await expect(
      createHandlerApprovalRequest({
        orgId,
        requestedBy: userId,
        actorScopes: admin.scopes,
        defaultAppName: "kernel",
        threadId,
        origin: "in-app-agent",
        input: {
          tool_name: "kernel:probe_social_send_dm",
          summary: "parked by a handler",
          current_payload: { body: "Hi [Name]" },
        },
      }),
    ).rejects.toThrow(/Your draft contains a placeholder \(\[Name\]\)/)
    expect(await approvalCount()).toBe(before)
  })

  it("an agent's edit of a pending draft is refused; a person's edit is theirs", async () => {
    const res = await call("kernel:probe_social_send_dm", { body: "Ships Friday." })
    const id = res.blocked?.approvalRequestId as string
    expect(id).toBeDefined()
    await expect(
      updatePayload({
        orgId,
        requestId: id,
        actor: admin,
        fields: { body: "Ships on XX/XX." },
        // No positive null: the edit is an agent's (the kernel tool passes its frame's agent).
        actingAgentId: undefined,
      }),
    ).rejects.toThrow(/Your draft contains a placeholder \(XX\/XX\)/)
    const edited = await updatePayload({
      orgId,
      requestId: id,
      actor: admin,
      fields: { body: "Ships on XX/XX." },
      actingAgentId: null,
    })
    expect(edited.currentPayload.body).toBe("Ships on XX/XX.")
  })
})
