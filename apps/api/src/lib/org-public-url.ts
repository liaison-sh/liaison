// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one builder of the base URL of the absolute links the server hands to a
// person for an org: sign-in and invitation mails, password reset, digests,
// connect links, setup guides, file and export links, and the like.
//
// With LIAISON_ORG_HOST_TEMPLATE set (`https://{slug}.example.com`), each org
// has its own host and its links carry it. Unset, the bases are what they always
// were, read as configured: BASE_URL for server links (`orgPublicBaseUrl`), the
// first web origin of ALLOWED_ORIGINS for web-app pages (`orgAppBaseUrl`), so a
// deployment without the template builds the same links it always did. A guard
// test (tests/no-raw-base-url.test.ts) keeps every other link builder off both.

import type { Context } from "hono"
import { env } from "~/lib/env"
import { requestHostBinding } from "~/lib/org-host"

/** A DNS label: lowercase letters, digits and inner hyphens, at most 63 characters. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Whether orgs have their own hosts on this deployment. */
export function orgHostsEnabled(): boolean {
  return Boolean(env.LIAISON_ORG_HOST_TEMPLATE)
}

/**
 * The base URL for links to the org with this slug. Throws on a slug that cannot
 * be a host label: a link must never carry a host the slug did not name.
 */
export function orgPublicBaseUrlForSlug(slug: string): string {
  const template = env.LIAISON_ORG_HOST_TEMPLATE
  if (!template) return env.BASE_URL
  if (!HOST_LABEL.test(slug)) {
    throw new Error(`Org slug ${JSON.stringify(slug)} cannot name a host`)
  }
  return template.replace("{slug}", slug)
}

/**
 * The base URL for links to an org, given its id or its slug. Without the
 * template it is BASE_URL and nothing is read; with it, an id costs one read of
 * the org's slug (slugs can change, so it is not cached).
 */
export async function orgPublicBaseUrl(org: string | { slug: string }): Promise<string> {
  if (!env.LIAISON_ORG_HOST_TEMPLATE) return env.BASE_URL
  if (typeof org !== "string") return orgPublicBaseUrlForSlug(org.slug)
  const slug = await orgSlugById(org)
  if (slug === null) throw new Error(`No org ${org} to build a link for`)
  return orgPublicBaseUrlForSlug(slug)
}

/** The slug of the org with this id (one system read, before any actor exists); null when none. */
export async function orgSlugById(orgId: string): Promise<string | null> {
  const [{ withSystemDb }, { organizations }, { eq }] = await Promise.all([
    import("~/db/privileged"),
    import("~/db/schema/kernel"),
    import("drizzle-orm"),
  ])
  const [row] = await withSystemDb("org-slug-by-id", (db) =>
    db
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return row?.slug ?? null
}

/** The web app's origin on a deployment without org hosts: the first configured web origin. */
export function instanceAppOrigin(): string {
  return (
    env.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .find((origin) => origin && origin !== "*") ?? "http://localhost:5173"
  )
}

/**
 * The base URL for links to web-app pages of an org (a thread, a settings page,
 * a connect link's page). With org hosts it is the org's host, as the web app is
 * served there; without, or with no org known, the instance's web origin.
 */
export async function orgAppBaseUrl(org: string | { slug: string } | null): Promise<string> {
  if (!env.LIAISON_ORG_HOST_TEMPLATE || org === null) return instanceAppOrigin()
  return orgPublicBaseUrl(org)
}

/**
 * The base of every OAuth provider redirect_uri (sign-in and connectors), and so
 * of the one a setup guide shows: LIAISON_OAUTH_REDIRECT_BASE when set (one
 * central host for all orgs), otherwise BASE_URL exactly as configured.
 */
export function oauthRedirectBaseUrl(): string {
  return env.LIAISON_OAUTH_REDIRECT_BASE ?? env.BASE_URL
}

/**
 * The base URL for links answered before any org is known (MCP discovery
 * metadata, its WWW-Authenticate challenge, a device flow's verification page):
 * with org hosts, the org host the request came to; otherwise BASE_URL.
 */
export function requestPublicBaseUrl(c: Context): string {
  const binding = requestHostBinding(c)
  return binding.kind === "org" ? orgPublicBaseUrlForSlug(binding.slug) : env.BASE_URL
}
