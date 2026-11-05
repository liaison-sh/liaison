// SPDX-License-Identifier: FSL-1.1-ALv2
// tickets:get rich view — quoted-tail stripping now runs BEFORE sanitize (the
// perf fix for 5-10s prod gets: sanitize-html's full DOM parse only sees the
// trimmed head, not 200-350KB quote chains). These tests pin the safety
// invariants of that ordering: the final body is still fully sanitized, the
// quoted tail is elided with the marker, and the marker's data attribute
// survives sanitize (allowlisted in lib/email/sanitize.ts).
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgId: string
let userId: string
let ticketId: string
let messageId: string
let actor: ActorContext
let ownReplyId: string
const OWN_QUOTE = "OWN-REPLY-QUOTED-CONTENT"
const OWN_TAIL = "OWN-REPLY-TEXT-AFTER-THE-QUOTE"

const QUOTED_SENTINEL = "OLD-QUOTED-CHAIN-CONTENT"
const HTML_BODY = [
  "<p>fresh reply text</p>",
  "<script>alert('head')</script>",
  '<div class="gmail_quote">On Mon, 20 Jul 2026 at 10:00, Someone &lt;s@x.com&gt; wrote:',
  `<p>${QUOTED_SENTINEL} ${"lorem ipsum dolor sit amet ".repeat(20)}</p>`,
  "<script>alert('tail')</script></div>",
].join("")

beforeAll(async () => {
  const slug = `get-striporder-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("get-striporder-fixture", async (tx) => {
    const orgRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Strip Order', ${slug}) RETURNING id
    `)) as any
    orgId = (orgRows.rows ?? orgRows)[0].id
    const userRows = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@test.com`}, 'SO', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (userRows.rows ?? userRows)[0].id
    ticketId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        last_inbound_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${ticketId}, ${orgId}, ${`ticket-${slug}`}, 'Quote order', 'open', 'normal', 'manual', 'internal',
        ${`RT${slug.replace(/-/g, "").slice(0, 14)}`}, 3600, now() + interval '1 hour',
        now(), 0, 1,
        now(), now(), now(), now()
      )
    `)
    messageId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, html_body, text_body, sent_at, created_at, updated_at)
      VALUES (${messageId}, ${orgId}, ${ticketId}, 'inbound', ${HTML_BODY},
              'fresh reply text', now() - interval '5 minutes', now(), now())
    `)
    // A reply written in Liaison whose body quotes the customer.
    ownReplyId = crypto.randomUUID()
    const ownHtml = `<p>Bonjour,</p><blockquote style="margin:0 0 1em"><p>${OWN_QUOTE} ${"lorem ipsum ".repeat(10)}</p></blockquote><p>${OWN_TAIL}</p>`
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, html_body, text_body, created_by, sent_at, created_at, updated_at)
      VALUES (${ownReplyId}, ${orgId}, ${ticketId}, 'outbound', ${ownHtml},
              ${`Bonjour,\n\n> ${OWN_QUOTE}\n\n${OWN_TAIL}`}, ${userId}, now(), now(), now())
    `)
  })
  await ensureAppsForOrg(orgId, {})
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
})

describe("tickets.get strip-before-sanitize ordering", () => {
  it("rich view: quoted tail elided AND head still fully sanitized, marker attr on the wire", async () => {
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId, includeHtml: true, stripQuoted: true },
    })
    const m = (out.data as any).messages.items.find((x: any) => x.id === messageId)
    expect(m).toBeTruthy()
    // Head content kept.
    expect(m.htmlBody).toContain("fresh reply text")
    // Sanitize still applied AFTER the strip: no script from the head survives.
    expect(m.htmlBody).not.toContain("<script")
    expect(m.htmlBody).not.toContain("alert(")
    // Quoted tail elided at the gmail_quote boundary, replaced by the marker.
    expect(m.htmlBody).not.toContain(QUOTED_SENTINEL)
    expect(m.htmlBody).toContain("[quoted history trimmed:")
    // The marker div's size attribute survives sanitize (allowlisted).
    expect(m.htmlBody).toContain("data-quote-trimmed")
  })

  it("single-message drill-down (stripQuoted:false) returns the full chain, still sanitized", async () => {
    const out = await executeTool({
      toolName: "tickets:get",
      orgId,
      actor,
      params: { ticketId, messageId, includeHtml: true, stripQuoted: false },
    })
    const m = (out.data as any).messages.items.find((x: any) => x.id === messageId)
    expect(m).toBeTruthy()
    expect(m.htmlBody).toContain(QUOTED_SENTINEL)
    expect(m.htmlBody).not.toContain("<script")
    expect(m.htmlBody).not.toContain("alert(")
    expect(m.htmlBody).not.toContain("[quoted history trimmed:")
  })

  // The quote trimming is for the history a mail client appended; a reply
  // written in Liaison carries none, so its own quote is never cut.
  it("never trims a reply written in Liaison, rich or slim", async () => {
    for (const includeHtml of [true, false]) {
      const out = await executeTool({
        toolName: "tickets:get",
        orgId,
        actor,
        params: { ticketId, includeHtml, stripQuoted: true },
      })
      const m = (out.data as any).messages.items.find((x: any) => x.id === ownReplyId)
      const body = includeHtml ? m.htmlBody : m.textBody
      expect(body).toContain(OWN_QUOTE)
      expect(body).toContain(OWN_TAIL)
      expect(body).not.toContain("[quoted history trimmed:")
    }
  })
})
