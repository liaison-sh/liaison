// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One build of this app runs against every Liaison, so nothing about a
// deployment is compiled in: the app asks which server it is talking to, saves
// the answer on the device, and reads that server's name, logo, flags and BYOK
// model list from the server itself at boot. This is the mobile port of the
// desktop shell's first launch (apps/desktop/src/onboarding/FirstLaunch.tsx and
// runtime-branding.ts); the contract with the API is identical, the storage is
// Capacitor Preferences instead of a file, and the UI is plain DOM because this
// code runs before the SolidJS app it precedes has mounted.
//
// Two rules carried over from the desktop side, both about the same threat: a
// `liaison://connect` link is attacker reachable, so its address is validated
// AND confirmed with a click, never applied on arrival; and a branding fetch
// that fails REJECTS rather than rendering a deployment called nothing.

// The address rule is shared with the web app's "Add a server" form, so the
// first launch and the settings take the same input (packages/shared).
import { isValidServerAddress, normalizeServerAddress } from "@liaison/shared/src/server-address"
import {
  DEEP_LINK_CONFIRM_PROMPT,
  FIRST_LAUNCH_CONNECT_ACTION,
  FIRST_LAUNCH_HELPER,
  FIRST_LAUNCH_INVALID_ADDRESS,
  FIRST_LAUNCH_PROMPT,
  FIRST_LAUNCH_UNREACHABLE,
} from "./mobile-copy"

export interface RuntimeBranding {
  orgName: string
  logoUrl: string | null
  flags: Record<string, boolean>
  byokModelIds: string[]
}

/** The public route, relative to whatever server address the user named. */
export const BRANDING_PATH = "/api/settings/branding"
/** The Preferences key the entered address is stored under. */
export const SERVER_ADDRESS_KEY = "liaison.serverAddress"

export { isValidServerAddress, normalizeServerAddress }

const CONNECT_LINK_PREFIX = "liaison://connect?"

export function isBranding(value: unknown): value is RuntimeBranding {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<RuntimeBranding>
  return (
    typeof candidate.orgName === "string" &&
    (candidate.logoUrl === null || typeof candidate.logoUrl === "string") &&
    !!candidate.flags &&
    typeof candidate.flags === "object" &&
    Array.isArray(candidate.byokModelIds)
  )
}

/**
 * How long a branding validation may hang before the prompt comes back.
 *
 * A request that FAILS re-renders the prompt saying why; a request that never
 * answers at all (a captive portal, a host that accepts the connection and
 * says nothing) used to leave the overlay on screen for the life of the page,
 * with no way to correct the address. So the wait is bounded like every other.
 */
export const BRANDING_TIMEOUT_MS = 8000

