// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The constants that make a demo org's API connection inert.
//
// A demo org gets one API connection (the fixture CRM adapter) so the customer
// card, the settings page and the connector tools have something to show. Its
// base URL is a fixed host on the reserved `.example` TLD, which never
// resolves, and its API key is the literal sentinel below: a leak of the demo
// database leaks nothing, and no caller can point a demo org's connection at a
// real system. The demo responder answers that host in-process for demo orgs
// only; for any other org the host is just an address that does not resolve.

/** The connection's slug in a demo org. */
export const DEMO_API_CONNECTOR_IDENTIFIER = "crm"

/** The fixture CRM's base URL in a demo org. Fixed in shipped code. */
export const DEMO_API_CONNECTOR_BASE_URL = "https://fixture-crm.example/v1"

/** The stand-in for an API key. Not a credential, and recognisably not one. */
export const DEMO_API_CONNECTOR_SENTINEL_KEY = "liaison-demo-fixture-not-an-api-key"

/** Is this the demo fixture CRM's origin? One string compare on the hot path. */
export function isDemoApiConnectorOrigin(url: URL): boolean {
  return url.origin === new URL(DEMO_API_CONNECTOR_BASE_URL).origin
}

/**
 * The app and connection the demo seeds its fixture connection in: the demo
 * world turns on the API connector app (seed/tiers/demo/demo-apps.ts).
 */
export const DEMO_API_CONNECTION = { app: "api-connector", connection: "api" } as const
