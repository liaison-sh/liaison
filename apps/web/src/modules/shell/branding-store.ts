// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The deployment's own name, for the one place the shell has room to say it.
//
// GET /api/settings/branding is the public read the native shells already use
// before anybody has signed in (apps/api/src/modules/branding/routes.ts), and
// it carries four fields and nothing about a user. The phone top bar is the
// only surface that asks for it here: at phone width there is no sidebar and
// no tab strip, so without this the app never says which server or which
// workspace is on the screen.
import { createSignal } from "solid-js"
import { apiUrl } from "~/lib/env"
import { onSessionTeardown } from "~/lib/session-lifecycle"

const [publicOrgName, setPublicOrgName] = createSignal<string | null>(null)

/**
 * The name of the org the VIEWER is signed in to.
 *
 * `/settings/branding` is a public, pre-login read: it resolves the deployment
 * by Host slug and, when nothing matches, answers with the OLDEST org on the
 * box. On a deployment carrying more than one org that is not the org the
 * viewer is in, so a signed-in surface that printed it named somebody else's
 * workspace ("Default Organization" beside every other surface's real name).
 * The signed-in answer therefore WINS over the public one wherever it is
 * loaded; the public name stays the pre-login fallback it was written to be.
 */
const [signedInOrgName, setSignedInOrgName] = createSignal<string | null>(null)

/** The workspace name a surface should print: the signed-in org when it is
 *  known, the deployment's public name before anybody has signed in. */
const orgName = (): string | null => signedInOrgName() ?? publicOrgName()

/**
 * Is the SIGNED IN org a demo workspace (a visitor's, or the reserved review
 * one)? From the authenticated `GET /org` (`demo`); null until it is read. A
 * demo deployment can also hold real workspaces, and those show none of the
 * demo's surfaces: `demoMode()` says what the box is, this says what the org is.
 */
const [signedInOrgDemo, setSignedInOrgDemo] = createSignal<boolean | null>(null)

/** The demo's in-product surfaces (the banner, the welcome): a demo box AND a signed-in org the server said is a demo one. Unknown (null) shows none of them. */
const demoOrgSurfaces = (): boolean => demoMode() && signedInOrgDemo() === true

/**
 * Is the server we are talking to the public demo instance?
 *
 * THIS IS HOW THE CLIENT LEARNS IT, and the reason it is here rather than in a
 * demo module of its own: `flags` on the branding payload is the deployment's
 * only statement about itself that a LOGGED OUT window can read, and the demo
 * doors have to be offered before any account exists. A build flag would make
 * the same bundle advertise a demo on every self-hosted install.
 *
 * `false` until the fetch lands and `false` for ever if it fails, so every demo
 * surface is opt-in on a positive answer and a server that never replies shows
 * an ordinary login rather than a demo that is not there.
 */
const [demoMode, setDemoMode] = createSignal(false)

/**
 * The instance's privacy policy, when the operator configured one
 * (LIAISON_PRIVACY_URL). The demo signup notice links it; null shows the notice
 * without a link. Only an http(s) URL is accepted.
 */
const [privacyUrl, setPrivacyUrl] = createSignal<string | null>(null)

export { demoMode, demoOrgSurfaces, orgName, privacyUrl, signedInOrgDemo }

let inFlight: Promise<void> | null = null
/**
 * Separate from `orgName() !== null`, which used to be the whole latch: a
 * deployment can legitimately answer with flags and no usable name, and the
 * demo flag must not re-fetch on every caller in that case.
 */
let loaded = false

/** Fetches once per page. A failure leaves the name null and the bar unnamed
 *  rather than blocking anything: this is a label, not a gate. */
export function ensureBrandingLoaded(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (loaded) return Promise.resolve()
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const response = await fetchImpl(apiUrl("/settings/branding"))
      if (!response.ok) return
      const body = (await response.json()) as {
        data?: { orgName?: unknown; flags?: unknown; privacyUrl?: unknown }
      }
      const name = body?.data?.orgName
      if (typeof name === "string" && name.trim().length > 0) setPublicOrgName(name.trim())
      const flags = body?.data?.flags
      if (flags && typeof flags === "object") {
        setDemoMode((flags as Record<string, unknown>).demo === true)
      }
      const privacy = body?.data?.privacyUrl
      if (typeof privacy === "string" && /^https?:\/\//i.test(privacy)) setPrivacyUrl(privacy)
      loaded = true
    } catch {
      // An unreachable server is already loud everywhere else.
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

let orgLoaded = false
let orgInFlight: Promise<void> | null = null

/**
 * Load the SIGNED IN org's own name, once per session, and let it win over the
 * public branding name. `readOrg` is the caller's authenticated `GET /org`
 * (the store holds no api client of its own and must stay usable logged out).
 * A failure leaves the public name in place: this is a label, not a gate.
 */
export function ensureSignedInOrgNameLoaded(readOrg: () => Promise<unknown>): Promise<void> {
  if (orgLoaded) return Promise.resolve()
  if (orgInFlight) return orgInFlight
  orgInFlight = (async () => {
    try {
      const body = (await readOrg()) as {
        name?: unknown
        demo?: unknown
        data?: { name?: unknown; demo?: unknown }
      }
      const name = body?.data?.name ?? body?.name
      if (typeof name === "string" && name.trim().length > 0) setSignedInOrgName(name.trim())
      const demo = body?.data?.demo ?? body?.demo
      if (typeof demo === "boolean") setSignedInOrgDemo(demo)
      orgLoaded = true
    } catch {
      // Already loud elsewhere; the public name stands.
    } finally {
      orgInFlight = null
    }
  })()
  return orgInFlight
}

onSessionTeardown(() => {
  setPublicOrgName(null)
  setSignedInOrgName(null)
  setSignedInOrgDemo(null)
  orgInFlight = null
  orgLoaded = false
  inFlight = null
  loaded = false
  // NOT `setDemoMode(false)`: the deployment does not stop being the demo box
  // because somebody signed out, and the entry screen the logout lands on is
  // the one surface that most needs to know.
})

/** @internal - test isolation only */
export function _resetBranding(): void {
  setPublicOrgName(null)
  setSignedInOrgName(null)
  setSignedInOrgDemo(null)
  orgInFlight = null
  orgLoaded = false
  setDemoMode(false)
  setPrivacyUrl(null)
  inFlight = null
  loaded = false
}
