// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/settings/branding, UNAUTHENTICATED.
//
// The desktop's first launch has no token: the window has to render the
// deployment's own name before the device grant can even start, or the user is
// asked to approve a connection to a blank. So this one read is public, and
// the whole design of it is about what it must NOT carry: no email, no user,
// no id, no address, no secret. Four fields, and the route test pins the key
// set exactly so a later "just one more field" is a failing test.
//
// WHICH ORG ANSWERS. This used to be unconditionally the org with the smallest
// `created_at`, which is correct on a single-org self-hosted box and wrong the
// moment a box holds more than one tenant: every visitor got the FIRST org's
// name, whichever server address they had typed. `organizations` has a `slug`
// and no host column, so the tenant is resolved from the request instead:
//
//   1. the first label of the `Host` header, when it matches an org slug
//      (acme.demo.liaison.sh -> slug "acme"), which is how a per-tenant
//      hostname is served without a schema change; then
//   2. the oldest org, which is the previous behaviour and the right answer on
//      the single-org deployment that is still the normal case.
//
// NO `?org=<slug>`. It was there for a deployment serving every tenant on one
// hostname, and it was a slug EXISTENCE ORACLE the old code did not have: an
// anonymous caller walked a wordlist and read back a tenant's real org name on
// a hit, the oldest org's on a miss, and the two are trivially distinguishable.
// `Host` cannot be closed the same way (it is what multi-tenant serving means)
// but it is the value a reverse proxy validates against its own certificate and
// vhost list before anything reaches this process, so it is a name the operator
// chose rather than a string the caller typed. A client that needs to name a
// tenant does it with a hostname.
//
// An IP literal is not a slug. `10.0.0.5` used to have its first octet taken as
// a candidate slug and queried for an org called "10".
//
// CACHING. The old header was an unconditional `public, max-age=60`, which on a
// multi-tenant box invites a shared cache to hand one tenant's name to another:
// the answer was never actually "the same for everyone" once step 1 existed.
// The response now always carries `Vary: Host` (so a cache that collapses hosts
// is told the body depends on one) and is only marked `public` when this
// deployment holds exactly ONE org and there is therefore only one possible
// answer. Anything else is `private`: still cacheable by the client that asked,
// never by something in between serving other tenants.
import { asc, eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { customAppsEnabled, isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { success } from "~/lib/response"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"

export const brandingRoutes = new Hono<AppEnv>()

export interface PublicBranding {
  orgName: string
  /**
   * Always null today: the organizations row carries no logo column, and
   * nothing else on it is an image. The field is in the payload because the
   * desktop renders a branded header either way, and an absent key would read
   * as a bug rather than as "this deployment has no logo".
   */
  logoUrl: string | null
  /**
   * Public-safe org level booleans. Nothing in `organizations.settings` is
   * published here: it holds quotas, rate limits, the demo marker, and the
   * encrypted BYOK provider keys. A flag is added only once it is something a
   * LOGGED OUT window legitimately needs.
   *
   * `demo`, present and true only on a demo deployment, is the first and only
   * one. A logged out visitor on demo.liaison.sh has to be offered the demo
   * doors (sign in as somebody at the fictional company, or create a throwaway
   * workspace) before any account exists, and the web client must learn that
   * from the server rather than from a build flag, or the same bundle would
   * advertise a demo on every self-hosted box that installs it. It discloses
   * nothing the deployment is not already advertising by answering
   * `POST /api/demo/orgs` at all, and on every other deployment the object is
   * absent-keyed exactly as it was: `{}`.
   *
   * `noAccountEntry`, present and true on every host of a managed server: its
   * /register takes invitations only, and an invite link goes straight to it, so
   * the login page offers no "Create an account". Absent on a self-hosted one.
   *
   * `customApps`, present and true when organisations may have their own apps
   * (LIAISON_CUSTOM_APPS, lib/edition.ts customAppsEnabled): the web shows the
   * app builder only then. Absent when they are off.
   */
  flags: Record<string, boolean>
  /**
   * The models this deployment brings its own key for. EMPTY today: BYOK is
   * stored as `settings.providerKeys`, keyed by PROVIDER and holding encrypted
   * key material, with no model list anywhere. Publishing the provider names
   * would be publishing part of the deployment's configuration to anonymous
   * callers, so this stays empty until a real model list setting exists.
   */
  byokModelIds: string[]
  /**
   * The instance's privacy policy (LIAISON_PRIVACY_URL), linked from the notice
   * under the demo signup button. Keyed absent when unset, so a deployment that
   * sets nothing answers exactly as before.
   */
  privacyUrl?: string
  /**
   * Demo deployments only (absent-keyed elsewhere): what the public demo door
   * needs before anyone has an account. The Turnstile SITE key (public by
   * design: it is embedded in every page that renders the widget), the
   * booking link (absent when unset) and the self-hosting docs link.
   */
  demo?: { turnstileSiteKey?: string; bookingUrl?: string; selfHostUrl?: string }
}

/**
 * The slug a request is asking for, or null. Resolved from the `Host` header
 * ONLY: see the header note on why the query string was removed.
 *
 * A slug is `[a-z0-9-]`, so a host label that could not be one is discarded
 * before it reaches the database, and a host that is an IP literal names no
 * tenant at all.
 */
export function requestedOrgSlug(host: string | undefined): { slug: string } | null {
  const hostname = (host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
  if (hostname === "") return null
  // An address is not a name. Bare IPv4 (with or without a port), and anything
  // containing a colon once the brackets are off, which is IPv6.
  const withoutPort = hostname.split(":")[0]
  if (hostname.includes(":") && !/^[a-z0-9.-]+:\d+$/.test(hostname)) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(withoutPort)) return null
  const label = withoutPort.split(".")[0]
  if (!isSlugShaped(label) || label === "www" || label === "localhost") return null
  return { slug: label }
}

function isSlugShaped(value: string): boolean {
  return value.length > 0 && value.length <= 63 && /^[a-z0-9][a-z0-9-]*$/.test(value)
}

brandingRoutes.get("/branding", async (c) => {
  const requested = requestedOrgSlug(c.req.header("host"))

  const resolved = await withSystemDb("public-branding", async (tx) => {
    if (requested) {
      const [match] = await tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.slug, requested.slug))
        .limit(1)
      if (match) return { name: match.name, tenantSpecific: true, singleOrg: false }
    }
    // LIMIT 2, not 1: the second row is the whole question of whether this
    // deployment has one possible answer or several, and asking for it costs
    // nothing next to the row we already need.
    const rows = await tx
      .select({ name: organizations.name })
      .from(organizations)
      .orderBy(asc(organizations.createdAt))
      .limit(2)
    return { name: rows[0]?.name, tenantSpecific: false, singleOrg: rows.length === 1 }
  })

  const body: PublicBranding = {
    orgName: resolved.name ?? "Liaison",
    logoUrl: null,
    // Keyed absent rather than `demo: false` off a demo box, so a normal
    // deployment's body is byte identical to what it has always been.
    flags: {
      ...(isDemoModeEnabled() ? { demo: true } : {}),
      ...(isManagedEdition() ? { noAccountEntry: true } : {}),
      ...(customAppsEnabled() ? { customApps: true } : {}),
    },
    byokModelIds: [],
    ...(env.LIAISON_PRIVACY_URL ? { privacyUrl: env.LIAISON_PRIVACY_URL } : {}),
    ...(isDemoModeEnabled()
      ? {
          demo: {
            ...(env.TURNSTILE_SITE_KEY ? { turnstileSiteKey: env.TURNSTILE_SITE_KEY } : {}),
            ...(env.LIAISON_DEMO_BOOKING_URL ? { bookingUrl: env.LIAISON_DEMO_BOOKING_URL } : {}),
            ...(env.LIAISON_DEMO_SELF_HOST_URL
              ? { selfHostUrl: env.LIAISON_DEMO_SELF_HOST_URL }
              : {}),
          },
        }
      : {}),
  }
  // The body depends on the Host, so say so, for every answer, including the
  // fallback: a cache must not learn the shape of this route from the one
  // response that happened to be host-independent.
  c.header("Vary", "Host")
  c.header(
    "Cache-Control",
    !resolved.tenantSpecific && resolved.singleOrg ? "public, max-age=60" : "private, max-age=60",
  )
  return success(c, body)
})
