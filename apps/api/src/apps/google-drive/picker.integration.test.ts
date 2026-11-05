// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Drive connected with drive.file only is in picked mode: the person's picks
// are saved on the connected account, a picked-items synced source is created
// once for that account, and the sync lists exactly what is picked (folders
// walked as far as Drive shows their children). Another member never sees or
// changes someone else's personal Drive account.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { createGoogleDriveAdapter } from "~/apps/google-drive/adapter"
import { DRIVE_READONLY_SCOPE, PICKED_ROOT_REF } from "~/apps/google-drive/drive-mode"
import {
  drivePickerState,
  loadPickedItems,
  pickerAccount,
  updatePickedItems,
} from "~/apps/google-drive/picker"
import {
  announcePicks,
  cardPickIds,
  createPickOrigin,
  DRIVE_PICKER_TURN_JOB,
  PICK_ORIGIN_RE,
} from "~/apps/google-drive/picker-announce"
import {
  createPickerTicket,
  drivePickerPage,
  drivePickerPageSave,
  pickerPageUrl,
} from "~/apps/google-drive/picker-page"
import { knowledgeActorFromContext } from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { handleDrivePicker } from "~/modules/agent/tools/setup-guide-tools"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"
const SCOPES = ["knowledge:documents:read"]

let orgId: string
let alice: string
let bob: string

async function user(name: string): Promise<string> {
  const [u] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name}-${Date.now()}@picker.test`}, ${name},
              'active', 'h', 1, 1)
      RETURNING id`),
  )
  return u!.id
}

async function driveAccount(owner: string, identifier: string, granted: string[]) {
  const [row] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
         status, created_by, updated_at, metadata)
      VALUES (${orgId}::uuid, 'google-drive', 'drive', 'user', ${owner}::uuid, 'oauth2',
              ${identifier}, 'active', ${owner}::uuid, now(),
              ${JSON.stringify({ grantedOAuthScopes: granted })}::jsonb)
      RETURNING id`),
  )
  return row!.id
}

function caller(userId: string) {
  return { orgId, userId, scopes: SCOPES }
}

function save(
  userId: string,
  accountId: string,
  change: { add: never[] | Item[]; remove: string[] },
) {
  return withRlsContext(
    { actorType: "user" as const, orgId, userId, scopes: SCOPES, dimensionGrants: {} },
    (tx) =>
      updatePickedItems(
        tx,
        caller(userId),
        knowledgeActorFromContext({ orgId, userId, scopes: SCOPES, dimensionGrants: {} }),
        accountId,
        change,
      ),
  )
}

type Item = { id: string; name: string; mimeType: string }
const DOC: Item = { id: "doc-aaaaaaaa", name: "Plan.docx", mimeType: "application/msword" }
const FOLDER: Item = {
  id: "folder-bbbbbbbb",
  name: "Projects",
  mimeType: "application/vnd.google-apps.folder",
}

beforeAll(async () => {
  await acquireTestLock()
  // The knowledge app's manifest columns (synced_sources.source_account) come
  // from its registration, not from the migrated template: register the apps
  // here so this file does not depend on an earlier file having done it.
  await createTestOrg()
  const [org] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'DrivePicker', ${`drive-picker-${Date.now()}`})
      RETURNING id`),
  )
  orgId = org!.id
  alice = await user("alice")
  bob = await user("bob")
})

afterAll(async () => {
  await releaseTestLock()
})

