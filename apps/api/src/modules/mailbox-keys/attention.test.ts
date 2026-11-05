// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The "your mailbox is not syncing" attention item (design audit 2026-09-30,
// #13). A personal mailbox waiting for its owner's encryption enrollment used
// to be polled every five minutes forever with nobody told; the sweep now
// leaves it alone (gmail-sync.test.ts) and this item tells the OWNER, once per
// mailbox, for exactly as long as the condition holds.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import { computeMailboxEnrollmentAttentionItems } from "~/modules/mailbox-keys/attention"

const suffix = crypto.randomUUID().slice(0, 8)
let orgId: string
let ownerId: string
let otherId: string
const accounts: Record<string, string> = {}

async function user(name: string): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`${name}-${suffix}@test.example`}, ${name}, 'active', 'h')
      RETURNING id`),
  )
  return row.id
}

async function mailbox(
  key: string,
  owner: string,
  state: string,
  opts: { disconnected?: boolean } = {},
): Promise<void> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
      VALUES (${orgId}, gen_random_uuid(), 'user', ${owner}, 'gmail',
              ${`${key}-${suffix}@gmail.example`}, 'pre-sync')
      RETURNING id`),
  )
  // The INSERT trigger derives the state from enrollment; set the case under test.
  await db.execute(drizzleSql`
    UPDATE app_mail.accounts
       SET encryption_state = ${state},
           disconnected_at = ${opts.disconnected ? drizzleSql`now()` : drizzleSql`NULL`}
     WHERE id = ${row.id}::uuid`)
  accounts[key] = row.id
}

beforeAll(async () => {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Enrollment attention', ${`enroll-attn-${suffix}`}) RETURNING id`),
  )
  orgId = org.id
  ownerId = await user("owner")
  otherId = await user("other")
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  await ensureAppsForOrg(orgId)
  await mailbox("pending", ownerId, "pending_enrollment")
  await mailbox("blocked", ownerId, "blocked")
  await mailbox("ready", ownerId, "ready")
  await mailbox("gone", ownerId, "pending_enrollment", { disconnected: true })
  await mailbox("others", otherId, "pending_enrollment")
}, 120_000)

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}::uuid`)
})

describe("mailbox enrollment attention item", () => {
  it("is registered as a kernel attention provider", () => {
    expect(attentionItemsRegistry.get(["*", "kernel.mailbox_enrollment"])).toMatchObject({
      handler: "computeMailboxEnrollmentAttentionItems",
      trusted: true,
    })
  })

  it("tells the owner about each of their mailboxes that cannot sync, and nothing else", async () => {
    const items = await computeMailboxEnrollmentAttentionItems(null as never, orgId, ownerId)
    const byAccount = Object.fromEntries(items.map((i) => [i.metadata?.mailAccountId, i]))
    expect(Object.keys(byAccount).sort()).toEqual([accounts.blocked, accounts.pending].sort())
    const pending = byAccount[accounts.pending]
    expect(pending).toMatchObject({
      id: `kernel:mailbox_enrollment:${accounts.pending}`,
      app: "kernel",
      entity: "connected_account",
      kind: "admin_action",
      // Mail has a settings page (its manifest), so the row opens it.
      metadata: { settingsRoute: "/settings/apps/mail", encryptionState: "pending_enrollment" },
    })
    expect(pending.summary).toContain(`pending-${suffix}@gmail.example`)
    expect(pending.summary).toContain("encryption")
    expect(byAccount[accounts.blocked].summary).toContain("reset")
  })

  it("never shows one member's mailbox to another", async () => {
    const items = await computeMailboxEnrollmentAttentionItems(null as never, orgId, otherId)
    expect(items.map((i) => i.metadata?.mailAccountId)).toEqual([accounts.others])
  })

  it("goes away once the mailbox can sync", async () => {
    await db.execute(
      drizzleSql`UPDATE app_mail.accounts SET encryption_state = 'ready' WHERE id = ${accounts.others}::uuid`,
    )
    expect(await computeMailboxEnrollmentAttentionItems(null as never, orgId, otherId)).toEqual([])
  })
})
