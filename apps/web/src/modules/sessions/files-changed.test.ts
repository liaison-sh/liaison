// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T07 (S8 files): the Files changed drawer's data, per file (shown relative
// to the session), from the Edit, MultiEdit and Write calls of the session.
import type { NodeSessionEvent } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import { filesChanged } from "./files-changed"

let seq = 0
function ev(
  type: NodeSessionEvent["type"],
  payload: Record<string, unknown>,
  over: Partial<NodeSessionEvent> = {},
): NodeSessionEvent {
  seq++
  return {
    seq,
    at: new Date(1_800_000_000_000 + seq).toISOString(),
    receivedAt: new Date(1_800_000_000_000 + seq).toISOString(),
    type,
    payload,
    ...over,
  }
}

const ctx = { sessionId: "s1", folderName: "my-repo" }

describe("filesChanged", () => {
  it("an Edit, a MultiEdit and a Write give per-file +/- counts and the Write is all added", () => {
    seq = 0
    const files = filesChanged(
      [
        ev("tool_call", {
          id: "toolu_1",
          name: "Edit",
          input: {
            file_path: "/Users/me/code/my-repo/README.md",
            old_string: "a\nb",
            new_string: "a\nB\nc",
          },
        }),
        ev("tool_call", {
          id: "toolu_2",
          name: "MultiEdit",
          input: {
            file_path: "/Users/me/code/my-repo/src/x.ts",
            edits: [
              { old_string: "one", new_string: "uno" },
              { old_string: "two\n", new_string: "" },
            ],
          },
        }),
        ev("tool_call", {
          id: "toolu_3",
          name: "Write",
          input: { file_path: "/Users/me/code/my-repo/new.txt", content: "l1\nl2\nl3" },
        }),
        ev("tool_call", {
          id: "toolu_4",
          name: "Edit",
          input: {
            file_path: "/Users/me/code/my-repo/README.md",
            old_string: "c",
            new_string: "C",
          },
        }),
        ...["toolu_1", "toolu_2", "toolu_3", "toolu_4"].map((id) =>
          ev("tool_result", { id, output: "ok" }),
        ),
      ],
      ctx,
    )
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["README.md", 3, 2],
      ["src/x.ts", 1, 3],
      ["new.txt", 3, 0],
    ])
    expect(files[0].hunks).toHaveLength(2)
    expect(files[2].hunks[0].every((l) => l.type === "add")).toBe(true)
    expect(files.every((f) => !f.path.startsWith("/"))).toBe(true)
  })

  it("a failed edit does not count, and a truncated one is marked cut", () => {
    seq = 0
    const files = filesChanged(
      [
        ev("tool_call", {
          id: "toolu_1",
          name: "Edit",
          input: { file_path: "/r/my-repo/a.ts", old_string: "x", new_string: "y" },
        }),
        ev("tool_result", { id: "toolu_1", isError: true, output: "denied" }),
        ev(
          "tool_call",
          {
            id: "toolu_2",
            name: "Write",
            input: { file_path: "/r/my-repo/b.ts", content: "big" },
          },
          { truncated: true, fullBytes: 900_000 },
        ),
        ev("tool_result", { id: "toolu_2", output: "ok" }),
      ],
      ctx,
    )
    expect(files.map((f) => [f.path, f.cut])).toEqual([["b.ts", true]])
  })

  it("a Write still waiting for the owner's permission, or denied, changed nothing; it counts once its result is in (walk D11)", () => {
    seq = 0
    const call = ev("tool_call", {
      id: "toolu_9",
      name: "Write",
      input: { file_path: "/r/my-repo/out.txt", content: "a\nb" },
    })
    const asked = ev("permission_request", {
      requestId: "r1",
      tool: "Write",
      input: { file_path: "/r/my-repo/out.txt" },
    })
    expect(filesChanged([call, asked], ctx)).toEqual([])
    const denied = ev("tool_result", {
      id: "toolu_9",
      isError: true,
      output: "Denied by the owner.",
    })
    expect(filesChanged([call, asked, denied], ctx)).toEqual([])
    const applied = ev("tool_result", { id: "toolu_9", output: "File created" })
    expect(filesChanged([call, asked, applied], ctx).map((f) => [f.path, f.added])).toEqual([
      ["out.txt", 2],
    ])
  })
})
