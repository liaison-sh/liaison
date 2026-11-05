// SPDX-License-Identifier: FSL-1.1-ALv2
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "skill-loader" })

export interface SkillMeta {
  name: string
  type: "agent_instructions" | "skill"
  description: string
  requiredScopes?: string[]
  /** agent_instructions only: the tools the guide is about, as sdk names or `*` prefixes (`kernel__config_*`). */
  tools?: string[]
}

export interface SkillFile {
  meta: SkillMeta
  content: string
}

const VALID_TYPES = new Set(["agent_instructions", "skill"])
const SKILL_DESCRIPTION_MAX = 100

export function parseSkillFile(raw: string): SkillFile {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n*/)
  if (!match) throw new Error("Skill file missing YAML frontmatter")

  const frontmatter = match[1]!
  const meta: Record<string, string> = {}
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/)
    if (m) meta[m[1]!] = m[2]!.trim()
  }

  if (!meta.name) throw new Error("Skill file missing required field: name")
  if (!meta.type) throw new Error("Skill file missing required field: type")
  if (!VALID_TYPES.has(meta.type)) throw new Error(`Skill file has invalid type: ${meta.type}`)
  if (!meta.description) throw new Error("Skill file missing required field: description")
  if (meta.type === "skill" && meta.description.length > SKILL_DESCRIPTION_MAX) {
    throw new Error(`Skill description exceeds ${SKILL_DESCRIPTION_MAX} chars`)
  }

  const scopes =
    meta.type === "skill" && meta.requiredScopes
      ? meta.requiredScopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined

  const tools =
    meta.type === "agent_instructions" && meta.tools
      ? meta.tools
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined

  const content = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trimEnd()
  return {
    meta: {
      name: meta.name,
      type: meta.type as SkillMeta["type"],
      description: meta.description,
      ...(scopes ? { requiredScopes: scopes } : {}),
      ...(tools ? { tools } : {}),
    },
    content,
  }
}

/**
 * Loads all skill / agent_instructions files from a directory.
 * Reads top-level `.md` files. Caller decides what to do based on `meta.type`.
 */
export async function loadSkillFiles(dir: string): Promise<SkillFile[]> {
  const skills: SkillFile[] = []

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf-8")
      skills.push(parseSkillFile(raw))
    } catch (err) {
      log.warn({ file: entry, err }, "Skipping invalid skill file")
    }
  }

  return skills
}