export async function fetchRuntimeBranding(
  serverAddress: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = BRANDING_TIMEOUT_MS,
): Promise<RuntimeBranding> {
  const base = serverAddress.replace(/\/+$/, "")
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let response: Response
  try {
    response = await Promise.race([
      fetchImpl(`${base}${BRANDING_PATH}`, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("branding request timed out"))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (!response.ok) {
    throw new Error(`branding request failed with status ${response.status}`)
  }
  const body = (await response.json()) as { data?: unknown }
  const data = body?.data
  if (!isBranding(data)) {
    throw new Error("branding response was not the documented shape")
  }
  return {
    orgName: data.orgName,
    logoUrl: data.logoUrl,
    flags: data.flags,
    byokModelIds: data.byokModelIds,
  }
}

/**
 * The server a `liaison://connect` link names, or null. Same rule as the
 * desktop handler: exactly one `server` parameter, an http(s) target, nothing
 * else, because the link arrives on behalf of whatever page asked for it.
 */
export function parseConnectLink(link: string): string | null {
  if (!link.startsWith(CONNECT_LINK_PREFIX)) return null
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== "liaison:" || url.host !== "connect" || url.hash !== "") return null
  const pairs = [...url.searchParams.entries()]
  if (pairs.length !== 1) return null
  const [name, server] = pairs[0]
  if (name !== "server") return null
  return isValidServerAddress(server) ? server : null
}

/** Names the page after the deployment, from the server, at boot. */
export function applyBranding(doc: Document, branding: RuntimeBranding): void {
  // Only the title. A visible element appended to <body> here was never
  // removed and sat under the app's tab bar with the org's name in it (seen on
  // the simulator, 2026-09-28): the web app draws its own branding.
  doc.getElementById("liaison-boot-brand")?.remove()
  doc.title = branding.orgName
}

/** Where the address lives between launches. Capacitor Preferences in the app. */
export interface AddressStorage {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
}

export interface FirstLaunchDependencies {
  storage: AddressStorage
  document: Document
  fetchImpl?: typeof fetch
}

export interface FirstLaunch {
  /**
   * Resolves with the server address once there is one that ANSWERS: the
   * stored one, or one the user confirms. Fetches and renders that server's
   * branding, and only then persists the address.
   *
   * There is no "change server" control: re-entering an address at this prompt
   * is how a stored one is replaced, and the prompt is shown whenever the
   * stored address cannot be reached, so a mistake is always recoverable
   * without reinstalling.
   */
  start: () => Promise<string>
  /**
   * The address ALREADY BOUND on this device, read from storage and nothing
   * else: no prompt, no branding round trip, no network at all.
   *
   * `start` cannot answer this question. It validates the address by fetching
   * that server's branding, so on a slow or unreachable network it resolves
   * late or never, and the boot sequence waits on it to settle the origin the
   * refresh token is presented to (main.ts). A relaunch offline then refreshed
   * with no header, the server answered 401, and the app showed the login
   * screen with a live session in storage. The binding is what storage says;
   * the branding fetch is a validation of it, so it is read separately here.
   */
  boundAddress: () => Promise<string | null>
  /** Offers an address from a connect deep link. Prefills, never applies. */
  offerAddress: (serverAddress: string) => void
}

/** The overlay's element id. Exported because the tests assert on the artifact. */
export const FIRST_LAUNCH_ID = "liaison-first-launch"
const INPUT_ID = "liaison-mobile-server-address"

export function createFirstLaunch(deps: FirstLaunchDependencies): FirstLaunch {
  const doc = deps.document
  let prefill: ((serverAddress: string) => void) | null = null
  let offered: string | null = null

  const renderPrompt = (resolve: (address: string) => void, notice?: string): void => {
    const section = doc.createElement("section")
    section.id = FIRST_LAUNCH_ID
    section.setAttribute("role", "dialog")
    // A TOP LAYER overlay on documentElement, not a block appended to body.
    // The wrapped app mounts into body milliseconds after this script runs and
    // owns the viewport: measured on a booted simulator, a plain section here
    // was simply never seen. The desktop shell's overlay is the same shape.
    section.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:flex",
      "flex-direction:column",
      "gap:12px",
      "justify-content:center",
      "padding:24px",
      // The status bar and the home indicator are not ours to draw under.
      "padding-top:calc(24px + env(safe-area-inset-top))",
      "padding-bottom:calc(24px + env(safe-area-inset-bottom))",
      // The same backdrop, card and colours as the sign-in screen that follows.
      "align-items:center",
      "background:#e5e6ea",
      "color:#1f2937",
      "font:15px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif",
    ].join(";")

    const label = doc.createElement("label")
    label.setAttribute("for", INPUT_ID)
    label.textContent = FIRST_LAUNCH_PROMPT

    const input = doc.createElement("input")
    input.id = INPUT_ID
    input.setAttribute("type", "url")
    input.setAttribute("inputmode", "url")
    input.setAttribute("autocapitalize", "none")
    input.setAttribute("autocorrect", "off")
    input.setAttribute("spellcheck", "false")
    input.setAttribute("placeholder", "liaison.example.com")

    const helper = doc.createElement("p")
    helper.textContent = FIRST_LAUNCH_HELPER

    const alert = doc.createElement("p")
    alert.setAttribute("role", "alert")
    alert.hidden = notice === undefined
    if (notice !== undefined) alert.textContent = notice

    const confirm = doc.createElement("p")
    confirm.textContent = DEEP_LINK_CONFIRM_PROMPT
    confirm.hidden = true

    const button = doc.createElement("button")
    button.setAttribute("type", "button")
    button.textContent = FIRST_LAUNCH_CONNECT_ACTION
    button.addEventListener("click", () => {
      const candidate = normalizeServerAddress(input.value)
      if (!isValidServerAddress(candidate)) {
        alert.textContent = FIRST_LAUNCH_INVALID_ADDRESS
        alert.hidden = false
        return
      }
      alert.hidden = true
      section.remove()
      resolve(candidate)
    })

    const card = doc.createElement("div")
    card.style.cssText = [
      "width:100%",
      "max-width:360px",
      "box-sizing:border-box",
      "display:flex",
      "flex-direction:column",
      "gap:12px",
      "padding:24px",
      "background:#f7f7f9",
      "border:1px solid #dcdde2",
      "border-radius:14px",
    ].join(";")
    const brand = doc.createElement("div")
    brand.textContent = "Liaison"
    brand.style.cssText = "font-size:22px;font-weight:700;text-align:center;margin-bottom:4px"
    label.style.cssText = "font-size:13px;font-weight:600"
    helper.style.cssText = "margin:0;font-size:13px;color:#6b7280"
    alert.style.cssText = "margin:0;font-size:13px;color:#b42318"
    confirm.style.cssText = "margin:0;font-size:13px"
    // 16px, never the card's inherited 15px: iOS zooms the page on focus into
    // a field under 16px, and Capacitor then DISABLES the pinch gesture the
    // moment a zoom begins (WebViewDelegationHandler), so the zoom can never be
    // undone and every screen after sign-in stayed ~7% too large, cut off on
    // the right and at the tab bar.
    input.style.cssText =
      "font:inherit;font-size:16px;padding:12px;border:1px solid #d1d5db;border-radius:8px;background:#ffffff;color:#111827"
    // 44 points is the smallest control a thumb reliably hits.
    button.style.cssText =
      "font:inherit;font-weight:600;min-height:44px;padding:12px;border:0;border-radius:8px;" +
      "background:#3f4a63;color:#ffffff"

    card.append(brand, label, input, helper, confirm, alert, button)
    section.append(card)
    doc.documentElement.appendChild(section)

    prefill = (serverAddress: string) => {
      // Shown and waiting for the click. The link decides nothing.
      input.value = serverAddress
      confirm.hidden = false
    }
    if (offered !== null) prefill(offered)
  }

  return {
    async boundAddress(): Promise<string | null> {
      const stored = await deps.storage.get(SERVER_ADDRESS_KEY)
      return stored && isValidServerAddress(stored) ? stored : null
    },
    offerAddress(serverAddress: string): void {
      if (!isValidServerAddress(serverAddress)) return
      offered = serverAddress
      prefill?.(serverAddress)
    },
    async start(): Promise<string> {
      const stored = await deps.storage.get(SERVER_ADDRESS_KEY)
      let candidate = stored && isValidServerAddress(stored) ? stored : null
      let notice: string | undefined
      // AN ADDRESS IS ONLY GOOD ONCE THE SERVER BEHIND IT ANSWERS. Persisting
      // it first stored an address the app could never use, and the prompt had
      // already resolved, so it never came back: the install was pointed at
      // nothing until it was deleted. So the fetch is the gate, and a failure
      // renders the prompt AGAIN, saying why.
      for (;;) {
        if (candidate === null) {
          candidate = await new Promise<string>((resolve) => renderPrompt(resolve, notice))
        }
        let branding: RuntimeBranding
        try {
          branding = await fetchRuntimeBranding(candidate, deps.fetchImpl)
        } catch {
          notice = FIRST_LAUNCH_UNREACHABLE
          candidate = null
          continue
        }
        if (candidate !== stored) await deps.storage.set(SERVER_ADDRESS_KEY, candidate)
        applyBranding(doc, branding)
        return candidate
      }
    },
  }
}
