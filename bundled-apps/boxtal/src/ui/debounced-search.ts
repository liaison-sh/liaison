// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A server-side search behind a text box: the box's value, the debounced
// fetch, the last results, and the loading and error flags, as plain signals.
//
// Why not a resource keyed on the query. A `createResource(query, fetch)`
// refetches on every keystroke, and its accessor, read during render, registers
// the read on the nearest <Suspense>. Inside the shell that boundary is the
// tab's own, so each letter typed pulled the whole page (search box included)
// out of the document until the new results landed: the page "reloaded" on
// every keystroke, lost the focus and fired one request per letter.
//
// Here nothing ever suspends. Typing updates `query` at once (the box keeps its
// value and focus), the fetch starts `debounceMs` after the last keystroke, the
// previous results stay on screen while it runs, and a response that arrives
// after a newer request was started is dropped, so a slow early search never
// overwrites a later one.
import { createSignal, onCleanup } from "solid-js"

export const SEARCH_DEBOUNCE_MS = 250

export interface DebouncedSearchOptions<T> {
  fetch: (query: string) => Promise<T>
  debounceMs?: number
  initialQuery?: string
  /** Injectable clock for tests; defaults to setTimeout/clearTimeout. */
  schedule?: (cb: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export interface DebouncedSearch<T> {
  /** The text box value, updated on every keystroke. */
  query: () => string
  setQuery: (value: string) => void
  /** The latest results; kept while a newer search loads. */
  results: () => T | undefined
  loading: () => boolean
  error: () => unknown
  /** Re-run the current search now (after an import, say). */
  refetch: () => void
}

/** Must be called inside a reactive owner (a component body): the pending
 *  timer is cancelled and late responses are ignored once it is disposed. */
export function createDebouncedSearch<T>(opts: DebouncedSearchOptions<T>): DebouncedSearch<T> {
  const debounceMs = opts.debounceMs ?? SEARCH_DEBOUNCE_MS
  const schedule = opts.schedule ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const cancel = opts.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const [query, setQueryValue] = createSignal(opts.initialQuery ?? "")
  const [results, setResults] = createSignal<T | undefined>(undefined)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>(undefined)

  let latest = 0
  let lastFetched: string | null = null
  let timer: unknown
  let disposed = false

  const run = (q: string): void => {
    const seq = ++latest
    lastFetched = q
    setLoading(true)
    opts.fetch(q).then(
      (value) => {
        if (disposed || seq !== latest) return
        setResults(() => value)
        setError(undefined)
        setLoading(false)
      },
      (err: unknown) => {
        if (disposed || seq !== latest) return
        setError(() => err)
        setLoading(false)
      },
    )
  }

  const clearTimer = (): void => {
    if (timer !== undefined) cancel(timer)
    timer = undefined
  }

  const setQuery = (value: string): void => {
    setQueryValue(value)
    clearTimer()
    timer = schedule(() => {
      timer = undefined
      if (disposed) return
      const q = query().trim()
      // A trailing space, or typing a letter and deleting it, asks for the
      // search already on screen (or in flight): no new request.
      if (q === lastFetched) return
      run(q)
    }, debounceMs)
  }

  onCleanup(() => {
    disposed = true
    clearTimer()
  })

  run(query().trim())

  return {
    query,
    setQuery,
    results,
    loading,
    error,
    refetch: () => {
      clearTimer()
      run(query().trim())
    },
  }
}
