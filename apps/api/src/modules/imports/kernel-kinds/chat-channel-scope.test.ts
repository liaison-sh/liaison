// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Where `chat.message` may write. History goes into a channel an import
 * created (this run or an earlier one), or one a CLI import explicitly names
 * (`existingChannels`), never into a channel people created in the app: an
 * import there would post as any member (or as system), backdated, with no
 * event. A write into a channel this run did not create leaves one audit row
 * per channel.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { runImport } from "~/modules/imports/runner"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
let memberId = ""
let memberEmail = ""
const tag = () => crypto.randomUUID().slice(0, 8)

function admin(): UserContext {
  return {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
}

function importMessages(
  label: string,
  records: Array<Record<string, unknown>>,
  kindOptions?: Record<string, Record<string, unknown>>,
) {
  return runImport({
    orgId,
    actor: admin(),
    kinds: ["chat.message"],
    source: { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) },
    sourceLabel: label,
    mode: "cli",
    ...(kindOptions ? { kindOptions } : {}),
  })
}

async function liveChannel(handle: string): Promise<string> {
  const [live] = await sql`
    INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
    VALUES (${orgId}, ${handle}, ${`#${handle}`}, ${memberId}, true) RETURNING id`
  for (const uid of [memberId, adminId]) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${live!.id}, ${uid}, ${orgId}, 'member')`
  }
  return String(live!.id)
}

const forgedMessage = (ref: string) => ({
  externalRef: ref,
  threadRef: "finance",
  authorEmail: memberEmail,
  content: "Please wire the 48k to the new supplier IBAN today.",
  createdAt: "2026-01-05T09:00:00Z",
})

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `chat-scope-${tag()}`, name: "Chat Scope" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `owner-${tag()}@fabrikam.example`,
      name: "Owner",
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
  memberEmail = `ceo-${tag()}@fabrikam.example`
  memberId = (
    await ensureUser({
      orgId,
      email: memberEmail,
      name: "The CEO",
      password: "pw-import-1!",
      role: "member",
    })
  ).userId
}, 120_000)

afterAll(releaseTestLock)

describe("chat.message: which channels an import writes into", () => {
  it("never posts into a channel people created in the app", async () => {
    const label = `team${tag()}`
    const live = await liveChannel(`${label}-finance`)
    const r = await importMessages(label, [forgedMessage("m1")])
    expect(r.counts["chat.message"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(r.errors[0]?.error)).toMatch(/not created by an import/)
    const written = await sql`
      SELECT id FROM kernel.messages WHERE org_id = ${orgId} AND thread_id = ${live}`
    expect(written.length).toBe(0)
  })

  it("a channel an earlier import created still takes attributed, backdated history", async () => {
    const label = `imp${tag()}`
    const threads = await runImport({
      orgId,
      actor: admin(),
      kinds: ["chat.thread"],
      source: {
        type: "records",
        records: [{ line: 1, record: { externalRef: "finance", name: "finance" } }],
      },
      sourceLabel: label,
      mode: "cli",
    })
    expect(threads.counts["chat.thread"]?.created).toBe(1)
    const r = await importMessages(label, [forgedMessage("m2")])
    expect(r.counts["chat.message"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [msg] = await sql`
      SELECT m.author_id, m.created_at FROM kernel.messages m
      JOIN kernel.threads t ON t.id = m.thread_id
      WHERE t.org_id = ${orgId} AND t.handle = ${`${label}-finance`}`
    expect(msg?.author_id).toBe(memberId)
    expect(new Date(msg?.created_at as string).toISOString()).toBe("2026-01-05T09:00:00.000Z")
    const audit = await sql`
      SELECT metadata FROM kernel.audit_log
      WHERE org_id = ${orgId} AND action = 'import.chat_history_into_existing_channel'
        AND metadata ->> 'handle' = ${`${label}-finance`}`
    expect(audit.length).toBe(1)
  })

  it("a CLI import may name an existing channel explicitly, and the write is audited", async () => {
    const label = `cli${tag()}`
    const live = await liveChannel(`${label}-finance`)
    const r = await importMessages(
      label,
      [forgedMessage("m3"), { ...forgedMessage("m4"), content: "second" }],
      {
        "chat.message": { existingChannels: ["finance"] },
      },
    )
    expect(r.counts["chat.message"]).toEqual({ created: 2, skipped: 0, failed: 0 })
    const written = await sql`
      SELECT id FROM kernel.messages WHERE org_id = ${orgId} AND thread_id = ${live}`
    expect(written.length).toBe(2)
    const audit = await sql`
      SELECT actor_id, entity_id, metadata FROM kernel.audit_log
      WHERE org_id = ${orgId} AND action = 'import.chat_history_into_existing_channel'
        AND entity_id = ${live}`
    expect(audit.length).toBe(1)
    expect(audit[0]?.actor_id).toBe(adminId)
  })
})
