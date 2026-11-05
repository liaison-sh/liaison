// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one-off application of the provenance decisions: the dry run plans by
// classification and writes nothing; --execute refuses a plan that drifted
// (a contact gained a reference) and otherwise deletes / makes private /
// privatizes through the services, backup first; restore puts it all back.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import {
  applyProvenance,
  parseProvenanceArgv,
  planProvenance,
  restoreProvenance,
  runProvenanceCli,
} from "~/cli/contacts/apply-provenance"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

const suffix = crypto.randomUUID().slice(0, 8)
const dir = mkdtempSync(path.join(tmpdir(), "provenance-"))
let orgId: string
let avery: string
let stephanie: string
let other: string
let mailbox: string
const c: Record<string, string> = {}

async function one<T>(q: ReturnType<typeof drizzleSql>): Promise<T> {
  return extractRows<T>(await db.execute(q))[0] as T
}

async function contact(key: string, createdBy: string | null): Promise<void> {
  c[key] = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO kernel.contacts (org_id, handle, email, name, created_by, owner_user_id)
      VALUES (${orgId}, ${`@pv-${key}-${suffix}`}, ${`${key}-${suffix}@x.example`}, ${key},
              ${createdBy}, ${createdBy === avery || createdBy === other ? createdBy : null})
      RETURNING id`)
  ).id
}

async function state(key: string) {
  return one<{ n: number; access: string | null; owner: string | null }>(drizzleSql`
    SELECT count(*)::int AS n, max(org_access) AS access, max(owner_user_id::text) AS owner
      FROM kernel.contacts WHERE id = ${c[key]}::uuid`)
}

const decisions = () => ({ orgId, deleteUnusedCreatedBy: avery, orphansTo: avery })

beforeAll(async () => {
  orgId = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Provenance', ${`provenance-${suffix}`}) RETURNING id`)
  ).id
  const users = extractRows<{ id: string; name: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`m-${suffix}@x.example`}, 'M', 'active', 'h'),
             (gen_random_uuid(), ${orgId}, ${`s-${suffix}@x.example`}, 'S', 'active', 'h'),
             (gen_random_uuid(), ${orgId}, ${`o-${suffix}@x.example`}, 'O', 'active', 'h')
      RETURNING id, name`),
  )
  avery = users.find((u) => u.name === "M")!.id
  stephanie = users.find((u) => u.name === "S")!.id
  other = users.find((u) => u.name === "O")!.id
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  await ensureAppsForOrg(orgId)
  mailbox = (
    await one<{ id: string }>(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status, created_at)
      VALUES (${orgId}, gen_random_uuid(), 'user', ${stephanie}, 'gmail', ${`box-${suffix}@x.example`},
              'active', now() - interval '1 day')
      RETURNING id`)
  ).id
  // Stéphanie's mailbox senders, created by the sync.
  for (const key of ["s1", "s2"]) {
    await contact(key, null)
    const email = `${key}-${suffix}@x.example`
    const conv = await one<{ id: string }>(drizzleSql`
      INSERT INTO app_mail.conversations
        (org_id, account_id, owner_type, external_thread_id, status, from_email, contact_id, message_count)
      VALUES (${orgId}, ${mailbox}, 'user', ${`t-${key}-${suffix}`}, 'open', ${email}, ${c[key]}, 1)
      RETURNING id`)
    await db.execute(drizzleSql`
      INSERT INTO app_mail.messages (org_id, conversation_id, account_id, external_message_id, from_address, direction)
      VALUES (${orgId}, ${conv.id}, ${mailbox}, ${`<${key}-${suffix}@x>`}, ${JSON.stringify({ email })}::jsonb, 'inbound')`)
  }
  await contact("notif1", avery) // notification sender recorded under Avery: deleted
  await contact("notif2", avery)
  await contact("used", avery) // a ticket uses it: kept
  await db.execute(drizzleSql`
    INSERT INTO app_tickets.tickets
      (org_id, handle, subject, status, priority, channel, reply_token, sla_target_seconds, contact_id)
    VALUES (${orgId}, ${`T-${suffix}`}, 's', 'open', 'normal', 'manual', ${`rt-${suffix}`}, 3600, ${c.used})`)
  await contact("byother", other) // another person's, unused: not ours to delete
  await contact("orphan1", crypto.randomUUID()) // creator gone
  await contact("orphan2", crypto.randomUUID())
}, 120_000)

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
})

