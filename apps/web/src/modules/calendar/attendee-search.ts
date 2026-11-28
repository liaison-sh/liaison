// SPDX-License-Identifier: FSL-1.1-ALv2
// Who can be added as a guest while typing: the organization's people (the same search as
// mentions) and the contacts the viewer can read, deduplicated by email. A free address is
// always accepted too; this only suggests.
import { type Accessor, createSignal, onCleanup } from "solid-js"
import { searchMentions } from "~/lib/mention-service"

export interface AttendeeSuggestion {
  email: string
  name: string
  kind: "person" | "contact"
}

const DEBOUNCE_MS = 150
const LIMIT = 8

interface ContactRow {
  name?: string | null
  email?: string | null
}

/**
 * How well a suggestion matches what was typed, lower first: a word of the name or of the
 * address's local part starting with it, then the name containing it, then the local part, and
 * last a match on the domain alone (typing "am" must not list everyone at example.com before
 * Amina).
 */
export function suggestionRank(s: AttendeeSuggestion, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const name = s.name.toLowerCase()
  const local = s.email.toLowerCase().split("@")[0] ?? ""
  const words = [...name.split(/[\s'.-]+/), ...local.split(/[._+-]+/)].filter(Boolean)
  if (words.some((w) => w.startsWith(q)) || local.startsWith(q) || name.startsWith(q)) return 0
  if (name.includes(q)) return 1
  if (local.includes(q)) return 2
  return 3
}

/** Suggestions in rank order, the search's own order kept within a rank. */
export function rankSuggestions(rows: AttendeeSuggestion[], query: string): AttendeeSuggestion[] {
  return rows
    .map((row, index) => ({ row, index, rank: suggestionRank(row, query) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.row)
}

export function createAttendeeSearch(
  api: { get: (path: string) => Promise<unknown> },
  exclude: Accessor<Set<string>>,
) {
  const [raw, setRaw] = createSignal<AttendeeSuggestion[]>([])
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  async function search(q: string): Promise<AttendeeSuggestion[]> {
    const [people, contacts] = await Promise.all([
      searchMentions(api as { get: (path: string) => Promise<never> }, q, "@", LIMIT).catch(
        () => [],
      ),
      api
        .get(`/contacts?query=${encodeURIComponent(q)}&limit=${LIMIT}&mode=all`)
        .then((rows) => (Array.isArray(rows) ? (rows as ContactRow[]) : []))
        .catch(() => [] as ContactRow[]),
    ])
    const out: AttendeeSuggestion[] = []
    const seen = new Set<string>()
    const add = (
      email: string | null | undefined,
      name: string,
      kind: AttendeeSuggestion["kind"],
    ) => {
      const key = email?.trim().toLowerCase()
      if (!key || !key.includes("@") || seen.has(key)) return
      seen.add(key)
      out.push({ email: email!.trim(), name: name || email!.trim(), kind })
    }
    for (const p of people) {
      if (p.type === "user") add(p.secondaryLabel, p.label, "person")
    }
    for (const c of contacts) add(c.email, c.name ?? "", "contact")
    return rankSuggestions(out, q).slice(0, LIMIT)
  }

  function setQuery(q: string): void {
    if (timer) clearTimeout(timer)
    const trimmed = q.trim()
    const mine = ++seq
    // A list of addresses being pasted is not a search.
    if (trimmed.length < 2 || /[\s,;]/.test(trimmed)) {
      setRaw([])
      return
    }
    timer = setTimeout(async () => {
      const rows = await search(trimmed)
      if (mine === seq) setRaw(rows)
    }, DEBOUNCE_MS)
  }

  function clear(): void {
    seq++
    setRaw([])
  }

  const results = () => raw().filter((r) => !exclude().has(r.email.toLowerCase()))
  return { setQuery, results, clear }
}
