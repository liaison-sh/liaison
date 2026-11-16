// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The link is `/a#t=<token>`: a fragment, so no server and no referrer ever sees
// it. On load the page takes the token from the fragment, keeps it in memory and
// in this tab's sessionStorage (so a reload of this tab still works, and nothing
// else), then rewrites the address to a bare `/a`: the history entry, synced
// history and a bookmark hold no token.

const SESSION_KEY = "liaison:client-action-link"

/** The token in a `#t=...` fragment, or null. */
export function tokenFromFragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  const value = new URLSearchParams(raw).get("t")
  return value && value.trim() !== "" ? value.trim() : null
}

/**
 * Reads the token once per page load. The fragment wins over a token kept for
 * this tab; the address is cleaned either way.
 */
export function takeLinkToken(): string | null {
  if (typeof window === "undefined") return null
  const fromHash = tokenFromFragment(window.location.hash)
  if (fromHash) {
    try {
      window.sessionStorage.setItem(SESSION_KEY, fromHash)
    } catch {
      // Storage refused (private mode): the token lives in memory only.
    }
  }
  if (window.location.hash || window.location.search) {
    window.history.replaceState(null, "", window.location.pathname)
  }
  if (fromHash) return fromHash
  try {
    return window.sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}
