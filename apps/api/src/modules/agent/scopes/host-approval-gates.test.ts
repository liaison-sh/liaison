// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Calendar guests: an agent's event write needs an approval only when it invites an address
// nobody in the organisation has dealt with. Known: members, saved contacts, ticket requesters
// and participants, addresses on a mail thread the org wrote in, and trusted senders. This holds
// whatever the turn read, and not at all when the org switched the outside-content approvals off.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { hostRequiresApproval } from "~/modules/agent/scopes/host-approval-gates"
import { knownAddresses, unknownInvitedGuests } from "~/modules/agent/scopes/known-guests"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORG = "00000000-0000-4000-8000-0000000e7b01"
const USER = "00000000-0000-4000-8000-0000000e7b02"
const THREAD = "00000000-0000-4000-8000-0000000e7b03"
const CAL_ACCOUNT = "00000000-0000-4000-8000-0000000e7b04"
const CALENDAR = "00000000-0000-4000-8000-0000000e7b05"
const EVENT = "00000000-0000-4000-8000-0000000e7b06"
const MAIL_ACCOUNT = "00000000-0000-4000-8000-0000000e7b07"
const ANSWERED = "00000000-0000-4000-8000-0000000e7b08"
const UNANSWERED = "00000000-0000-4000-8000-0000000e7b09"
const MEMBER = "member@guests-org.test"
const STRANGER = "stranger@outside.test"

let ran = 0

