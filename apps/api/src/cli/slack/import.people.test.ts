// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB test for how `slack import` resolves Slack people to Liaison users:
 * the explicit user map first, then the users.json profile email
 * (case-insensitive) against the org's real users, and a placeholder only for
 * the rest. Bots never match by email. A re-run after a person gained an
 * email match writes the real user on every NEW row and leaves the rows an
 * earlier run gave the placeholder untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { runSlackImport, slackEmailsToMatch } from "~/cli/slack/import"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

const users = () => drizzleSql.raw(`${schemaRef("kernel")}.users`)
const messages = () => drizzleSql.raw(`${schemaRef("kernel")}.messages`)

async function freshOrg(): Promise<{ orgId: string; slug: string }> {
  const slug = `slack-people-${crypto.randomUUID().slice(0, 12)}`
  const { orgId } = await ensureOrg({ slug, name: "SlackPeopleOrg" })
  return { orgId, slug }
}

async function addUser(orgId: string, email: string, name: string): Promise<string> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${users()} (id, org_id, email, name, status)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${email}, ${name}, 'active')
      RETURNING id::text AS id
    `),
  )
  return extractRows<{ id: string }>(rows)[0]!.id
}

async function authorsByText(orgId: string): Promise<Map<string, string>> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT content, author_id::text AS author_id FROM ${messages()} WHERE org_id = ${orgId}::uuid
    `),
  )
  return new Map(
    extractRows<{ content: string; author_id: string }>(rows).map((r) => [r.content, r.author_id]),
  )
}

async function userEmail(orgId: string, id: string): Promise<string> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`SELECT email FROM ${users()} WHERE id = ${id}::uuid`),
  )
  return extractRows<{ email: string }>(rows)[0]!.email
}

interface Export {
  dir: string
  userMapPath: string
}

function writeExport(
  slackUsers: unknown[],
  posts: Array<{ user: string; text: string; ts: string; bot_id?: string }>,
  userMap: Record<string, string>,
): Export {
  const dir = mkdtempSync(join(tmpdir(), "slack-people-"))
  tmpDirs.push(dir)
  writeFileSync(join(dir, "users.json"), JSON.stringify(slackUsers))
  writeFileSync(
    join(dir, "channels.json"),
    JSON.stringify([
      {
        id: "C1",
        name: "general",
        created: 1_600_000_000,
        members: slackUsers.map((u: any) => u.id),
      },
    ]),
  )
  mkdirSync(join(dir, "general"))
  writeFileSync(
    join(dir, "general", "2025-01-01.json"),
    JSON.stringify(posts.map((p) => ({ type: "message", ...p }))),
  )
  const userMapPath = join(dir, "user-map.json")
  writeFileSync(userMapPath, JSON.stringify(userMap))
  return { dir, userMapPath }
}

describe("slackEmailsToMatch", () => {
  test("lower-cases, skips bots and mapped users, groups a shared address", () => {
    const m = slackEmailsToMatch(
      [
        { id: "U1", name: "a", profile: { email: "Ann@Example.test" } },
        { id: "U2", name: "a2", deleted: true, profile: { email: "ann@example.test" } },
        { id: "U3", name: "b", profile: { email: "bob@example.test" } },
        { id: "B1", name: "bot", is_bot: true, profile: { email: "ann@example.test" } },
        { id: "B2", name: "app", profile: { email: "ann@example.test", bot_id: "BX" } },
        { id: "USLACKBOT", name: "slackbot", profile: { email: "ann@example.test" } },
        { id: "U4", name: "c" },
      ],
      { U3: "some-liaison-id" },
    )
    expect([...m]).toEqual([["ann@example.test", ["U1", "U2"]]])
  })
})

