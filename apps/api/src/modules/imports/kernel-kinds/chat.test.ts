// SPDX-License-Identifier: FSL-1.1-ALv2
// Kernel import kinds `chat.thread` and `chat.message`: channels and their
// history, written without live side effects (no events), deduplicated by
// handle and by external ref, replies placed under their root (linked after
// the kind when the root comes later), bot posts by a placeholder, files kept
// as message attachments, and undone without touching what came after.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { runImport } from "~/modules/imports/runner"
import type { SourceItem } from "~/modules/imports/source"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let adminId = ""
let adminEmail = ""
let memberId = ""
let memberEmail = ""
const tmpDirs: string[] = []
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

function recordsOf(records: Array<Record<string, unknown>>): {
  type: "records"
  records: SourceItem[]
} {
  return { type: "records", records: records.map((record, i) => ({ line: i + 1, record })) }
}

function run(
  kind: string,
  records: Array<Record<string, unknown>>,
  label: string,
  extra: { placeholders?: boolean; batchSize?: number } = {},
) {
  return runImport({
    orgId,
    actor: admin(),
    kinds: [kind],
    source: recordsOf(records),
    sourceLabel: label,
    mode: "cli",
    ...extra,
  })
}

async function threadByHandle(handle: string) {
  const [row] = await sql`
    SELECT id, title, topic, description, discoverable, created_by
    FROM kernel.threads WHERE org_id = ${orgId} AND handle = ${handle}`
  return row
}

