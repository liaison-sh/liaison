// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sign-in mail's link is `/portal/sign-in?org=<slug>#c=<challenge>&t=<token>`:
// the secret is a fragment, so no server, log or referrer sees it. On load the
// page takes it, keeps it in memory and in this tab's sessionStorage (a reload of
// this tab still works, nothing else does), then rewrites the address to
// `/portal/<slug>/verify`: the history entry, synced history and a bookmark hold
// no token. The org's slug is not a secret: it is remembered so the sign-in page
// can name the org next time.

const LINK_KEY = "liaison:portal-link"
const ORG_KEY = "liaison:portal-org"

export interface SignInLink {
  challengeId: string
  token: string
}

export function linkFromFragment(hash: string): SignInLink | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  const p = new URLSearchParams(raw)
  const c = p.get("c")?.trim()
  const t = p.get("t")?.trim()
  return c && t ? { challengeId: c, token: t } : null
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/i

export function validSlug(s: string | null | undefined): s is string {
  return typeof s === "string" && SLUG.test(s) && s !== "sign-in"
}

export function rememberOrg(slug: string): void {
  try {
    window.localStorage.setItem(ORG_KEY, slug)
  } catch {
    // Storage refused: the next sign-in page is generic.
  }
}

export function rememberedOrg(): string | null {
  try {
    const v = window.localStorage.getItem(ORG_KEY)
    return validSlug(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Reads the link once per page load and cleans the address. Answers the org's
 * slug (from `?org=`, else the remembered one) and whether a link was taken.
 */
export function takeSignInLink(): { slug: string | null; link: boolean } {
  const params = new URLSearchParams(window.location.search)
  const org = params.get("org")
  const slug = validSlug(org) ? org : rememberedOrg()
  if (slug) rememberOrg(slug)
  const link = linkFromFragment(window.location.hash)
  if (link) {
    try {
      window.sessionStorage.setItem(LINK_KEY, JSON.stringify(link))
    } catch {
      // Private mode: the link lives in memory for this load.
      memoryLink = link
    }
  }
  const target = link ? (slug ? `/portal/${slug}/verify` : "/portal/sign-in/verify") : null
  if (target) window.history.replaceState(null, "", target)
  else if (window.location.search || window.location.hash) {
    window.history.replaceState(null, "", slug ? `/portal/${slug}` : window.location.pathname)
  }
  return { slug, link: link !== null }
}

let memoryLink: SignInLink | null = null

/** The link this tab holds, from memory or from this tab's sessionStorage. */
export function heldSignInLink(): SignInLink | null {
  if (memoryLink) return memoryLink
  try {
    const raw = window.sessionStorage.getItem(LINK_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<SignInLink>
    return typeof v.challengeId === "string" && typeof v.token === "string"
      ? { challengeId: v.challengeId, token: v.token }
      : null
  } catch {
    return null
  }
}

/** A link works once: forgotten as soon as it was posted. */
export function forgetSignInLink(): void {
  memoryLink = null
  try {
    window.sessionStorage.removeItem(LINK_KEY)
  } catch {
    // nothing kept
  }
}
