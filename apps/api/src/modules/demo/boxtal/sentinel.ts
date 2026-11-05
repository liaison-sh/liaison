// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The constants that make a demo org's Boxtal connection inert.
//
// A demo org gets one Boxtal connection so the commerce scenario can quote a
// carrier and stage a label for its live order. Its keys are the literal
// sentinels below, never a credential: a leak of the demo database leaks
// nothing, and no caller can point a demo org at a real Boxtal account. For a
// demo org every Boxtal host is answered in-process by the demo responder or
// refused, never put on the wire, so no parcel is ever booked with a carrier.

/** The connection's name and identifier, as the Boxtal app resolves it. */
export const DEMO_BOXTAL_CONNECTION = "boxtal"
export const DEMO_BOXTAL_IDENTIFIER = "demo-boxtal"

/** The stand-in for every key. Not a credential, and recognisably not one. */
export const DEMO_BOXTAL_SENTINEL_KEY = "liaison-demo-fixture-not-a-boxtal-key"

/** Every host the Boxtal app may call (its manifest's allowedDomains). */
const BOXTAL_HOSTS: ReadonlySet<string> = new Set([
  "test.envoimoinscher.com",
  "www.envoimoinscher.com",
  "api.boxtal.build",
  "api.boxtal.com",
])

/** Is this a Boxtal host? One set lookup on the hot path. */
export function isBoxtalHost(hostname: string): boolean {
  return BOXTAL_HOSTS.has(hostname.toLowerCase())
}
