// SPDX-License-Identifier: FSL-1.1-ALv2
// Pages made with New page in this tab and not written in yet. When such a page is
// left with no text, it is discarded (the server checks it was never saved since it
// was made, `discard-untouched`), so abandoned "Untitled" pages do not pile up. A page
// made any other way (by an agent, an import, a folder's first text) is never here.
import type { ApiClient } from "~/lib/api-client"

const fresh = new Set<string>()

export function markFreshPage(id: string): void {
  fresh.add(id)
}

export function isFreshPage(id: string): boolean {
  return fresh.has(id)
}

export function forgetFreshPage(id: string): void {
  fresh.delete(id)
}

/**
 * The page was left with this text: a fresh page left empty is discarded. Answers
 * whether it was. Any refusal (written in, renamed, not this person's) keeps it.
 */
export async function discardIfUntouched(
  api: Pick<ApiClient, "post">,
  id: string,
  text: { body: string },
): Promise<boolean> {
  if (!fresh.has(id)) return false
  fresh.delete(id)
  if (text.body.trim() !== "") return false
  try {
    const res = await api.post<{ deleted: boolean }>(
      `/knowledge/documents/${id}/discard-untouched`,
      {},
      { suppressGlobalError: true },
    )
    return res?.deleted === true
  } catch {
    return false
  }
}
