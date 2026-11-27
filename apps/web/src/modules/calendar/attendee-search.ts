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
    return out.slice(0, LIMIT)
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