describe("slack import — people", () => {
  test("map wins, then email (case-insensitive), bots and the rest become placeholders", async () => {
    const { orgId, slug } = await freshOrg()
    const tag = crypto.randomUUID().slice(0, 8)
    const annEmail = `ann-${tag}@fabrikam.example`
    const bobEmail = `bob-${tag}@fabrikam.example`
    const ann = await addUser(orgId, annEmail, "Ann")
    const bob = await addUser(orgId, bobEmail, "Bob")
    const bobOther = await addUser(orgId, `bob.other-${tag}@fabrikam.example`, "Bob (map target)")
    const exp = writeExport(
      [
        { id: "UANN", name: "ann", profile: { real_name: "Ann", email: annEmail.toUpperCase() } },
        // Ann's second Slack account, deleted since: same person.
        { id: "UANN2", name: "ann.old", deleted: true, profile: { email: annEmail } },
        // In the map AND matching by email: the map wins.
        { id: "UBOB", name: "bob", profile: { real_name: "Bob", email: bobEmail } },
        { id: "UBOT", name: "ci-bot", is_bot: true, profile: { email: annEmail } },
        { id: "UGONE", name: "gone", profile: { real_name: "Gone", email: `gone-${tag}@x.test` } },
      ],
      [
        { user: "UANN", text: "from ann", ts: "1735689600.000100" },
        { user: "UANN2", text: "from ann old", ts: "1735689601.000100" },
        { user: "UBOB", text: "from bob", ts: "1735689602.000100" },
        { user: "UBOT", text: "from bot", ts: "1735689603.000100" },
        { user: "UGONE", text: "from gone", ts: "1735689604.000100" },
      ],
      { UBOB: bobOther },
    )
    const r = await runSlackImport({
      exportDir: exp.dir,
      orgSlug: slug,
      userMapPath: exp.userMapPath,
      skipFiles: true,
    })
    expect(r.report.errors).toEqual([])
    expect(r.exitCode).toBe(0)
    expect(r.report.mappedUsers).toBe(1)
    expect(r.report.matchedByEmail).toBe(2)
    const by = await authorsByText(orgId)
    expect(by.get("from ann")).toBe(ann)
    expect(by.get("from ann old")).toBe(ann)
    expect(by.get("from bob")).toBe(bobOther)
    expect(by.get("from bob")).not.toBe(bob)
    expect(await userEmail(orgId, by.get("from bot")!)).toEndWith("@import.invalid")
    expect(await userEmail(orgId, by.get("from gone")!)).toEndWith("@import.invalid")
  })

  test("a re-run after a placeholder person gained an account uses the real user for new rows only", async () => {
    const { orgId, slug } = await freshOrg()
    const tag = crypto.randomUUID().slice(0, 8)
    const email = `dana-${tag}@fabrikam.example`
    const slackUsers = [{ id: "UDANA", name: "dana", profile: { real_name: "Dana", email } }]
    const first = writeExport(
      slackUsers,
      [{ user: "UDANA", text: "before account", ts: "1735689600.000100" }],
      {},
    )
    const r1 = await runSlackImport({
      exportDir: first.dir,
      orgSlug: slug,
      userMapPath: first.userMapPath,
      skipFiles: true,
    })
    expect(r1.report.matchedByEmail).toBe(0)
    const placeholder = (await authorsByText(orgId)).get("before account")!
    expect(await userEmail(orgId, placeholder)).toEndWith("@import.invalid")

    const dana = await addUser(orgId, email, "Dana")
    const second = writeExport(
      slackUsers,
      [
        { user: "UDANA", text: "before account", ts: "1735689600.000100" },
        { user: "UDANA", text: "after account", ts: "1735689700.000100" },
      ],
      {},
    )
    const r2 = await runSlackImport({
      exportDir: second.dir,
      orgSlug: slug,
      userMapPath: second.userMapPath,
      skipFiles: true,
    })
    expect(r2.exitCode).toBe(0)
    expect(r2.report.matchedByEmail).toBe(1)
    expect(r2.report.placeholdersCreated).toBe(0)
    expect(r2.report.totalMessagesImported).toBe(1)
    expect(r2.report.totalMessagesAlreadyImported).toBe(1)
    const by = await authorsByText(orgId)
    expect(by.get("after account")).toBe(dana)
    // History is not rewritten here; merging the placeholder is a separate step.
    expect(by.get("before account")).toBe(placeholder)
  })

  test("throughput: a 2000-message channel imports well under 100 ms per message", async () => {
    const { orgId, slug } = await freshOrg()
    const tag = crypto.randomUUID().slice(0, 8)
    const people = Array.from({ length: 10 }, (_, i) => ({
      id: `U${i}`,
      name: `p${i}`,
      profile: { real_name: `P ${i}`, email: `p${i}-${tag}@fabrikam.example` },
    }))
    for (const p of people.slice(0, 5)) await addUser(orgId, p.profile.email, p.profile.real_name)
    const posts = Array.from({ length: 2000 }, (_, i) => ({
      user: `U${i % 10}`,
      text: `message ${i} `.repeat(8),
      ts: `${1735689600 + i}.000100`,
    }))
    const exp = writeExport(people, posts, {})
    const t0 = performance.now()
    const r = await runSlackImport({
      exportDir: exp.dir,
      orgSlug: slug,
      userMapPath: exp.userMapPath,
      skipFiles: true,
    })
    const msPerMessage = (performance.now() - t0) / posts.length
    process.stderr.write(`slack import: ${msPerMessage.toFixed(2)} ms/message\n`)
    expect(r.exitCode).toBe(0)
    expect(r.report.totalMessagesImported).toBe(2000)
    expect(r.report.matchedByEmail).toBe(5)
    expect(msPerMessage).toBeLessThan(100)
  })
})