describe("picked mode", () => {
  it("reads the mode from the grant, saves picks, creates one source, lists the picks", async () => {
    const picked = await driveAccount(alice, "alice@gmail.com", ["openid", DRIVE_FILE])
    const full = await driveAccount(alice, "alice@acme.example", [DRIVE_READONLY_SCOPE, DRIVE_FILE])

    const state = await drivePickerState(caller(alice))
    const byId = new Map(state.accounts.map((a) => [a.id, a]))
    expect(byId.get(picked)?.mode).toBe("picked")
    expect(byId.get(full)?.mode).toBe("full")
    expect(byId.get(picked)?.picked).toEqual([])

    const first = await save(alice, picked, { add: [DOC, FOLDER], remove: [] })
    expect(first.picked.map((p) => p.id)).toEqual([DOC.id, FOLDER.id])
    const again = await save(alice, picked, { add: [], remove: [DOC.id] })
    expect(again.sourceId).toBe(first.sourceId)
    expect(again.picked.map((p) => p.id)).toEqual([FOLDER.id])

    const sources = extractRows<{
      folder_ref: string
      source_account: string
      owner_user_id: string
    }>(
      await db.execute(sql`SELECT folder_ref, source_account, owner_user_id
        FROM app_knowledge.synced_sources WHERE id = ${first.sourceId}::uuid`),
    )
    expect(sources[0]).toEqual({
      folder_ref: PICKED_ROOT_REF,
      source_account: "alice@gmail.com",
      owner_user_id: alice,
    })

    expect(await loadPickedItems(orgId, "alice@gmail.com", alice)).toEqual([FOLDER])
    const adapter = createGoogleDriveAdapter({
      getToken: async () => "t",
      fetchDrive: async () => ({ files: [] }),
      getPickedItems: () => loadPickedItems(orgId, "alice@gmail.com", alice),
    })
    const listing = await adapter.listFolder!(
      { folderRef: PICKED_ROOT_REF },
      knowledgeActorFromContext({ orgId, userId: alice, scopes: SCOPES, dimensionGrants: {} }),
    )
    expect(listing.items).toEqual([
      {
        kind: "folder",
        externalId: FOLDER.id,
        name: "Projects",
        parentExternalId: PICKED_ROOT_REF,
      },
    ])

    // The agent tool reports the picked account; the card shows only with the Picker set up.
    const tool = await handleDrivePicker({}, { orgId, userId: alice, scopes: SCOPES })
    const mine = tool.accounts.find((a) => a.accountId === picked)
    expect(mine).toMatchObject({
      mode: "picked",
      pickedCount: 1,
      picked: [{ name: "Projects", driveFileId: FOLDER.id }],
      notInKnowledge: [],
    })
    expect(tool.card).toBe(tool.pickerConfigured ? "shown" : "none")
  })

  it("a full-mode Drive gets no picker session and no picks", async () => {
    const full = await driveAccount(alice, "alice-full@acme.example", [DRIVE_READONLY_SCOPE])
    const pickerEnv = env as {
      GOOGLE_PICKER_API_KEY?: string
      GOOGLE_CLOUD_PROJECT_NUMBER?: string
    }
    const saved = [pickerEnv.GOOGLE_PICKER_API_KEY, pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER]
    pickerEnv.GOOGLE_PICKER_API_KEY = "picker-test-key"
    pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER = "123456789012"
    try {
      await expect(pickerAccount(caller(alice), full)).rejects.toMatchObject({
        code: "not_picked_mode",
      })
      await expect(save(alice, full, { add: [DOC], remove: [] })).rejects.toMatchObject({
        code: "not_picked_mode",
      })
    } finally {
      pickerEnv.GOOGLE_PICKER_API_KEY = saved[0]
      pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER = saved[1]
    }
  })

  it("the sync reads picks only from the account of the source's owner", async () => {
    const picked = await driveAccount(alice, "alice4@gmail.com", [DRIVE_FILE])
    await save(alice, picked, { add: [DOC], remove: [] })
    expect(await loadPickedItems(orgId, "ALICE4@gmail.com", alice)).toEqual([DOC])
    // The same Google account now held by bob: alice's source lists nothing.
    await db.execute(
      sql`UPDATE kernel.connected_accounts SET owner_id = ${bob}::uuid WHERE id = ${picked}::uuid`,
    )
    expect(await loadPickedItems(orgId, "alice4@gmail.com", alice)).toEqual([])
    expect(await loadPickedItems(orgId, "alice4@gmail.com", null)).toEqual([])
  })

  it("another member neither sees nor changes a personal Drive account", async () => {
    const picked = await driveAccount(alice, "alice2@gmail.com", [DRIVE_FILE])
    const state = await drivePickerState(caller(bob))
    expect(state.accounts.map((a) => a.id)).not.toContain(picked)
    await expect(save(bob, picked, { add: [DOC], remove: [] })).rejects.toThrow(/No Drive account/)
  })
})

