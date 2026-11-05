// SPDX-License-Identifier: FSL-1.1-ALv2
import { onCleanup } from "solid-js"

interface DebouncedSearchOptions<T> {
  delay?: number
  onResults: (results: T) => void
  onError?: () => void
}

export function createDebouncedSearch<T>(
  search: (query: string, seq: number) => Promise<T>,
  options: DebouncedSearchOptions<T>,
): (query: string) => void {
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  return (query: string) => {
    if (timer) clearTimeout(timer)
    const current = ++seq
    timer = setTimeout(async () => {
      try {
        const result = await search(query, current)
        if (current === seq) options.onResults(result)
      } catch {
        if (current === seq) options.onError?.()
      }
    }, options.delay ?? 150)
  }
}
