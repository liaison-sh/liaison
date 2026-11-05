// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 E2E harness I1 — `installInvoicingApp` Playwright client.
//
// Thin HTTP client around `POST /api/_test/invoicing/install-for-test`.
// The actual install work (filesystem cp, in-memory runtime registry
// mutation, issuer profile + mail account seed) happens in the API server
// process — see `apps/api/test-support/harness/invoicing-install-routes.ts`.
//
// Per-worker cache keyed by `${serverUrl}:${orgId}` and the lane's data
// generation, so the scenarios of one spec file share a single install (the second call
// would otherwise hit the unique constraint on `apps_installed.(name)`).
// On failure, the cache entry is dropped so a retry attempts fresh.
import { api } from "@liaison/test-helpers"
import { laneGeneration } from "../../fixtures/test"

export interface InstallInvoicingAppOptions {
  serverUrl: string
  token: string
  orgId: string
  bundlePath?: string
  grantedScopes?: string[]
  issuerCountry?: "FR" | "DE" | "GB" | "US"
  issuerOverrides?: {
    invoice_approval_threshold_minor?: number | null
    po_approval_threshold_minor?: number | null
    require_two_eyes?: boolean
    auto_email_enabled?: boolean
    timezone?: string
  }
  additionalIssuers?: Array<"FR" | "DE" | "GB" | "US">
  additionalContacts?: Array<{
    country: string
    name: string
    email: string
    /** E-invoicing kind of the contact (required: a French buyer's kind is never guessed). */
    customerKind: "business" | "individual" | "public_entity" | "non_registered_entity"
    identity?: { siren: string; postcode: string; city: string }
  }>
  shopifyInstallHandle?: { shopDomain: string; connectionId: string }
  seedCustomsFixtures?: boolean
}

export interface InstalledInvoicingApp {
  appName: "invoicing"
  primaryIssuerProfileId: string
  additionalIssuerIds: string[]
  additionalContactIds: string[]
  mailAccountId: string
  shopMappingId: string | null
}

const installCache = new Map<string, Promise<InstalledInvoicingApp>>()

/**
 * Cache key includes a hash of every input that affects what the install
 * route writes — without this, S0's "no extra contacts" install would
 * shadow S1's "+ one contact" install in the same worker.
 */
function cacheKeyFor(opts: InstallInvoicingAppOptions): string {
  const stable = {
    issuerCountry: opts.issuerCountry ?? null,
    issuerOverrides: opts.issuerOverrides ?? null,
    additionalIssuers: opts.additionalIssuers ?? [],
    additionalContacts: opts.additionalContacts ?? [],
    shopifyInstallHandle: opts.shopifyInstallHandle ?? null,
    seedCustomsFixtures: !!opts.seedCustomsFixtures,
  }
  // A lane reset between spec files drops the install from the database: the
  // next file installs again instead of trusting an install the reset undid.
  return `${opts.serverUrl}:${opts.orgId}:${laneGeneration()}:${JSON.stringify(stable)}`
}

export async function installInvoicingApp(
  opts: InstallInvoicingAppOptions,
): Promise<InstalledInvoicingApp> {
  const cacheKey = cacheKeyFor(opts)
  const cached = installCache.get(cacheKey)
  if (cached) return cached

  const promise = (async () => {
    const resp = await api(opts.serverUrl, "/api/_test/invoicing/install-for-test", {
      method: "POST",
      token: opts.token,
      body: {
        orgId: opts.orgId,
        ...(opts.bundlePath ? { bundlePath: opts.bundlePath } : {}),
        ...(opts.grantedScopes ? { grantedScopes: opts.grantedScopes } : {}),
        ...(opts.issuerCountry ? { issuerCountry: opts.issuerCountry } : {}),
        ...(opts.issuerOverrides ? { issuerOverrides: opts.issuerOverrides } : {}),
        ...(opts.additionalIssuers ? { additionalIssuers: opts.additionalIssuers } : {}),
        ...(opts.additionalContacts ? { additionalContacts: opts.additionalContacts } : {}),
        ...(opts.shopifyInstallHandle ? { shopifyInstallHandle: opts.shopifyInstallHandle } : {}),
        ...(opts.seedCustomsFixtures !== undefined
          ? { seedCustomsFixtures: opts.seedCustomsFixtures }
          : {}),
      },
    })
    if (resp.status !== 200) {
      throw new Error(
        `installInvoicingApp: route returned ${resp.status}: ${JSON.stringify(resp.body)}`,
      )
    }
    return resp.body as InstalledInvoicingApp
  })()

  installCache.set(cacheKey, promise)
  try {
    return await promise
  } catch (err) {
    installCache.delete(cacheKey)
    throw err
  }
}
