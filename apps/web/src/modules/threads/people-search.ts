// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The debounced "search people" both new-conversation dialogs type into. One
// place so the two pickers agree on who can be found and how fast.

import { type Accessor, createSignal, onCleanup } from "solid-js"
import { searchMentions } from "~/lib/mention-service"

export interface PersonResult {
  id: string
  name: string
  email: string
}

/** How long typing has to pause before the server is asked. */
const DEBOUNCE_MS = 150

export function createPeopleSearch(
  api: { get: (path: string) => Promise<any> },
  exclude: Accessor<Set<string>>,
) {
  const [query, setQueryRaw] = createSignal("")
  const [raw, setRaw] = createSignal<PersonResult[]>([])
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  function setQuery(q: string) {
    setQueryRaw(q)
    if (timer) clearTimeout(timer)
    const trimmed = q.trim()
    const mine = ++seq
    if (trimmed.length === 0) {
      setRaw([])
      return
    }
    timer = setTimeout(async () => {
      try {
        const rows = await searchMentions(api, trimmed, "@", 10)
        if (mine !== seq) return
        setRaw(
          rows
            .filter((r) => r.type === "user")
            .map((r) => ({ id: r.id, name: r.label, email: r.secondaryLabel ?? "" })),
        )
      } catch {
        if (mine === seq) setRaw([])
      }
    }, DEBOUNCE_MS)
  }

  /** Results minus anyone already picked (or the viewer), recomputed as the
   *  picked set changes so a chip removal brings its person back. */
  const results = () => raw().filter((p) => !exclude().has(p.id))

  return { query, setQuery, results }
}
