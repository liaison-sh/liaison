// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  messageReactions,
  messages,
  threadParticipants,
  threadReferences,
  threads,
  userThreadState,
} from "~/db/schema/kernel"

describe("thread schema tables", () => {
  it("exports threads table with correct columns", () => {
    const cols = Object.keys(threads)
    expect(cols).toContain("id")
    expect(cols).toContain("orgId")
    expect(cols).toContain("handle")
    expect(cols).toContain("title")
    expect(cols).toContain("isPinned")
    expect(cols).toContain("createdFrom")
    expect(cols).toContain("createdBy")
    expect(cols).toContain("createdAt")
    expect(cols).toContain("updatedAt")
  })

  it("exports threadParticipants table with correct columns", () => {
    const cols = Object.keys(threadParticipants)
    expect(cols).toContain("id")
    expect(cols).toContain("threadId")
    expect(cols).toContain("userId")
    expect(cols).toContain("role")
    expect(cols).toContain("createdAt")
  })

  it("exports messages table with correct columns", () => {
    const cols = Object.keys(messages)
    expect(cols).toContain("id")
    expect(cols).toContain("threadId")
    expect(cols).toContain("orgId")
    expect(cols).toContain("authorId")
    expect(cols).toContain("authorType")
    expect(cols).toContain("content")
    expect(cols).toContain("mentions")
    expect(cols).toContain("editedAt")
    expect(cols).toContain("deletedAt")
    expect(cols).toContain("createdAt")
  })

  it("exports messageReactions table with correct columns", () => {
    const cols = Object.keys(messageReactions)
    expect(cols).toContain("id")
    expect(cols).toContain("messageId")
    expect(cols).toContain("userId")
    expect(cols).toContain("emoji")
    expect(cols).toContain("createdAt")
  })

  it("exports threadReferences table with correct columns", () => {
    const cols = Object.keys(threadReferences)
    expect(cols).toContain("id")
    expect(cols).toContain("threadId")
    expect(cols).toContain("app")
    expect(cols).toContain("entityType")
    expect(cols).toContain("entityId")
    expect(cols).toContain("addedBy")
    expect(cols).toContain("createdAt")
  })

  it("exports userThreadState table with correct columns", () => {
    const cols = Object.keys(userThreadState)
    expect(cols).toContain("userId")
    expect(cols).toContain("threadId")
    expect(cols).toContain("isArchived")
    expect(cols).toContain("isMuted")
    expect(cols).toContain("lastReadMessageId")
    expect(cols).toContain("lastReadAt")
  })
})
