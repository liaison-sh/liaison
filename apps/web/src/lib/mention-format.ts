// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Mention grammar: @[Label](ref) — all mention types share the same wire format.
 * The ref determines both the type and display prefix:
 *
 *   user:<id>                → @ prefix  (people)
 *   thread:<id>              → # prefix  (entity)
 *   <app>:<entityType>:<id>  → # prefix  (entity)
 *
 * Rule: @ = people, # = entities. Threads are entities; so are contacts,
 * deals, tickets, and any future app-defined type. This keeps the grammar
 * extensible — new entity types automatically get # without code changes.
 */
const MENTION_RE = /@\[((?:[^\]\\]|\\.)+)\]\(([^)]+)\)/g

export interface Mention {
  type: "user" | "thread" | "entity" | "agent"
  id: string
  label: string
  app?: string
  entityType?: string
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/

function validateMentionField(value: string | undefined, name: string): string {
  if (!value || !SAFE_ID_RE.test(value)) {
    throw new Error(`Invalid mention ${name}: ${value}`)
  }
  return value
}

export function serializeMention(m: Mention): string {
  const safeLabel = m.label.replace(/[\]\\]/g, (ch) => `\\${ch}`)
  const safeId = validateMentionField(m.id, "id")
  if (m.type === "user") return `@[${safeLabel}](user:${safeId})`
  if (m.type === "thread") return `@[${safeLabel}](thread:${safeId})`
  if (m.type === "agent") return `@[${safeLabel}](agent:${safeId})`
  const safeApp = validateMentionField(m.app, "app")
  const safeEntityType = validateMentionField(m.entityType, "entityType")
  return `@[${safeLabel}](${safeApp}:${safeEntityType}:${safeId})`
}

export function parseMentions(text: string): Mention[] {
  const results: Mention[] = []
  for (const match of text.matchAll(MENTION_RE)) {
    const rawLabel = match[1]
    const ref = match[2]
    if (!rawLabel || !ref) continue
    const label = rawLabel.replace(/\\([\]\\])/g, "$1")
    const parts = ref.split(":")
    if (parts[0] === "user" && parts[1]) {
      results.push({ type: "user", id: parts[1], label })
    } else if (parts[0] === "thread" && parts[1]) {
      results.push({ type: "thread", id: parts[1], label })
    } else if (parts[0] === "agent" && parts[1]) {
      results.push({ type: "agent", id: parts[1], label })
    } else if (parts.length >= 3) {
      results.push({
        type: "entity",
        id: parts[parts.length - 1],
        label,
        app: parts[0],
        entityType: parts[1],
      })
    }
  }
  return results
}
