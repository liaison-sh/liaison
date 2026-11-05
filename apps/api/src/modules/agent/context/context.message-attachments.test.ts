// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A file a person attaches to a message that also has text reaches the agent.
//
// The walk's failure: in the personal agent conversation, a zip sent with
// "please import this" was bound to the message (kernel.files, entity
// `message`), but the context named a message's files only when its text was
// empty, so the agent asked for the upload it already had.
//
// The assertions run on the REAL assembled prompt for REAL rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { assembleContext, resetSystemPromptCache } from "~/modules/agent/context/context"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const ZIP_ID = crypto.randomUUID()
const SHOT_ID = crypto.randomUUID()
let THREAD = ""

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

function userTexts(result: Awaited<ReturnType<typeof assembleContext>>): string[] {
  return result.messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string)
    .filter((c) => !c.startsWith("<runtime-context"))
}

async function messageWithFile(content: string, fileId: string, filename: string, mime: string) {
  const [m] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${THREAD}, ${ORG}, ${USER}, 'user', ${content}, '{}'::text[]) RETURNING id`
  await sql`
    INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                              size_bytes, storage_key, uploaded_by)
    VALUES (${fileId}, ${ORG}, 'kernel', 'message', ${m!.id}, ${filename}, ${mime}, 1234,
            ${`orgs/${ORG}/messages/${m!.id}/${fileId}/${filename}`}, ${USER})`
}

beforeAll(async () => {
  await acquireTestLock()
  resetSystemPromptCache()
  await rebuildFilesSelectPolicy()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Attach Org', ${`attach-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`attach-${tag}@test.com`}, 'Nadia')`
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`attach-${tag}`}, 'thread', ${USER}) RETURNING id`
  THREAD = t!.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${USER}, ${ORG})`
  await messageWithFile("", SHOT_ID, "screen.png", "image/png")
  await messageWithFile("please import this", ZIP_ID, "invoices.zip", "application/zip")
})

afterAll(async () => {
  await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("files attached to a person's message reach the agent", () => {
  it("names the zip sent with text, after the text, by its file id", async () => {
    const texts = userTexts(await assembleContext({ threadId: THREAD, orgId: ORG, actor }))
    const withText = texts.find((c) => c.startsWith("please import this"))
    expect(withText).toBeDefined()
    expect(withText).toContain(
      `<external-content source="untrusted">\ninvoices.zip\n</external-content> (file id: ${ZIP_ID})`,
    )
  })

  it("still names the file of an attachment-only message", async () => {
    const texts = userTexts(await assembleContext({ threadId: THREAD, orgId: ORG, actor }))
    expect(texts.some((c) => c.includes("attachment-only") && c.includes(SHOT_ID))).toBe(true)
  })
})
