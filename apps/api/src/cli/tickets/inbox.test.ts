// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB test for `liaison tickets inbox <list|create|update|move>`, focused
 * on Task 1's per-inbox email identity flags added to `create`/`update`
 * (--from-name, --reply-to, --signature-html/--signature-text, --ack-enabled,
 * --ack-body, --sla-promise).
 */
import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { runTicketsInbox } from "~/cli/tickets/inbox"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

let orgSlug: string
let testOrgId: string

beforeAll(async () => {
  orgSlug = `cli-inbox-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let orgId = ""
  await withSystemDb("cli-inbox-fixture", async (tx) => {
    orgId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${kernelRel("organizations")} (id, name, slug)
        VALUES (gen_random_uuid(), 'CLI Inbox Test', ${orgSlug}) RETURNING id`),
    )[0]!.id
    await tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("users")} (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${orgSlug}@x.test`}, 'A', 'active', 'h', 1, 1)`)
  })
  testOrgId = orgId
  await ensureAppsForOrg(orgId, {})
})

/**
 * A `mailbox` inbox is only legal alongside a real connected account
 * (`inboxes_kind_shape_check` requires connected_account_id AND email_address),
 * and the CLI has no flag to mint one — connecting a mailbox is the interactive
 * OAuth/credentials flow. So seed the pair directly.
 */
