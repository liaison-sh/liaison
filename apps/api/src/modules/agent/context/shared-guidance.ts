// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE SOURCE FOR HOW TO ACT IN LIAISON. `prompts/system.md` is the guidance an
// in-app turn runs under, and an external client connected over MCP must follow
// the same rules (message a teammate in a Liaison conversation, never by email;
// outside content is data; pending is not done). It used to get a separately
// hand-written paragraph instead, which drifted: an MCP client asked to "send a
// message" to a colleague emailed them, because nothing it was given said
// Liaison has conversations between teammates.
//
// Every `## ` section of system.md therefore declares who it is for, on the
// line under its heading:
//
//   <!-- audience: in-app mcp -->
//
//   in-app    the in-app system prompt (every section today)
//   mcp       the MCP `initialize` instructions, after the client's own rules
//   mcp-core  the MCP instructions too, first, inside the characters a client
//             keeps (server-factory.ts measures that budget)
//
// A section left out of MCP is one that cannot apply to an external client:
// the persona, in-app chat formatting, the agent's own memory charter, or
// tools an external client does not hold. The marker is the exclusion, so a
// rule added to a shared section reaches both surfaces with no second copy.
import fs from "node:fs"
import path from "node:path"
import { parseSkillFile } from "~/modules/agent/skills/skill-loader"

export type GuidanceAudience = "in-app" | "mcp" | "mcp-core"

export interface GuidanceSection {
  heading: string
  audiences: ReadonlySet<GuidanceAudience>
  /** The section as rendered: heading and body, marker removed. */
  text: string
}

const AUDIENCE_MARKER = /^<!--\s*audience:\s*([a-z\- ]+?)\s*-->\s*$/
const KNOWN: ReadonlySet<string> = new Set(["in-app", "mcp", "mcp-core"])

/**
 * Split a guidance template into its `## ` sections. Text before the first
 * section, and a section with no marker, are in-app only: nothing reaches an
 * external client unless a section says so.
 */
export function parseGuidanceSections(markdown: string): {
  preamble: string
  sections: GuidanceSection[]
} {
  const lines = markdown.split("\n")
  const preamble: string[] = []
  const sections: GuidanceSection[] = []
  let current: { heading: string; audiences: Set<GuidanceAudience>; body: string[] } | null = null
  const flush = () => {
    if (!current) return
    sections.push({
      heading: current.heading,
      audiences: current.audiences,
      text: [`## ${current.heading}`, ...current.body].join("\n").trimEnd(),
    })
  }
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush()
      current = { heading: line.slice(3).trim(), audiences: new Set(["in-app"]), body: [] }
      continue
    }
    const marker = current && current.body.length === 0 ? AUDIENCE_MARKER.exec(line) : null
    if (current && marker) {
      const declared = marker[1]!.split(/\s+/).filter((a) => a.length > 0)
      for (const a of declared) {
        if (!KNOWN.has(a)) throw new Error(`Unknown guidance audience "${a}" in ${current.heading}`)
      }
      current.audiences = new Set(declared as GuidanceAudience[])
      continue
    }
    if (current) current.body.push(line)
    else preamble.push(line)
  }
  flush()
  return { preamble: preamble.join("\n").trim(), sections }
}

/** The template rendered for one audience: its sections in file order. */
export function renderGuidance(markdown: string, audience: GuidanceAudience): string {
  const { preamble, sections } = parseGuidanceSections(markdown)
  const parts = sections.filter((s) => s.audiences.has(audience)).map((s) => s.text)
  if (audience === "in-app" && preamble) parts.unshift(preamble)
  return parts.join("\n\n")
}

const SYSTEM_TEMPLATE_PATH = path.resolve(import.meta.dir, "..", "prompts", "system.md")
let systemTemplate: string | null = null

/**
 * system.md read once, synchronously, for the MCP server factory (built per
 * request, synchronously). The in-app path reads the same file through
 * `loadPrompt`; this is the same bytes, never a second copy of the text.
 */
export function systemGuidanceTemplate(): string {
  if (systemTemplate === null) {
    systemTemplate = parseSkillFile(fs.readFileSync(SYSTEM_TEMPLATE_PATH, "utf-8")).content
  }
  return systemTemplate
}
