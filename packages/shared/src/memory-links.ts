// SPDX-License-Identifier: FSL-1.1-ALv2
// Parse and resolve `[[name]]` cross-references inside agent-memory content.
// Single source of truth, used by both apps/api and apps/web.

export type Entry = { name: string; description: string }

export type LinkToken =
  | { kind: "text"; value: string }
  | { kind: "link"; name: string; description: string | null; broken: boolean }

const LINK_RE = /\[\[([a-z0-9][a-z0-9_-]{0,63})\]\]/g

export function extractLinkedNames(body: string): string[] {
  return Array.from(body.matchAll(LINK_RE), (m) => m[1]!)
}

export function resolveMemoryLinks(body: string, entries: Entry[]): LinkToken[] {
  const byName = new Map(entries.map((e) => [e.name, e.description] as const))
  const out: LinkToken[] = []
  let lastIndex = 0
  for (const m of body.matchAll(LINK_RE)) {
    const at = m.index!
    if (at > lastIndex) out.push({ kind: "text", value: body.slice(lastIndex, at) })
    const name = m[1]!
    const description = byName.get(name) ?? null
    out.push({ kind: "link", name, description, broken: description === null })
    lastIndex = at + m[0].length
  }
  if (lastIndex < body.length) out.push({ kind: "text", value: body.slice(lastIndex) })
  return out
}