describe("the one-time picker page", () => {
  const pickerEnv = env as { GOOGLE_PICKER_API_KEY?: string; GOOGLE_CLOUD_PROJECT_NUMBER?: string }
  const page = new Hono()
    .get("/api/drive-picker/:ticket", (c) => drivePickerPage(c))
    .post("/api/drive-picker/:ticket/items", (c) => drivePickerPageSave(c))

  it("renders once, refuses a reused or unknown link, and saves picks through the save ticket", async () => {
    const saved = [pickerEnv.GOOGLE_PICKER_API_KEY, pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER]
    pickerEnv.GOOGLE_PICKER_API_KEY = "picker-test-key"
    pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER = "123456789012"
    try {
      const accountId = await driveAccount(alice, "alice3@gmail.com", [DRIVE_FILE])
      const who = { orgId, userId: alice, scopes: SCOPES, dimensionGrants: {}, roles: [] }
      const ticket = await createPickerTicket({ ...who, accountId, identifier: "alice3@gmail.com" })
      expect(await pickerPageUrl(orgId, ticket)).toEndWith(`/api/drive-picker/${ticket}`)

      // The test account holds no token: the page says to reconnect, with its own policy.
      const first = await page.request(`/api/drive-picker/${ticket}`)
      expect(first.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
      // Google checks the Picker key against the referrer: origin only, never the ticket path.
      expect(first.headers.get("referrer-policy")).toBe("strict-origin")
      expect(await first.clone().text()).toContain('<meta name="referrer" content="strict-origin">')
      expect(await first.text()).toContain('data-testid="drive-picker-failed"')
      const reused = await page.request(`/api/drive-picker/${ticket}`)
      expect(reused.status).toBe(410)
      expect(await reused.text()).toContain('data-testid="drive-picker-expired"')

      // A ticket for an account reconnected with the whole Drive: no page, no token.
      const fullAccount = await driveAccount(alice, "alice5@acme.example", [DRIVE_READONLY_SCOPE])
      const fullTicket = await createPickerTicket({
        ...who,
        accountId: fullAccount,
        identifier: "alice5@acme.example",
      })
      const fullPage = await page.request(`/api/drive-picker/${fullTicket}`)
      expect(fullPage.status).toBe(410)
      expect(await fullPage.text()).not.toContain('id="cfg"')

      const unknown = await page.request(`/api/drive-picker/${ticket}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add: [DOC] }),
      })
      expect(unknown.status).toBe(410)

      // A rendered page holds a save-only ticket: posting picks saves them.
      const saveTicket = await createPickerTicket({
        ...who,
        accountId,
        identifier: "alice3@gmail.com",
      })
      await redis.set(
        `drive-picker:save:${saveTicket}`,
        JSON.stringify({ ...who, accountId, identifier: "alice3@gmail.com" }),
        "EX",
        60,
      )
      const ok = await page.request(`/api/drive-picker/${saveTicket}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add: [DOC] }),
      })
      expect(ok.status).toBe(200)
      expect(await loadPickedItems(orgId, "alice3@gmail.com", alice)).toEqual([DOC])
    } finally {
      pickerEnv.GOOGLE_PICKER_API_KEY = saved[0]
      pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER = saved[1]
    }
  })
})