async function messagesOf(threadId: string) {
  return sql`
    SELECT id, content, author_id, author_type, reply_root_id, also_in_channel, external_ref,
           deleted_at, metadata
    FROM kernel.messages WHERE org_id = ${orgId} AND thread_id = ${threadId}
    ORDER BY created_at, id`
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-chat-${tag()}`, name: "Chat Import" })).orgId
  adminEmail = `owner-${tag()}@fabrikam.example`
  adminId = (
    await ensureUser({
      orgId,
      email: adminEmail,
      name: "Owner",
      password: "pw-import-1!",
      role: "admin",
    })
  ).userId
  memberEmail = `member-${tag()}@fabrikam.example`
  memberId = (
    await ensureUser({
      orgId,
      email: memberEmail,
      name: "Member",
      password: "pw-import-1!",
      role: "member",
    })
  ).userId
}, 120_000)

afterAll(async () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  await releaseTestLock()
})

describe("chat.thread and chat.message", () => {
  it("imports a channel, its messages, a reply and reactions, and a re-run creates nothing", async () => {
    const label = `ch${tag()}`
    const thread = {
      externalRef: "general",
      name: "general",
      topic: "Company news",
      memberEmails: [adminEmail, memberEmail],
      creatorEmail: adminEmail,
    }
    const t1 = await run("chat.thread", [thread], label)
    expect(t1.counts["chat.thread"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const t = (await threadByHandle(`${label}-general`))!
    expect([t.title, t.topic, t.discoverable, t.created_by]).toEqual([
      "general",
      "Company news",
      true,
      adminId,
    ])
    const members =
      await sql`SELECT user_id, role FROM kernel.thread_participants WHERE thread_id = ${t.id} ORDER BY role`
    expect(members.map((m) => [m.user_id, m.role])).toEqual([
      [adminId, "admin"],
      [memberId, "member"],
    ])

    const msgs = [
      {
        externalRef: "1.0",
        threadRef: "general",
        authorEmail: adminEmail,
        content: "Hello",
        createdAt: "2025-01-01T09:00:00Z",
        reactions: [{ emoji: "👍", userEmails: [memberEmail] }],
      },
      {
        externalRef: "2.0",
        threadRef: "general",
        authorEmail: memberEmail,
        content: "Hi",
        createdAt: "2025-01-01T09:01:00Z",
      },
      {
        externalRef: "3.0",
        threadRef: "general",
        authorEmail: memberEmail,
        content: "A reply",
        createdAt: "2025-01-01T09:02:00Z",
        replyToRef: "1.0",
        alsoInChannel: true,
      },
    ]
    const m1 = await run("chat.message", msgs, label)
    expect(m1.counts["chat.message"]).toEqual({ created: 3, skipped: 0, failed: 0 })
    const rows = await messagesOf(String(t.id))
    expect(rows.map((r) => [r.content, r.author_id, r.external_ref])).toEqual([
      ["Hello", adminId, `${label}:1.0`],
      ["Hi", memberId, `${label}:2.0`],
      ["A reply", memberId, `${label}:3.0`],
    ])
    expect(rows[2]!.reply_root_id).toBe(rows[0]!.id)
    expect(rows[2]!.also_in_channel).toBe(true)
    const reactions =
      await sql`SELECT emoji, user_id FROM kernel.message_reactions WHERE message_id = ${rows[0]!.id}`
    expect(reactions.map((r) => [r.emoji, r.user_id])).toEqual([["👍", memberId]])
    // The reply thread's followers: the root's author and the replier.
    const followers =
      await sql`SELECT user_id FROM kernel.reply_thread_followers WHERE root_message_id = ${rows[0]!.id} ORDER BY user_id`
    expect(followers.map((f) => f.user_id).sort()).toEqual([adminId, memberId].sort())
    // No live side effects: the import queued no events for these messages.
    const events =
      await sql`SELECT 1 FROM kernel.pending_events WHERE payload->>'entityId' = ANY(${rows.map((r) => String(r.id))})`
    expect(events.length).toBe(0)

    const again = await run("chat.message", msgs, label)
    expect(again.counts["chat.message"]).toEqual({ created: 0, skipped: 3, failed: 0 })
    const tAgain = await run("chat.thread", [thread], label)
    expect(tAgain.counts["chat.thread"]).toEqual({ created: 0, skipped: 1, failed: 0 })
  })

  it("an existing channel is skipped and left as it is", async () => {
    const label = `ex${tag()}`
    await sql`
      INSERT INTO kernel.threads (org_id, handle, title, topic, created_by)
      VALUES (${orgId}, ${`${label}-ops`}, '#ops', 'Original topic', ${adminId})`
    const r = await run(
      "chat.thread",
      [{ externalRef: "ops", name: "ops", topic: "Imported topic", description: "x" }],
      label,
    )
    expect(r.counts["chat.thread"]).toEqual({ created: 0, skipped: 1, failed: 0 })
    const t = (await threadByHandle(`${label}-ops`))!
    expect([t.topic, t.description]).toEqual(["Original topic", null])
  })

  it("a reply whose root comes later in the run is linked to it; one whose root never comes is an orphan", async () => {
    const label = `rb${tag()}`
    await run(
      "chat.thread",
      [{ externalRef: "dev", name: "dev", memberEmails: [adminEmail] }],
      label,
    )
    const r = await run(
      "chat.message",
      [
        {
          externalRef: "5.0",
          threadRef: "dev",
          authorEmail: adminEmail,
          content: "early reply",
          createdAt: "2025-01-01T10:05:00Z",
          replyToRef: "4.0",
        },
        {
          externalRef: "4.0",
          threadRef: "dev",
          authorEmail: adminEmail,
          content: "root",
          createdAt: "2025-01-01T10:04:00Z",
        },
        {
          externalRef: "6.0",
          threadRef: "dev",
          authorEmail: adminEmail,
          content: "lost reply",
          createdAt: "2025-01-01T10:06:00Z",
          replyToRef: "nope",
        },
      ],
      label,
      { batchSize: 1 },
    )
    expect(r.counts["chat.message"]).toEqual({ created: 3, skipped: 0, failed: 0 })
    expect(r.report.repliesLinkedAfter).toBe(1)
    expect(r.report.orphanReplies).toBe(1)
    const rows = await messagesOf(String((await threadByHandle(`${label}-dev`))!.id))
    const byContent = new Map(rows.map((x) => [x.content, x]))
    expect(byContent.get("early reply")!.reply_root_id).toBe(byContent.get("root")!.id)
    expect(byContent.get("lost reply")!.reply_root_id).toBeNull()
    expect((byContent.get("lost reply")!.metadata as Record<string, unknown>).orphanReply).toBe(
      true,
    )
    // Linking the early reply was the run's own update: undo removes everything.
    expect(await undoImportRun(orgId, r.runId, { userId: adminId })).toEqual({
      deleted: 3,
      refused: [],
    })
  })

  it("a bot post is authored by a per-bot placeholder; an attachment is a message file", async () => {
    const label = `bt${tag()}`
    await run("chat.thread", [{ externalRef: "ci", name: "ci" }], label)
    const dir = mkdtempSync(join(tmpdir(), "chat-import-"))
    tmpDirs.push(dir)
    const path = join(dir, "build.log")
    writeFileSync(path, "build ok")
    const r = await run(
      "chat.message",
      [
        {
          externalRef: "7.0",
          threadRef: "ci",
          botKey: "ci-runner",
          authorName: "CI runner",
          content: "Build passed",
          createdAt: "2025-01-02T08:00:00Z",
          attachments: [{ filePath: path, filename: "build.log", mimeType: "text/plain" }],
        },
      ],
      label,
      { placeholders: true },
    )
    expect(r.counts["chat.message"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const [m] = await messagesOf(String((await threadByHandle(`${label}-ci`))!.id))
    const [author] =
      await sql`SELECT email, name, status FROM kernel.users WHERE id = ${m!.author_id}`
    expect(String(author!.email)).toEndWith("@import.invalid")
    expect([author!.name, author!.status]).toEqual(["CI runner (bot)", "deactivated"])
    expect((m!.metadata as Record<string, unknown>).agentAuthorLabel).toBe("CI runner")
    const files =
      await sql`SELECT filename, app, entity_type FROM kernel.files WHERE entity_id = ${String(m!.id)}`
    expect(files.map((f) => [f.filename, f.app, f.entity_type])).toEqual([
      ["build.log", "kernel", "message"],
    ])
  })

  it("a private channel is not discoverable and its non-members cannot see it", async () => {
    const label = `pc${tag()}`
    const t = await run(
      "chat.thread",
      [{ externalRef: "board", name: "board", private: true, memberEmails: [adminEmail] }],
      label,
    )
    expect(t.counts["chat.thread"]).toEqual({ created: 1, skipped: 0, failed: 0 })
    const thread = await threadByHandle(`${label}-board`)
    expect(thread!.discoverable).toBe(false)
    const asUser = (userId: string) =>
      withRlsContext(
        { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
        async (tx) =>
          extractRows(
            await tx.execute(
              drizzleSql`SELECT id FROM kernel.threads WHERE id = ${thread!.id}::uuid`,
            ),
          ).length,
      )
    expect(await asUser(adminId)).toBe(1)
    expect(await asUser(memberId)).toBe(0)
  })

  it("never writes into a thread the importer cannot see", async () => {
    const label = `pv${tag()}`
    // A private conversation the importer is not part of, with a matching handle.
    const [priv] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${orgId}, ${`${label}-secret`}, 'secret', ${memberId}, false) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${priv!.id}, ${memberId}, ${orgId}, 'owner')`
    const r = await runImport({
      orgId,
      actor: {
        actorType: "user",
        userId: adminId,
        orgId,
        scopes: ["kernel:threads:admin"],
        dimensionGrants: {},
      },
      kinds: ["chat.message"],
      source: recordsOf([
        {
          externalRef: "9.0",
          threadRef: "secret",
          authorEmail: adminEmail,
          content: "sneak",
          createdAt: "2025-01-03T08:00:00Z",
        },
      ]),
      sourceLabel: label,
      mode: "cli",
    })
    expect(r.counts["chat.message"]).toEqual({ created: 0, skipped: 0, failed: 1 })
    expect(String(r.errors[0]?.error)).toMatch(/threadRef "secret"/)
    expect((await messagesOf(String(priv!.id))).length).toBe(0)
  })

  it("undo refuses a channel someone posted in after the import", async () => {
    const label = `ud${tag()}`
    const t = await run(
      "chat.thread",
      [{ externalRef: "team", name: "team", memberEmails: [adminEmail] }],
      label,
    )
    const thread = (await threadByHandle(`${label}-team`))!
    await sql`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${thread.id}, ${orgId}, ${adminId}, 'posted later', '{}')`
    const report = await undoImportRun(orgId, t.runId, { userId: adminId })
    // The new message moved the channel's activity time: someone else's change.
    expect(report.refused.map((x) => [x.table, x.reason])).toEqual([
      ["kernel.threads", "changed_after_import"],
    ])
    expect(await threadByHandle(`${label}-team`)).toBeDefined()
  })

  it("undo keeps an imported message someone replied to after the import", async () => {
    const label = `ur${tag()}`
    await run(
      "chat.thread",
      [{ externalRef: "hall", name: "hall", memberEmails: [adminEmail] }],
      label,
    )
    const m = await run(
      "chat.message",
      [
        {
          externalRef: "1.0",
          threadRef: "hall",
          authorEmail: adminEmail,
          content: "question",
          createdAt: "2025-01-04T08:00:00Z",
        },
      ],
      label,
    )
    const thread = (await threadByHandle(`${label}-hall`))!
    const [root] = await messagesOf(String(thread.id))
    await sql`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, reply_root_id)
      VALUES (${thread.id}, ${orgId}, ${memberId}, 'a later answer', '{}', ${root!.id})`
    const report = await undoImportRun(orgId, m.runId, { userId: adminId })
    expect(report.refused.map((x) => [x.id, x.reason])).toEqual([[root!.id, "has_new_children"]])
    expect((await messagesOf(String(thread.id))).length).toBe(2)
  })
})
