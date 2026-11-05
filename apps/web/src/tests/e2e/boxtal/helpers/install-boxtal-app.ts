// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 E2E harness — `installBoxtalApp` Playwright client.
//
// Thin HTTP client around `POST /api/_test/boxtal/install-for-test`. The
// actual install work (filesystem cp, runtime registry mutation, credentials
// connection seed, webhook-secret mint, subscribe-through-mock) happens in the
// API server process — see `apps/api/test-support/harness/boxtal-install-routes.ts`.
//
// NOT cached: the install route performs a clean-slate reset each call (drop
// app + connection, TRUNCATE app_boxtal tables, clear approvals), and many
// scenarios seed different sender/profile fixtures, so each scenario installs
// fresh. (workers:1 shares the schema; the reset is what guarantees isolation.)
import { api } from "@liaison/test-helpers"

export interface SenderAddressSeed {
  name: string
  company?: string
  email?: string
  phone: string
  street: string
  city: string
  postalCode: string
  countryIsoCode: string
}

export interface ShippingProfileSeed {
  product_source: string
  product_id: string
  unit_weight: number
  solo_length?: number
  solo_width?: number
  solo_height?: number
  content_category?: string
}

export interface ShipmentSeed {
  document_ref?: string
  recipient_summary: string
  offer_code?: string
  tracking_number?: string
  declared_total?: number
  /** What the LABEL cost. The print station's `cost` column reads this, not declared_total. */
  label_cost_ttc?: number
  currency?: string
  order_status?: "PENDING" | "REQUESTED" | "CONFIRMED" | "CANCELLED"
  tracking_status?: string
  documents?: Array<{ type: string; format: string }>
  kind?: "outbound" | "return"
  return_reason?: string
  created_by?: "agent" | "user"
}

export interface InstallBoxtalAppOptions {
  serverUrl: string
  token: string
  orgId: string
  bundlePath?: string
  grantedScopes?: string[]
  seedSenderAddress?: SenderAddressSeed
  seedShippingProfiles?: ShippingProfileSeed[]
  /** Product profiles with a short code, each linked to one variant (no code sync runs). */
  seedProductProfiles?: Array<{
    label: string
    short_code: string
    unit_weight: number
    product_source: string
    product_id: string
  }>
  seedShipments?: ShipmentSeed[]
}

export interface InstalledBoxtalApp {
  appName: "boxtal"
  connectionId: string
  webhookSecret: string | null
  webhookStatus: string | null
  seededProfileIds: string[]
  seededShipmentIds: string[]
}

export async function installBoxtalApp(opts: InstallBoxtalAppOptions): Promise<InstalledBoxtalApp> {
  const resp = await api(opts.serverUrl, "/api/_test/boxtal/install-for-test", {
    method: "POST",
    token: opts.token,
    body: {
      orgId: opts.orgId,
      ...(opts.bundlePath ? { bundlePath: opts.bundlePath } : {}),
      ...(opts.grantedScopes ? { grantedScopes: opts.grantedScopes } : {}),
      ...(opts.seedSenderAddress ? { seedSenderAddress: opts.seedSenderAddress } : {}),
      ...(opts.seedShippingProfiles ? { seedShippingProfiles: opts.seedShippingProfiles } : {}),
      ...(opts.seedProductProfiles ? { seedProductProfiles: opts.seedProductProfiles } : {}),
      ...(opts.seedShipments ? { seedShipments: opts.seedShipments } : {}),
    },
  })
  if (resp.status !== 200) {
    throw new Error(`installBoxtalApp: route returned ${resp.status}: ${JSON.stringify(resp.body)}`)
  }
  return resp.body as InstalledBoxtalApp
}
