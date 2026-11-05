// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  fileToRow,
  listDirectory,
  pathForRow,
  resolvePath,
  rowToFile,
} from "~/modules/agent/memory/memory-tree"

const ROW = {
  type: "project",
  name: "q3-launch",
  description: "The Q3 launch plan",
  content: "Ship on the 14th.\nNico owns the carrier switch.",
  requiredScopes: ["kernel:threads:read", "shopify:orders:read"],
  updatedAt: new Date("2026-09-12T08:30:00.000Z"),
  sourceThreadId: null,
  sourceMessageId: null,
  supersedesId: null,
}

describe("memory tree file mapping", () => {
  it("rowToFile renders frontmatter from the columns and the content as the body", () => {
    const file = rowToFile(ROW)
    expect(file.path).toBe("project/q3-launch.md")
    expect(file.body.startsWith("---\n")).toBe(true)
    expect(file.body).toContain('requiredScopes: ["kernel:threads:read","shopify:orders:read"]')
    expect(file.body.endsWith(ROW.content)).toBe(true)
  })

  it("fileToRow parses frontmatter back into the columns and never trusts a body claim", () => {
    const body = [
      "---",
      "name: q3-launch",
      "description: The Q3 launch plan",
      "type: project",
      "modified: 2026-09-12",
      'requiredScopes: ["kernel:threads:read"]',
      "sources: []",
      "supersedes: null",
      "---",
      "",
      'The body claims requiredScopes: ["*"] and must be ignored.',
    ].join("\n")
    const parsed = fileToRow("project/q3-launch.md", body)
    expect(parsed.requiredScopes).toEqual(["kernel:threads:read"])
    expect(parsed.type).toBe("project")
    expect(parsed.name).toBe("q3-launch")
    expect(parsed.content).toContain('requiredScopes: ["*"]')
  })

  it("resolvePath refuses another agent's root", () => {
    expect(() => resolvePath("logistics", "/memories/support/user/x.md")).toThrow()
    expect(resolvePath("logistics", "/memories/logistics/user/x.md")).toBe("user/x.md")
    expect(resolvePath("logistics", "user/x.md")).toBe("user/x.md")
  })

  it("pathForRow maps the reserved index row to MEMORY.md", () => {
    expect(pathForRow({ type: "_index", name: "_index" })).toBe("MEMORY.md")
    expect(pathForRow({ type: "user", name: "tone" })).toBe("user/tone.md")
  })

  it("listDirectory lists the immediate children of a folder", () => {
    const paths = ["MEMORY.md", "user/tone.md", "project/q3-launch.md", "project/dhl.md"]
    expect(listDirectory("logistics", "project", paths)).toEqual([
      "project/dhl.md",
      "project/q3-launch.md",
    ])
  })
})
