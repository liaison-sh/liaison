// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import {
  flattenMentionGroups,
  groupMentionResults,
  mentionKind,
  mentionKindLabelKey,
  primaryKinds,
  SECONDARY_KIND_CAP,
} from "~/lib/mention-groups"
import type { MentionResult } from "~/lib/mention-service"

function result(over: Partial<MentionResult> & Pick<MentionResult, "id" | "label">): MentionResult {
  return { type: "entity", ...over }
}

describe("mentionKind", () => {
  it("reads the entity type for an entity row", () => {
    expect(mentionKind(result({ id: "1", label: "Task A", entityType: "task" }))).toBe("task")
  })

  it("falls back to the row's own type when it isn't an entity", () => {
    expect(mentionKind(result({ id: "1", label: "Alice", type: "user" }))).toBe("user")
  })
})

describe("primaryKinds", () => {
  it("leads @ with user then agent", () => {
    expect(primaryKinds("@")).toEqual(["user", "agent"])
  })

  it("leads # with thread", () => {
    expect(primaryKinds("#")).toEqual(["thread"])
  })
})

describe("mentionKindLabelKey", () => {
  it("falls back to kindOther for an unrecognized kind", () => {
    expect(mentionKindLabelKey("something-unknown")).toBe("kernel.mentions.kindOther")
  })

  it("resolves a known kind", () => {
    expect(mentionKindLabelKey("task")).toBe("kernel.mentions.kindTasks")
  })
})

describe("groupMentionResults", () => {
  it("puts the @ trigger's primary kinds (user, agent) before any secondary kind", () => {
    const results: MentionResult[] = [
      result({ id: "t1", label: "Ship it", type: "entity", entityType: "task" }),
      result({ id: "u1", label: "Alice", type: "user" }),
      result({ id: "a1", label: "Support Bot", type: "agent" }),
    ]
    const groups = groupMentionResults(results, "@")
    expect(groups.map((g) => g.kind)).toEqual(["user", "agent", "task"])
  })

  it("puts the # trigger's primary kind (thread) before any secondary kind", () => {
    const results: MentionResult[] = [
      result({ id: "t1", label: "Ship it", type: "entity", entityType: "task" }),
      result({ id: "c1", label: "general", type: "thread" }),
    ]
    const groups = groupMentionResults(results, "#")
    expect(groups.map((g) => g.kind)).toEqual(["thread", "task"])
  })

  it("caps a secondary kind at SECONDARY_KIND_CAP rows", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      result({ id: `t${i}`, label: `Task ${i}`, type: "entity", entityType: "task" }),
    )
    const groups = groupMentionResults(tasks, "@")
    expect(groups).toHaveLength(1)
    expect(groups[0]!.kind).toBe("task")
    expect(groups[0]!.items).toHaveLength(SECONDARY_KIND_CAP)
  })

  it("never caps a primary kind", () => {
    const users = Array.from({ length: 5 }, (_, i) =>
      result({ id: `u${i}`, label: `User ${i}`, type: "user" }),
    )
    const groups = groupMentionResults(users, "@")
    expect(groups[0]!.items).toHaveLength(5)
  })

  it("produces no empty group for a kind with no results", () => {
    const results: MentionResult[] = [result({ id: "u1", label: "Alice", type: "user" })]
    const groups = groupMentionResults(results, "@")
    expect(groups.some((g) => g.kind === "agent")).toBe(false)
    expect(groups.every((g) => g.items.length > 0)).toBe(true)
  })
})

describe("flattenMentionGroups", () => {
  it("returns rows in the same order the groups were built in", () => {
    const results: MentionResult[] = [
      result({ id: "t1", label: "Ship it", type: "entity", entityType: "task" }),
      result({ id: "u1", label: "Alice", type: "user" }),
      result({ id: "a1", label: "Support Bot", type: "agent" }),
    ]
    const groups = groupMentionResults(results, "@")
    expect(flattenMentionGroups(groups).map((r) => r.id)).toEqual(["u1", "a1", "t1"])
  })
})
