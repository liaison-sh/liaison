// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T47, the standing half of the remnant audit.
//
// The chat dock, the agent pages and the one conversation model replaced the
// right rail panel, the per-session chat and the flat artifact screens. The
// audit removed every trace of the old vocabulary; this test is what keeps it
// removed. A name below reappearing in apps/web's SHIPPED CODE fails here, so
// a future agent reading this tree is never taught a surface that does not
// exist.
//
// COMMENTS AND DOC BLOCKS ARE EXEMPT, deliberately: documenting what retired
// and why is the opposite of the defect, and half the files in this tree carry
// exactly that note. Only executable text is scanned, the same rule
// personal-dm-store.test.ts's `agent_chat` sweep uses.
//
// Its api twin is apps/api/src/tests/retired-vocabulary.test.ts. This half
// runs under the `web-unit` suite (vitest globs apps/web/src); the twin is
// named explicitly in `api-guards` in scripts/test-run.ts.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = resolve(__dirname, "..")

/**
 * The retired vocabulary. Every entry names a thing that no longer exists:
 * the panel and its parts, the panel's private chat roster and per-session
 * chat, the seeding handshake that opened it, and the discussion panel.
 */
const RETIRED_NAMES = [
  // The panel and its components.
  "AgentPanel",
  "AgentInputBar",
  "AgentMessageList",
  "ChatSwitcher",
  "AgentChatTab",
  "agent-panel-store",
  "AgentPanelContext",
  "useAgentPanel",
  "openAgentPanel",
  "toggleAgentPanel",
  "agentPanelOpen",
  "data-agent-panel-open",
  // The panel's own chat model: a chat per session, created and switched.
  "activeAgentChatId",
  "createAgentChat",
  "agent-chat-store",
  "createAgentStream",
  // The seeding handshake that opened the panel with a prepared message.
  "requestPanelChatWithSeed",
  "panelChatSeedRequest",
  "setPendingSkillPreface",
  "consumePendingSkillPreface",
  // The per-entity discussion panel (P4c-T12, DV5). Discussing an entity is a
  // message in the viewer's personal DM now.
  "openDiscussionPanel",
  "getDiscussionContext",
  "restoreDiscussionForTab",
  "promoteToThread",
] as const

/**
 * Lines that keep a retired name ON PURPOSE, each with the reason. A file is
 * exempt for ONE name, never wholesale, so a second remnant in an exempt file
 * still fails.
 */
const EXCEPTIONS: Array<{ file: string; name: string; why: string }> = [
  {
    file: "src/modules/shell/panel-store.ts",
    name: "agentPanelOpen",
    why: "LEGACY_STORAGE_KEY: reads the localStorage key an older build wrote so a person's own preference survives the rename. Never written. Removal date: one release after the chat dock ships.",
  },
  {
    file: "src/modules/shell/panel-store.test.ts",
    name: "agentPanelOpen",
    why: "proves the legacy key above is still read, so the migration cannot rot silently. Retires with the key.",
  },
  {
    file: "src/lib/storage.test.ts",
    name: "agentPanelOpen",
    why: "the session-teardown storage sweep uses the legacy key as its fixture, proving teardown clears keys this app no longer writes. Retires with the key.",
  },
  {
    file: "src/lib/panel-retired-sweep.test.ts",
    name: "AgentPanel",
    why: "the P4c-T17 import guard names the retired modules because they are its own subject matter; a sweep that cannot say what it forbids cannot forbid it",
  },
  {
    file: "src/lib/panel-retired-sweep.test.ts",
    name: "AgentInputBar",
    why: "same as AgentPanel above: the T17 import guard's own subject matter",
  },
  {
    file: "src/lib/panel-retired-sweep.test.ts",
    name: "AgentMessageList",
    why: "same as AgentPanel above: the T17 import guard's own subject matter",
  },
  {
    file: "src/lib/panel-retired-sweep.test.ts",
    name: "ChatSwitcher",
    why: "same as AgentPanel above: the T17 import guard's own subject matter",
  },
]

/** Directories that hold generated output or recorded runs, not source. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "migrations",
  "logs",
  "test-results",
  "playwright-report",
  "coverage",
  "__snapshots__",
  "ios",
  "android",
  "target",
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.endsWith("-snapshots")) continue
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.(tsx?|jsx?)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue
    out.push(full)
  }
  return out
}

/**
 * Executable text only. A line comment, a block comment body and a jsdoc line
 * are blanked in place so the line numbers survive and a retirement NOTE never
 * reads as a retirement.
 */
function strippedOfComments(source: string): string {
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

interface Hit {
  file: string
  name: string
  line: number
}

function sweep(): Hit[] {
  const hits: Hit[] = []
  for (const abs of sourceFiles(SRC)) {
    const rel = `src/${relative(SRC, abs)}`
    // This file IS the list; a guard cannot name what it forbids without
    // tripping over itself.
    if (rel === "src/lib/retired-vocabulary.test.ts") continue
    const lines = strippedOfComments(readFileSync(abs, "utf8")).split("\n")
    for (const name of RETIRED_NAMES) {
      if (EXCEPTIONS.some((e) => e.file === rel && e.name === name)) continue
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(name)) hits.push({ file: rel, name, line: i + 1 })
      }
    }
  }
  return hits
}

describe("the retired vocabulary stays retired (apps/web)", () => {
  it("no shipped or test source under apps/web/src names a retired concept", () => {
    const hits = sweep().map((h) => `${h.file}:${h.line}: ${h.name}`)
    expect(hits).toEqual([])
  })

  it("the sweep can see the tree it claims to walk", () => {
    const files = sourceFiles(SRC)
    expect(files.length).toBeGreaterThan(400)
    expect(
      files.some((f) => f.endsWith("/modules/shell/PanelContext.tsx")),
      "the renamed panel context must be inside the walked tree",
    ).toBe(true)
    expect(
      files.some((f) => f.endsWith("/modules/shell/dock-store.ts")),
      "the dock store must be inside the walked tree",
    ).toBe(true)
  })

  it("the sweep would see a planted name (it is not vacuous)", () => {
    const planted = strippedOfComments(
      ["// ChatSwitcher in a comment is fine", "const x = createAgentChat()"].join("\n"),
    )
    expect(planted.includes("ChatSwitcher"), "a comment must not count as a hit").toBe(false)
    expect(planted.includes("createAgentChat"), "executable text must count as a hit").toBe(true)
  })

  it("every exception carries a reason", () => {
    for (const e of EXCEPTIONS) {
      expect(e.why.length, `${e.file} / ${e.name} needs a reason`).toBeGreaterThan(20)
    }
  })
})
