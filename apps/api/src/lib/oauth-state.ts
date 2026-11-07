// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org prefix of an OAuth `state`. With LIAISON_OAUTH_REDIRECT_BASE set,
// every provider redirects to one central host, which knows nothing of the flow
// but its query: the state then reads `<slug>.<random>` so that host can send
// the browser on to `<slug>`'s own host, where the flow started and where its
// state record and cookies live. The callback there checks the prefix names
// its own org (and the record's). Unset, a state is the bare random token it
// always was.

import { env } from "~/lib/env"
import type { HostBinding } from "~/lib/org-host"

/** A DNS label: lowercase letters, digits and inner hyphens, at most 63 characters. */
const SLUG = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const PREFIXED_STATE = new RegExp(`^(${SLUG})\\.[A-Za-z0-9_-]+$`)

/** Whether states carry the org prefix on this deployment. */
export function oauthStatePrefixed(): boolean {
  return Boolean(env.LIAISON_OAUTH_REDIRECT_BASE)
}

/**
 * The state to send for a flow of the org with this slug. Throws when the
 * prefix is on and the slug cannot name a host: a state must never point the
 * central host at a host the org does not own.
 */
export function oauthStateFor(slug: string | null | undefined, random: string): string {
  if (!oauthStatePrefixed()) return random
  if (!slug || !new RegExp(`^${SLUG}$`).test(slug)) {
    throw new Error(`Org slug ${JSON.stringify(slug)} cannot prefix an OAuth state`)
  }
  return `${slug}.${random}`
}

/** The org slug a prefixed state names, or null when it is malformed. */
export function oauthStateSlug(state: string): string | null {
  return PREFIXED_STATE.exec(state)?.[1] ?? null
}

/**
 * Whether a callback's state may be taken up on this host, checked before the
 * state is spent: without the prefix, always; with it, the state must be well
 * formed and, on an org host, name that host's org. A non-org host completes
 * no flow.
 */
export function stateSlugFitsHost(state: string, binding: HostBinding): boolean {
  if (!oauthStatePrefixed()) return true
  const slug = oauthStateSlug(state)
  if (slug === null || binding.kind === "non-org") return false
  return binding.kind === "unbound" || binding.slug === slug
}

/** The state to send for a flow of the org with this id (one slug read, only with the prefix on). */
export async function oauthStateForOrg(orgId: string, random: string): Promise<string> {
  if (!oauthStatePrefixed()) return random
  const { orgSlugById } = await import("~/lib/org-public-url")
  return oauthStateFor(await orgSlugById(orgId), random)
}
