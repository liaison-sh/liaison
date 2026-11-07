// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Outbound domains are part of an app's grant (0281).
//
// A manifest declares the hosts its code may reach: `network.allowedDomains` and
// each connection's `allowedDomains`. Declaring a host is not enough: the install
// row records the domains somebody accountable consented to
// (`apps_installed.granted_domains`), and the sandbox reaches a host only when it
// is both declared and granted.
//
//   NULL      grandfathered: the row pre-dates the column, every declared domain
//             is granted (today's behaviour, no back-fill)
//   string[]  exactly these domains; a declared domain left out (a new one an
//             upgrade asks for, or one an admin revoked) is refused
//
// Who consents is the install row's manager: the instance operator for an
// instance app, the org's admin for an org's custom app (the app builder's
// publish writes the grant its approval pinned). The platform's own catalog
// artifacts and packages signed by a trusted publisher are granted every domain
// they declare, at install and at every upgrade.
//
// The grant is applied in one place, the sandbox bridge context
// (sandbox/bridge/context.ts `collectAllowedDomains`): `ctx.fetch`, the file
// download from a URL, the bulk download and the credential injection of
// `fetch-auth.ts` all read the intersected lists it hands out.

/** A row's domain grant: null = grandfathered (every declared domain). */
export type DomainGrant = readonly string[] | null

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

/** A domain as the grant stores and compares it. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase()
}

/** Every outbound domain a manifest declares (network and connections), once each, sorted. */
export function declaredDomains(manifest: unknown): string[] {
  const m = record(manifest)
  const out = new Set(strings(record(m.network).allowedDomains).map(normalizeDomain))
  for (const conn of Object.values(record(m.connections))) {
    for (const d of strings(record(conn).allowedDomains)) out.add(normalizeDomain(d))
  }
  out.delete("")
  return [...out].sort()
}

/** `domains` narrowed to the grant (all of them when grandfathered). */
export function grantedSubset(domains: readonly string[], grant: DomainGrant): string[] {
  if (grant === null) return [...domains]
  const granted = new Set(grant.map(normalizeDomain))
  return domains.filter((d) => granted.has(normalizeDomain(d)))
}

/** The declared domains a grant does not cover: what still needs consent. */
export function pendingDomains(manifest: unknown, grant: DomainGrant): string[] {
  if (grant === null) return []
  const granted = new Set(grant.map(normalizeDomain))
  return declaredDomains(manifest).filter((d) => !granted.has(d))
}

/** An outbound domain the install needs and nobody consented to. */
export class DomainConsentError extends Error {
  readonly code = "domain_consent_required"
  readonly status = 400
  constructor(
    readonly missing: string[],
    what: "Install" | "Upgrade",
  ) {
    super(
      `${what} requires outbound domains the admin did not approve: ${missing.join(", ")}. Re-run with these approved (grantedDomains).`,
    )
    this.name = "DomainConsentError"
  }
}

/** A pinned grant that is not exactly what the package declares (the builder's publish). */
export class DomainPinMismatchError extends Error {
  readonly code = "domain_pin_mismatch"
  readonly status = 409
  constructor(declared: string[], pinned: string[]) {
    super(
      `the package's outbound domains (${declared.join(", ") || "none"}) are not the approved ones (${pinned.join(", ") || "none"})`,
    )
    this.name = "DomainPinMismatchError"
  }
}

/**
 * The grant an install or upgrade records.
 *
 * - `vouched` (the platform's catalog artifact, or a trusted publisher's
 *   signature): every declared domain, whatever was passed.
 * - `granted` undefined: a trusted programmatic caller (the catalog, `config
 *   apply`, an org move): every declared domain.
 * - otherwise every declared domain must be either `alreadyGranted` (the
 *   running version's grant, on an upgrade) or in `granted`; the result is the
 *   declared domains, nothing extra.
 * - `exact` (the builder's publish): `granted` must equal the declared set.
 */
export function resolveGrantedDomains(opts: {
  manifest: unknown
  granted: readonly string[] | undefined
  vouched: boolean
  alreadyGranted?: readonly string[]
  exact?: boolean
  what: "Install" | "Upgrade"
}): string[] {
  const declared = declaredDomains(opts.manifest)
  if (opts.exact) {
    const pinned = [...new Set((opts.granted ?? []).map(normalizeDomain))].sort()
    if (pinned.length !== declared.length || pinned.some((d, i) => d !== declared[i])) {
      throw new DomainPinMismatchError(declared, pinned)
    }
    return declared
  }
  if (opts.vouched || opts.granted === undefined) return declared
  const ok = new Set([...(opts.alreadyGranted ?? []), ...opts.granted].map(normalizeDomain))
  const missing = declared.filter((d) => !ok.has(d))
  if (missing.length > 0) throw new DomainConsentError(missing, opts.what)
  return declared
}

/**
 * A bridge manifest with its domains narrowed to the grant. A connection that
 * declared hosts and has none granted keeps an empty list marked
 * `noGrantedHost`, so the credential rule never reads it as "a connection that
 * names no host" (which may reach any host the app may).
 */
export function withDomainGrant<
  M extends {
    network?: { allowedDomains?: string[] }
    connections?: Record<string, { allowedDomains?: string[] }>
  },
>(manifest: M, grant: DomainGrant): M {
  if (grant === null) return manifest
  const connections = manifest.connections
    ? Object.fromEntries(
        Object.entries(manifest.connections).map(([name, conn]) => {
          const declared = conn.allowedDomains ?? []
          const kept = grantedSubset(declared, grant)
          return [
            name,
            {
              ...conn,
              allowedDomains: kept,
              ...(declared.length > 0 && kept.length === 0 ? { noGrantedHost: true } : {}),
            },
          ]
        }),
      )
    : undefined
  return {
    ...manifest,
    ...(manifest.network
      ? {
          network: {
            ...manifest.network,
            allowedDomains: grantedSubset(manifest.network.allowedDomains ?? [], grant),
          },
        }
      : {}),
    ...(connections ? { connections } : {}),
  }
}

let lookupOverride: ((app: string) => Promise<DomainGrant>) | null = null

/**
 * The domain grant of the version of `app` that runs now: its install row's
 * (install-trust.ts, a few seconds' cache that a grant change resets), null
 * for an app shipped in the image (no install row). Throws when the row cannot
 * be read, so the caller refuses the egress (fail closed).
 */
export async function currentDomainGrant(app: string): Promise<DomainGrant> {
  if (lookupOverride) return lookupOverride(app)
  const { getInstallTrust } = await import("~/modules/apps/install-trust")
  return (await getInstallTrust(app)).grantedDomains
}

/** Test seam: answer the grant lookup without a database. */
export const EgressGrantsTestAccess = {
  setLookup(fn: ((app: string) => Promise<DomainGrant>) | null): void {
    lookupOverride = fn
  },
}
