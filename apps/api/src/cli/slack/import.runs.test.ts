// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `slack import` writes through the import framework: one `chat.thread` run
 * for the channels and one `chat.message` run for their history, each on the
 * runs list and undoable. A message carries its `slack:<ts>` external ref, a
 * reply sits under its root, and a re-run imports nothing twice.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSlackImport } from "~/cli/slack/import"
import { sql } from "~/db"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe("slack import: through import runs", () => {
  test("channels and messages land as two undoable runs, and a re-run adds nothing", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const slug = `slack-runs-${tag}`
    const { orgId } = await ensureOrg({ slug, name: "SlackRunsOrg" })
    const email = `ann-${tag}@fabrikam.example`
    const { userId: ann } = await ensureUser({
      orgId,
      email,
      name: "Ann",
      password: "pw-import-1!",
      role: "admin",
    })

    const dir = mkdtempSync(join(tmpdir(), "slack-runs-"))
    tmpDirs.push(dir)
    writeFileSync(
      join(dir, "users.json"),
      JSON.stringify([{ id: "UANN", name: "ann", profile: { real_name: "Ann", email } }]),
    )
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify([
        {
          id: "C1",
          name: "general",
          created: 1_600_000_000,
          members: ["UANN"],
          topic: { value: "News" },
        },
      ]),
    )
    mkdirSync(join(dir, "general"))
    writeFileSync(
      join(dir, "general", "2025-01-01.json"),
      JSON.stringify([
        {
          type: "message",
          user: "UANN",
          ts: "1735689600.000100",
          text: "root",
          reactions: [{ name: "thumbsup", users: ["UANN"] }],
        },
        {
          type: "message",
          user: "UANN",
          ts: "1735689601.000100",
          thread_ts: "1735689600.000100",
          text: "reply",
        },
      ]),
    )
    const userMapPath = join(dir, "user-map.json")
    writeFileSync(userMapPath, "{}")

    const first = await runSlackImport({
      exportDir: dir,
      orgSlug: slug,
      userMapPath,
      skipFiles: true,
    })
    expect(first.report.errors).toEqual([])
    expect(first.report.totalMessagesImported).toBe(2)
    expect(first.report.totalRepliesImported).toBe(1)
    expect(first.report.totalReactionsImported).toBe(1)

    const runs = await sql`
      SELECT id, kind_set, status FROM kernel.import_runs WHERE org_id = ${orgId} ORDER BY created_at`
    expect(runs.map((r) => [r.kind_set, r.status])).toEqual([
      [["chat.thread"], "done"],
      [["chat.message"], "done"],
    ])
    const msgs = await sql`
      SELECT content, external_ref, reply_root_id, author_id FROM kernel.messages
      WHERE org_id = ${orgId} ORDER BY created_at`
    expect(msgs.map((m) => [m.content, m.external_ref, m.author_id])).toEqual([
      ["root", "slack:1735689600.000100", ann],
      ["reply", "slack:1735689601.000100", ann],
    ])
    expect(msgs[1]!.reply_root_id).not.toBeNull()

    const again = await runSlackImport({
      exportDir: dir,
      orgSlug: slug,
      userMapPath,
      skipFiles: true,
    })
    expect(again.report.totalMessagesImported).toBe(0)
    expect(again.report.totalMessagesAlreadyImported).toBe(2)

    // The history run is undone on its own; the channel stays.
    const report = await undoImportRun(orgId, String(runs[1]!.id), { userId: ann })
    expect(report.refused).toEqual([])
    expect((await sql`SELECT 1 FROM kernel.messages WHERE org_id = ${orgId}`).length).toBe(0)
    expect(
      (await sql`SELECT 1 FROM kernel.threads WHERE org_id = ${orgId} AND handle = 'slack-general'`)
        .length,
    ).toBe(1)
  })
})