describe("contacts apply-provenance", () => {
  it("demands the decisions, and a reviewed plan and a backup to execute", () => {
    const org = crypto.randomUUID()
    const u = crypto.randomUUID()
    const base = ["--org", org, "--delete-unused-created-by", u, "--orphans-to", u]
    expect(parseProvenanceArgv("apply", base)).toMatchObject({ ok: true, args: { execute: false } })
    expect(parseProvenanceArgv("apply", [...base, "--execute", "--backup", "/x"]).ok).toBe(false)
    expect(parseProvenanceArgv("apply", ["--org", org]).ok).toBe(false)
    expect(parseProvenanceArgv("restore", ["--org", org]).ok).toBe(false)
  })

  it("the dry run plans by classification and writes nothing", async () => {
    const plan = await planProvenance(decisions())
    expect(plan.counts).toEqual({ delete: 2, orphans: 2, privatize: 2 })
    expect(plan.delete).toEqual([c.notif1, c.notif2].sort())
    expect(plan.orphans).toEqual([c.orphan1, c.orphan2].sort())
    expect(plan.privatize).toEqual(
      [c.s1, c.s2].sort().map((id) => ({ id, ownerUserId: stephanie })),
    )
    expect(await state("notif1")).toMatchObject({ n: 1, access: "editor" })
  })

  it("refuses a plan that drifted: a contact that gained a reference stops the run", async () => {
    const plan = await planProvenance(decisions())
    const ticket = await one<{ id: string }>(drizzleSql`
      INSERT INTO app_tickets.tickets
        (org_id, handle, subject, status, priority, channel, reply_token, sla_target_seconds, contact_id)
      VALUES (${orgId}, ${`T2-${suffix}`}, 's', 'open', 'normal', 'manual', ${`rt2-${suffix}`}, 3600, ${c.orphan1})
      RETURNING id`)
    const backup = path.join(dir, "drift.json")
    await expect(
      applyProvenance({ ...decisions(), actorId: avery, reviewedPlan: plan, backupPath: backup }),
    ).rejects.toThrow(/plan changed/)
    expect(existsSync(backup)).toBe(false)
    expect(await state("notif1")).toMatchObject({ n: 1 })
    await db.execute(drizzleSql`DELETE FROM app_tickets.tickets WHERE id = ${ticket.id}::uuid`)
  })

  it("executes through the services, backup first; restore puts everything back", async () => {
    const planFile = path.join(dir, "plan.json")
    expect(
      await runProvenanceCli(
        "apply",
        [
          "--org",
          orgId,
          "--delete-unused-created-by",
          avery,
          "--orphans-to",
          avery,
          "--plan-out",
          planFile,
        ],
        { write: () => {}, writeErr: () => {} },
      ),
    ).toBe(0)
    expect(statSync(planFile).mode & 0o777).toBe(0o600)
    const backup = path.join(dir, "backup.json")
    expect(
      await runProvenanceCli(
        "apply",
        [
          "--org",
          orgId,
          "--delete-unused-created-by",
          avery,
          "--orphans-to",
          avery,
          "--actor",
          avery,
          "--execute",
          "--plan",
          planFile,
          "--backup",
          backup,
        ],
        { write: () => {}, writeErr: () => {} },
      ),
    ).toBe(0)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(backup, "utf8")).deleted).toHaveLength(2)

    expect((await state("notif1")).n).toBe(0)
    expect((await state("notif2")).n).toBe(0)
    expect(await state("orphan1")).toMatchObject({ access: "none", owner: avery })
    expect(await state("s1")).toMatchObject({ access: "none", owner: stephanie })
    // Untouched: used, and another person's.
    expect(await state("used")).toMatchObject({ n: 1, access: "editor" })
    expect(await state("byother")).toMatchObject({ n: 1, access: "editor" })
    // Through the services: delete and share events, the search ACL.
    const events = await one<{ del: number; share: number }>(drizzleSql`
      SELECT count(*) FILTER (WHERE payload->>'action' = 'delete')::int AS del,
             count(*) FILTER (WHERE payload->>'action' = 'share')::int AS share
        FROM kernel.pending_events
       WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'contact'`)
    expect(events).toEqual({ del: 2, share: 4 })
    const acl = await one<{ acl: string[] }>(
      drizzleSql`SELECT acl_user_ids AS acl FROM kernel.contacts WHERE id = ${c.s1}::uuid`,
    )
    expect(acl.acl).toEqual([stephanie])
    // A second run into the same backup file is refused.
    await expect(
      applyProvenance({
        ...decisions(),
        actorId: avery,
        reviewedPlan: JSON.parse(readFileSync(planFile, "utf8")),
        backupPath: backup,
      }),
    ).rejects.toThrow(/already exists/)

    const restored = await restoreProvenance(orgId, backup)
    expect(restored).toEqual({ restored: 2, reverted: 4, skipped: 0 })
    expect(await state("notif1")).toMatchObject({ n: 1, access: "editor", owner: avery })
    expect(await state("orphan1")).toMatchObject({ access: "editor", owner: null })
    expect(await state("s1")).toMatchObject({ access: "editor", owner: null })
  })
})