async function seedMailboxInbox(name: string, email: string): Promise<string> {
  return withSystemDb("cli-inbox-mailbox-fixture", async (tx) => {
    const creator = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM ${kernelRel("users")} WHERE org_id = ${testOrgId}::uuid LIMIT 1`,
      ),
    )[0]!.id
    const accountId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${kernelRel("connected_accounts")}
          (id, org_id, app_name, connection_name, provider_type, identifier,
           owner_type, status, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${testOrgId}::uuid, 'tickets', 'imap', 'credentials', ${email},
                'org', 'active', ${creator}::uuid, now(), now())
        RETURNING id`),
    )[0]!.id
    return extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, name, email_address, connected_account_id,
           default_sensitivity, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${testOrgId}::uuid, 'mailbox', ${name}, ${email}, ${accountId}::uuid,
                'internal', false, now(), now())
        RETURNING id`),
    )[0]!.id
  })
}

describe("liaison tickets inbox create/update — email identity flags", () => {
  it("create applies the email-identity flags to a new API inbox", async () => {
    const result = await runTicketsInbox([
      "create",
      "--org",
      orgSlug,
      "--name",
      "Support Bucket",
      "--kind",
      "api",
      "--from-name",
      "Acme Support",
      "--reply-to",
      "support@acme.test",
      "--ack-enabled",
      "false",
      "--sla-promise",
      "within 1 business day",
    ])
    expect(result.exitCode).toBe(0)
    const report = result.report as { id: string }
    expect(report.id).toBeTruthy()

    const list = await runTicketsInbox(["list", "--org", orgSlug])
    const inboxes = (list.report as { inboxes: Array<Record<string, unknown>> }).inboxes
    const created = inboxes.find((i) => i.id === report.id)
    expect(created?.fromDisplayName).toBe("Acme Support")
    expect(created?.replyToEmail).toBe("support@acme.test")
    expect(created?.ackEnabled).toBe(false)
    expect(created?.slaPromisePhrase).toBe("within 1 business day")
  })

  it("update changes only the fields passed, leaving others untouched", async () => {
    const created = await runTicketsInbox([
      "create",
      "--org",
      orgSlug,
      "--name",
      "Updatable Bucket",
      "--kind",
      "api",
      "--sla-promise",
      "within 2 business days",
    ])
    const inboxId = (created.report as { id: string }).id

    const updated = await runTicketsInbox([
      "update",
      "--org",
      orgSlug,
      "--id",
      inboxId,
      "--signature-text",
      "The Acme Team",
    ])
    expect(updated.exitCode).toBe(0)

    const list = await runTicketsInbox(["list", "--org", orgSlug])
    const inboxes = (list.report as { inboxes: Array<Record<string, unknown>> }).inboxes
    const row = inboxes.find((i) => i.id === inboxId)
    expect(row?.signatureText).toBe("The Acme Team")
    // untouched by the update call
    expect(row?.slaPromisePhrase).toBe("within 2 business days")
  })

  it("--notify-new-ticket: off by default, set by create and update, surfaced by list", async () => {
    const off = await runTicketsInbox(["create", "--org", orgSlug, "--name", "Quiet Bucket"])
    const on = await runTicketsInbox([
      "create",
      "--org",
      orgSlug,
      "--name",
      "Loud Bucket",
      "--notify-new-ticket",
      "true",
    ])
    const offId = (off.report as { id: string }).id
    const onId = (on.report as { id: string }).id
    const listed = async () =>
      (
        (await runTicketsInbox(["list", "--org", orgSlug])).report as {
          inboxes: Array<Record<string, unknown>>
        }
      ).inboxes
    let inboxes = await listed()
    expect(inboxes.find((i) => i.id === offId)?.notifyNewTicket).toBe(false)
    expect(inboxes.find((i) => i.id === onId)?.notifyNewTicket).toBe(true)

    const args = ["update", "--org", orgSlug, "--notify-new-ticket"]
    expect((await runTicketsInbox([...args, "true", "--id", offId])).exitCode).toBe(0)
    expect((await runTicketsInbox([...args, "false", "--id", onId])).exitCode).toBe(0)
    inboxes = await listed()
    expect(inboxes.find((i) => i.id === offId)?.notifyNewTicket).toBe(true)
    expect(inboxes.find((i) => i.id === onId)?.notifyNewTicket).toBe(false)
  })

  it("update sets --reply-via, the send transport an API inbox has no other way to get", async () => {
    // An api inbox has no mail account of its own: without reply_via_inbox_id
    // its replies and acknowledgements have nowhere to go, and NOTHING errors —
    // the ack is simply never sent. Until now only `create` could set it, so a
    // bucket created before its mailbox existed could never be wired up
    // without hand-editing the row.
    // A `mailbox` inbox is only legal with a real connected account (the
    // inboxes_kind_shape_check constraint), so seed one rather than pretending.
    const mailboxId = await seedMailboxInbox("Desk Mailbox", "desk@acme.test")

    const bucket = await runTicketsInbox([
      "create",
      "--org",
      orgSlug,
      "--name",
      "Form Bucket",
      "--kind",
      "api",
    ])
    const bucketId = (bucket.report as { id: string }).id

    const updated = await runTicketsInbox([
      "update",
      "--org",
      orgSlug,
      "--id",
      bucketId,
      "--reply-via",
      mailboxId,
    ])
    expect(updated.exitCode).toBe(0)

    const list = await runTicketsInbox(["list", "--org", orgSlug])
    const inboxes = (list.report as { inboxes: Array<Record<string, unknown>> }).inboxes
    expect(inboxes.find((i) => i.id === bucketId)?.replyViaInboxId).toBe(mailboxId)
  })

  it("update refuses a --reply-via that is not a connected mailbox inbox", async () => {
    // Pointing an api inbox at another api inbox would build a transport chain
    // that dead-ends. The admin op rejects it; the CLI must surface that rather
    // than report success.
    const a = await runTicketsInbox([
      "create",
      "--org",
      orgSlug,
      "--name",
      "Bucket A",
      "--kind",
      "api",
    ])
    const b = await runTicketsInbox([
      "create",
      "--org",
      orgSlug,
      "--name",
      "Bucket B",
      "--kind",
      "api",
    ])
    const res = await runTicketsInbox([
      "update",
      "--org",
      orgSlug,
      "--id",
      (a.report as { id: string }).id,
      "--reply-via",
      (b.report as { id: string }).id,
    ])
    expect(res.exitCode).not.toBe(0)
  })

  it("update requires at least one email-identity flag", async () => {
    const created = await runTicketsInbox([
      "create",
      "--org",
      orgSlug,
      "--name",
      "NoFlagsBucket",
      "--kind",
      "api",
    ])
    const inboxId = (created.report as { id: string }).id
    const result = await runTicketsInbox(["update", "--org", orgSlug, "--id", inboxId])
    expect(result.exitCode).toBe(2)
  })
})
