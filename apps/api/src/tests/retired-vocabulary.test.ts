// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T47, the api twin of apps/web/src/lib/retired-vocabulary.test.ts.
//
// The dock, the agent pages and the one conversation model are the design. The
// panel's private roster route (`/agent-chats`, `listAgentChats`) and its
// per-session chat are gone; the names below must not come back into the api
// tree, so a future agent reading it is never taught a surface that does not
// exist.
//
// A PURE SOURCE SCAN: it opens no database and reads no env, which is why it
// belongs to the `api-guards` suite rather than `unit` or `integration`.
//
// COMMENTS ARE EXEMPT, deliberately: documenting what retired and why is the
// opposite of the defect. Only executable text is scanned.
//
// NOT on this list, on purpose, each with its reason:
//   * `agent_chat` is the PERSISTED `kernel.threads.type` value of a DM with an
//     agent. Production rows carry it, the DM shape reads it and the Home list
//     filters on it. Renaming it is a data migration, not a rename.
//   * `/agent/chat` is the SSE TRANSPORT route. The panel it was written for is
//     gone, but the mailbox job-turn transport (T17) still posts to it, so it
//     stays with a dated note at its handler in modules/agent/routes.ts.

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const SRC = resolve(import.meta.dir, "..")

/** Names of api surfaces the chat dock retired. */
const RETIRED_NAMES = [
  // The panel's private chat roster: GET /api/agent-chats and its query.
  "agentChatRoutes",
  "agent-chat-routes",
  "listAgentChats",
  "ListAgentChatsParams",
  "/agent-chats",
  // The panel itself and its per-session chat model, never api-side again.
  "AgentPanel",
  "agent_panel",
  "createAgentChat",
  "activeAgentChatId",
  "ChatSwitcher",
  // The client-side sentinel the pre-agents build used in place of a real
  // agent id. Every thread carries a real `author_agent_id` now.
  "LIAISON_AGENT_ID",
] as const

/**
 * Lines that keep a retired name ON PURPOSE, each with the reason. An entry is
 * one file plus one name, never a whole file, so a second remnant in an exempt
 * file still fails.
 */
const EXCEPTIONS: Array<{ file: string; name: string; why: string }> = []

/** Directories that hold generated output or recorded runs, not source. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "migrations",
  "drizzle",
  "logs",
  "test-results",
  "coverage",
  "__snapshots__",
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue
    out.push(full)
  }
  return out
}

/** Executable text only, blanked in place so line numbers survive. */
export function strippedOfComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const t = line.trimStart()
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return ""
      const slash = line.indexOf("//")
      return slash >= 0 ? line.slice(0, slash) : line
    })
    .join("\n")
}

function sweep(): string[] {
  const hits: string[] = []
  for (const abs of sourceFiles(SRC)) {
    const rel = `src/${relative(SRC, abs)}`
    if (rel === "src/tests/retired-vocabulary.test.ts") continue
    const lines = strippedOfComments(readFileSync(abs, "utf8")).split("\n")
    for (const name of RETIRED_NAMES) {
      if (EXCEPTIONS.some((e) => e.file === rel && e.name === name)) continue
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(name)) hits.push(`${rel}:${i + 1}: ${name}`)
      }
    }
  }
  return hits
}

describe("the retired vocabulary stays retired (apps/api)", () => {
  test("no source under apps/api/src names a retired concept", () => {
    expect(sweep()).toEqual([])
  })

  test("the sweep can see the tree it claims to walk", () => {
    const files = sourceFiles(SRC)
    expect(files.length).toBeGreaterThan(400)
    expect(files.some((f) => f.endsWith("/modules/agent/routes.ts"))).toBe(true)
    expect(files.some((f) => f.endsWith("/modules/threads/thread.ts"))).toBe(true)
    expect(files.some((f) => f.endsWith("/modules/agent/context/context.ts"))).toBe(true)
  })

  test("the sweep would see a planted name (it is not vacuous)", () => {
    const planted = strippedOfComments(
      ["// listAgentChats in a comment is fine", "await listAgentChats(tx, params)"].join("\n"),
    )
    expect(planted.split("\n")[0].includes("listAgentChats")).toBe(false)
    expect(planted.split("\n")[1].includes("listAgentChats")).toBe(true)
  })

  test("the transport route and the persisted thread type are NOT swept", () => {
    // Both are live and deliberately absent from RETIRED_NAMES; if either were
    // added the tree would go red for the wrong reason.
    expect(RETIRED_NAMES as readonly string[]).not.toContain("agent_chat")
    expect(RETIRED_NAMES as readonly string[]).not.toContain("/agent/chat")
  })

  test("every exception carries a reason", () => {
    for (const e of EXCEPTIONS) {
      expect(e.why.length).toBeGreaterThan(20)
    }
  })
})
