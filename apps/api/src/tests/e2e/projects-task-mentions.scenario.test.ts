// SPDX-License-Identifier: FSL-1.1-ALv2
// An @mention in a task comment notifies the mentioned member, end to end
// through the API: a project and a task are created over REST, a comment
// naming a teammate is posted on the task's discussion thread, and the
// mentioned teammate gets one `mention` attention row (the row that becomes
// their notification). The comment author does not.
//
// Editing a comment does NOT notify again. The mention translation listens to
// `message:create` only (modules/attention/kernel-translations.ts); the edit
// path (modules/threads/message.ts editMessage) re-parses the mentions into the
// message row and emits `message:update`, which no attention rule maps. So a
// person ADDED to a comment by an edit is not pinged, and the person already
// mentioned keeps their single row. This test pins that behaviour: change it
// here, deliberately, if edits should ever notify.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { ks, pollUntil } from "./helpers/approvals"
import { setupScenario, teardownScenario } from "./setup"

const MEMBER_SCOPES = [
  "kernel:threads:read",
  "kernel:threads:write",
  "kernel:users:read",
  "projects:projects:read",
  "projects:tasks:read",
  "projects:tasks:write",
]

describe("Projects task comment mentions", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let kernel: string

  beforeAll(async () => {
    const result = await setupScenario({ org: { name: "Task Mentions Org" } })
    env = result.env
    world = result.world
    url = env.serverUrl
    kernel = ks(env)
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  async function mentionRows(userId: string): Promise<Array<{ entity_id: string }>> {
    return (await env.db.sql.unsafe(
      `SELECT entity_id FROM ${kernel}.attention_events
       WHERE user_id = $1 AND kind = 'mention' ORDER BY created_at`,
      [userId],
    )) as unknown as Array<{ entity_id: string }>
  }

  async function waitForMention(userId: string): Promise<Array<{ entity_id: string }>> {
    return pollUntil(
      async () => {
        const rows = await mentionRows(userId)
        return rows.length > 0 ? rows : null
      },
      20_000,
      250,
    )
  }

  it("a mention in a task comment creates the mention row; an edit does not notify again", async () => {
    const [author, mentioned, addedByEdit, sentinel] = await world.addUsers([
      { name: "Mention Author", scopes: MEMBER_SCOPES },
      { name: "Mentioned Member", scopes: MEMBER_SCOPES },
      { name: "Added By Edit", scopes: MEMBER_SCOPES },
      { name: "Sentinel Member", scopes: MEMBER_SCOPES },
    ])

    const project = await api(url, "/api/projects", {
      token: world.admin.token,
      body: { name: "Mentions board" },
    })
    expect(project.status).toBe(200)
    const projectId: string = project.body.data.id

    const task = await api(url, `/api/projects/${projectId}/tasks`, {
      token: author.token,
      body: { title: "Check the calibration" },
    })
    expect(task.status).toBe(200)
    const taskId: string = task.body.data.id

    // Reading the task seats its reader on the discussion (as the task page does).
    const read = await api(url, `/api/projects/${projectId}/tasks/${taskId}`, {
      token: author.token,
    })
    expect(read.status).toBe(200)
    const threadId: string = read.body.data.threadId

    const posted = await api(url, `/api/threads/${threadId}/messages`, {
      token: author.token,
      body: { content: `@[Mentioned Member](user:${mentioned.id}) can you look at this?` },
    })
    expect(posted.status).toBe(200)
    const messageId: string = posted.body.data.id

    const rows = await waitForMention(mentioned.id)
    expect(rows).toHaveLength(1)
    expect([threadId, messageId]).toContain(rows[0]!.entity_id)
    expect(await mentionRows(author.id)).toHaveLength(0)

    // The edit adds a second person and keeps the first.
    const edited = await api(url, `/api/threads/${threadId}/messages/${messageId}`, {
      method: "PATCH",
      token: author.token,
      body: {
        content: `@[Mentioned Member](user:${mentioned.id}) and @[Added By Edit](user:${addedByEdit.id}), can you look at this?`,
      },
    })
    expect(edited.status).toBe(200)

    // A later new comment proves the pipeline has handled everything before it.
    const after = await api(url, `/api/threads/${threadId}/messages`, {
      token: author.token,
      body: { content: `@[Sentinel Member](user:${sentinel.id}) for the record` },
    })
    expect(after.status).toBe(200)
    await waitForMention(sentinel.id)

    expect(await mentionRows(addedByEdit.id)).toHaveLength(0)
    expect(await mentionRows(mentioned.id)).toHaveLength(1)
  }, 60_000)
})
