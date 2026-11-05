// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S9, A16: every live event about a message says which reply thread it belongs
// to, so a client can route it to the open panel and recompute the root's
// summary without a refetch: message create (with alsoInChannel and the
// followers), update, delete, and reaction add/remove.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  call,
  post,
  queuedEvent,
  type ReplyFixture,
  setupReplyFixture,
} from "./__fixtures__/reply-thread-fixture"

let f: ReplyFixture
let root: string

type Data = Record<string, unknown>

describe("reply-thread fields on live events (S9, A16)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    root = (await post(f.alice, f.room, { content: "root" })).body.data.id
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("message:create carries replyRootId, alsoInChannel and the followers", async () => {
    const reply = (await post(f.bob, f.room, { content: "reply", replyRootId: root })).body.data.id
    const data = (await queuedEvent(f.orgId, "message", "create", reply)).data as Data
    expect(data.replyRootId).toBe(root)
    expect(data.alsoInChannel).toBe(false)
    expect((data.followerIds as string[]).sort()).toEqual([f.alice.userId, f.bob.userId].sort())

    const flagged = (
      await post(f.bob, f.room, { content: "loud", replyRootId: root, alsoSendToChannel: true })
    ).body.data.id
    expect(
      ((await queuedEvent(f.orgId, "message", "create", flagged)).data as Data).alsoInChannel,
    ).toBe(true)

    const plain = (await post(f.bob, f.room, { content: "channel" })).body.data.id
    const plainData = (await queuedEvent(f.orgId, "message", "create", plain)).data as Data
    expect(plainData.replyRootId).toBeNull()
    expect(plainData.alsoInChannel).toBe(false)
  })

  it("message:update, message:delete and reaction events carry replyRootId", async () => {
    const reply = (await post(f.bob, f.room, { content: "to edit", replyRootId: root })).body.data
      .id

    expect(
      (await call(f.bob, "PATCH", `/threads/${f.room}/messages/${reply}`, { content: "edited" }))
        .status,
    ).toBe(200)
    expect(
      ((await queuedEvent(f.orgId, "message", "update", reply)).data as Data).replyRootId,
    ).toBe(root)

    expect(
      (
        await call(f.alice, "POST", `/threads/${f.room}/messages/${reply}/reactions`, {
          emoji: "👍",
        })
      ).status,
    ).toBe(200)
    expect(((await queuedEvent(f.orgId, "reaction", "add", reply)).data as Data).replyRootId).toBe(
      root,
    )
    expect(
      (
        await call(
          f.alice,
          "DELETE",
          `/threads/${f.room}/messages/${reply}/reactions/${encodeURIComponent("👍")}`,
        )
      ).status,
    ).toBe(200)
    expect(
      ((await queuedEvent(f.orgId, "reaction", "remove", reply)).data as Data).replyRootId,
    ).toBe(root)

    expect((await call(f.bob, "DELETE", `/threads/${f.room}/messages/${reply}`)).status).toBe(200)
    expect(
      ((await queuedEvent(f.orgId, "message", "delete", reply)).data as Data).replyRootId,
    ).toBe(root)
  })
})