function create(attendees: string[], origin: "in-app-agent" | "human-ui" = "in-app-agent") {
  return executeTool({
    toolName: "calendar:create_event",
    orgId: ORG,
    actor: { actorType: "user", userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
    params: { title: "Sync", attendees },
    threadId: THREAD,
    origin,
    stepBundleId: null,
  })
}

describe("calendar guests the organisation knows", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${ORG}, 'GuestsOrg', 'guests-org', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${USER}, ${ORG}, ${MEMBER}, 'Member', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (org_id, email, name, status) VALUES (${ORG}, 'gone@guests-org.test', 'Gone', 'deactivated') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${THREAD}, ${ORG}, 'guests-thread', 'agent_chat', ${USER}, false) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.contacts (org_id, handle, email) VALUES (${ORG}, 'saved-contact', 'Saved@Contact.test')`
    await sql`INSERT INTO app_tickets.tickets (org_id, handle, reply_token, subject, channel, sla_target_seconds, requester_email, participant_emails)
      VALUES (${ORG}, 'guests-1', 'guesttok1', 'Hi', 'email', 3600, 'requester@customer.test', '["copied@customer.test"]'::jsonb)`
    await sql`INSERT INTO app_mail.accounts (id, org_id, connected_account_id, provider, email_address, sync_status)
      VALUES (${MAIL_ACCOUNT}, ${ORG}, gen_random_uuid(), 'gmail', 'team@guests-org.test', 'ok')`
    await sql`INSERT INTO app_mail.conversations (id, org_id, account_id, external_thread_id, status)
      VALUES (${ANSWERED}, ${ORG}, ${MAIL_ACCOUNT}, 'answered', 'open'),
             (${UNANSWERED}, ${ORG}, ${MAIL_ACCOUNT}, 'unanswered', 'open')`
    await sql`INSERT INTO app_mail.messages (org_id, conversation_id, account_id, direction, from_address, to_addresses)
      VALUES (${ORG}, ${ANSWERED}, ${MAIL_ACCOUNT}, 'inbound', '{"email":"partner@vendor.test"}'::jsonb, '[{"email":"team@guests-org.test"}]'::jsonb),
             (${ORG}, ${ANSWERED}, ${MAIL_ACCOUNT}, 'outbound', '{"email":"team@guests-org.test"}'::jsonb, '[{"email":"partner@vendor.test"}]'::jsonb),
             (${ORG}, ${UNANSWERED}, ${MAIL_ACCOUNT}, 'inbound', '{"email":"cold@spammer.test"}'::jsonb, '[{"email":"team@guests-org.test"}]'::jsonb)`
    await sql`INSERT INTO app_calendar.accounts (id, org_id, connected_account_id, owner_type, email_address)
      VALUES (${CAL_ACCOUNT}, ${ORG}, gen_random_uuid(), 'org', ${MEMBER})`
    await sql`INSERT INTO app_calendar.calendars (id, org_id, account_id, google_calendar_id, name, calaccess)
      VALUES (${CALENDAR}, ${ORG}, ${CAL_ACCOUNT}, 'primary', 'Team', 'org')`
    await sql`INSERT INTO app_calendar.events (id, org_id, calendar_id, attendees, calaccess)
      VALUES (${EVENT}, ${ORG}, ${CALENDAR}, ${JSON.stringify([{ email: MEMBER }, { email: STRANGER }])}::jsonb, 'org')`
    // A stand-in under the host-listed name: the gate is the host's, not the handler's.
    toolRegistry.set([ORG, "calendar", "create_event"], {
      appName: "calendar",
      name: "create_event",
      description: "calendar event (test stand-in)",
      requiredScopes: ["calendar:events:write"],
      trustBoundary: "user",
      params: z.object({ title: z.string(), attendees: z.array(z.string()) }),
      handler: async () => {
        ran++
        return { ok: true }
      },
    })
  })

  afterAll(async () => {
    toolRegistry.delete([ORG, "calendar", "create_event"])
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_calendar.events WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_calendar.calendars WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_calendar.accounts WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_mail.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.trusted_senders WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    broadcastSpy.mockRestore()
  })

  it("knows members, contacts, ticket parties and answered mail correspondents", async () => {
    const known = await knownAddresses(ORG, [
      MEMBER.toUpperCase(),
      "saved@contact.test",
      "requester@customer.test",
      "copied@customer.test",
      "partner@vendor.test",
      "cold@spammer.test",
      "gone@guests-org.test",
      STRANGER,
    ])
    expect([...known].sort()).toEqual(
      [
        MEMBER,
        "copied@customer.test",
        "partner@vendor.test",
        "requester@customer.test",
        "saved@contact.test",
      ].sort(),
    )
  })

  it("knows a trusted address and every address of a trusted domain", async () => {
    const { addTrustedSender } = await import("~/modules/contacts/trusted-senders")
    await addTrustedSender(ORG, USER, { kind: "address", value: "ally@gmail.com" })
    await addTrustedSender(ORG, USER, { kind: "domain", value: "partner-co.test" })
    try {
      const known = await knownAddresses(ORG, [
        "ally@gmail.com",
        "other@gmail.com",
        "anyone@partner-co.test",
      ])
      expect([...known].sort()).toEqual(["ally@gmail.com", "anyone@partner-co.test"])
    } finally {
      await sql`DELETE FROM kernel.trusted_senders WHERE org_id = ${ORG}`
    }
  })

  it("an edit invites only the guests it adds", async () => {
    // The stranger already on the event is not a new invitation; a new stranger is.
    expect(
      await unknownInvitedGuests(
        "calendar:update_event",
        { eventId: EVENT, attendees: [MEMBER, STRANGER] },
        ORG,
      ),
    ).toEqual([])
    expect(
      await unknownInvitedGuests("calendar:update_event", { eventId: EVENT, title: "x" }, ORG),
    ).toEqual([])
    expect(
      await unknownInvitedGuests(
        "calendar:update_event",
        { eventId: EVENT, attendees: [MEMBER, STRANGER, "new@outside.test"] },
        ORG,
      ),
    ).toEqual(["new@outside.test"])
    expect(
      await hostRequiresApproval({
        toolName: "calendar:create_event",
        params: { attendees: "not-a-list" },
        orgId: ORG,
      }),
    ).toBe(true)
  })

  it("asks for approval only for an unknown guest, on a turn that read nothing outside", async () => {
    ran = 0
    const known = await create([MEMBER, "partner@vendor.test", "requester@customer.test"])
    expect(known.blocked).toBeUndefined()
    expect(ran).toBe(1)

    const unknown = await create([MEMBER, STRANGER])
    expect(unknown.blocked?.approvalRequestId).toBeDefined()
    expect(ran).toBe(1)

    // A person's own click is not the agent inviting anyone.
    const byHand = await create([STRANGER], "human-ui")
    expect(byHand.blocked).toBeUndefined()
    expect(ran).toBe(2)
  })

  it("an auto-approve policy for the tool answers it", async () => {
    await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name, enabled, allow_after_untrusted_content)
      VALUES (${ORG}, 'calendar:create_event', true, true)`
    try {
      ran = 0
      const res = await create([STRANGER])
      expect(res.blocked).toBeUndefined()
      expect(ran).toBe(1)
    } finally {
      await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    }
  })

  it("asks nothing when the org switched the outside-content approvals off", async () => {
    await sql`UPDATE kernel.organizations SET settings = '{"webContentProtection":"off"}'::jsonb WHERE id = ${ORG}`
    try {
      ran = 0
      const res = await create([STRANGER])
      expect(res.blocked).toBeUndefined()
      expect(ran).toBe(1)
    } finally {
      await sql`UPDATE kernel.organizations SET settings = '{}'::jsonb WHERE id = ${ORG}`
    }
  })

  it("the calendar writes are no longer outward actions after outside content", async () => {
    const manifest = (await import("~/apps/calendar/app.manifest.json")).default as {
      tools: Record<string, { externalEffect?: boolean }>
    }
    expect(manifest.tools.create_event?.externalEffect).toBeUndefined()
    expect(manifest.tools.update_event?.externalEffect).toBeUndefined()
  })
})