describe("a pick made from the agent's card", () => {
  const XLSX: Item = {
    id: "gowin-xlsx-1",
    name: "Gowin Sample Request Form.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }
  const who = () => ({
    orgId,
    userId: alice,
    scopes: [...SCOPES, "google-drive:accounts:read"],
    dimensionGrants: {},
  })

  it("posts the line in the card's conversation and hands the turn to its agent", async () => {
    // The kernel job handlers are not registered in this file's process.
    registerJobWorker("kernel", DRIVE_PICKER_TURN_JOB, async () => {})
    const threadId = await minimal.thread(orgId, alice)
    const [agent] = extractRows<{ id: string }>(
      await db.execute(sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${orgId}::uuid, 'role', ${`@dp-${Date.now()}`}, 'Helper', '["*"]'::jsonb)
        RETURNING id`),
    )
    const origin = await createPickOrigin({ orgId, userId: alice, threadId, agentId: agent!.id })
    const result = await announcePicks(who(), origin, [XLSX])
    expect(result.messageId).not.toBeNull()
    expect(result.turnEnqueued).toBe(true)
    const [line] = extractRows<{ content: string; author_type: string; metadata: any }>(
      await db.execute(sql`SELECT content, author_type, metadata FROM kernel.messages
        WHERE id = ${result.messageId}::uuid`),
    )
    expect(line!.author_type).toBe("system")
    expect(line!.content).toContain("picked 1 item in Google Drive: Gowin Sample Request Form.xlsx")
    expect(line!.metadata).toMatchObject({
      type: "drive-picker-result",
      items: [XLSX],
      count: 1,
      origin,
      ids: [XLSX.id],
    })
    // The card lists what was picked through it, and only that.
    expect(await cardPickIds(who(), { origin, threadId })).toEqual([XLSX.id])
    const other = await createPickOrigin({ orgId, userId: alice, threadId, agentId: null })
    expect(await cardPickIds(who(), { origin: other, threadId })).toEqual([])
    expect(await cardPickIds({ orgId, userId: bob }, { origin, threadId })).toEqual([])
  })

  it("the card shown in a conversation carries an origin; without one, none", async () => {
    const pickerEnv = env as {
      GOOGLE_PICKER_API_KEY?: string
      GOOGLE_CLOUD_PROJECT_NUMBER?: string
    }
    const saved = [pickerEnv.GOOGLE_PICKER_API_KEY, pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER]
    pickerEnv.GOOGLE_PICKER_API_KEY = "picker-test-key"
    pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER = "123456789012"
    try {
      await driveAccount(alice, "alice6@gmail.com", [DRIVE_FILE])
      const threadId = await minimal.thread(orgId, alice)
      const inThread = await handleDrivePicker(
        {},
        { orgId, userId: alice, scopes: SCOPES, agentExecutionThreadId: threadId },
      )
      expect(inThread.card).toBe("shown")
      expect(inThread.origin).toMatch(PICK_ORIGIN_RE)
      expect(inThread.threadId).toBe(threadId)
      const elsewhere = await handleDrivePicker({}, { orgId, userId: alice, scopes: SCOPES })
      expect(elsewhere.origin).toBeUndefined()
    } finally {
      pickerEnv.GOOGLE_PICKER_API_KEY = saved[0]
      pickerEnv.GOOGLE_CLOUD_PROJECT_NUMBER = saved[1]
    }
  })

  it("announces nothing for a card shown to someone else, or an unknown origin", async () => {
    const threadId = await minimal.thread(orgId, bob)
    const bobs = await createPickOrigin({ orgId, userId: bob, threadId, agentId: null })
    expect(await announcePicks(who(), bobs, [XLSX])).toEqual({
      messageId: null,
      turnEnqueued: false,
    })
    expect(await announcePicks(who(), "x".repeat(40), [XLSX])).toEqual({
      messageId: null,
      turnEnqueued: false,
    })
  })
})
