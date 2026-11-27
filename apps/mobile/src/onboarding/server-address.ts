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
import {
  cloudPageUrl,
  workspaceAddress,
  workspaceSlugFromAddress,
  workspaceSlugFromInput,
} from "@liaison/shared/src/cloud-workspace"
import { isValidServerAddress, normalizeServerAddress } from "@liaison/shared/src/server-address"
import { type FirstLaunchCopy, firstLaunchCopy } from "./mobile-copy"

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

/** When the branding of a stored server that did not answer at launch is asked for again. */
export const BRANDING_RETRY_MS = 60_000

/**
 * The server did not answer at all: no network, a timeout, or a gateway in
 * front of it that is up while the server behind it is not (5xx). Not the
 * same as an answer that says "no Liaison here" (a 404, a page that is not
 * the branding shape), which is about the ADDRESS.
 */
export class BrandingUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrandingUnreachableError"
  }
}

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
          reject(new BrandingUnreachableError("branding request timed out"))
        }, timeoutMs)
      }),
    ])
  } catch (err) {
    if (err instanceof BrandingUnreachableError) throw err
    // fetch rejects only when no answer came back at all.
    throw new BrandingUnreachableError(`branding request failed: ${String(err)}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (response.status >= 500) {
    throw new BrandingUnreachableError(`branding request failed with status ${response.status}`)
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
  /**
   * The cloud whose workspaces the first screen asks for (`acme` becomes
   * `https://acme.<domain>`), or null for no Cloud screen: the address field
   * is then the first screen, as it was. boot-entry.ts passes the build's
   * value (packages/shared/src/cloud-workspace.ts).
   */
  cloudDomain?: string | null
  /** The language the screen speaks. Defaults to the webview's own. */
  language?: string
  /** Opens a page of the cloud in the system browser. */
  openUrl?: (url: string) => void
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

/** The Cloud screen's field. Exported for the tests. */
export const CLOUD_INPUT_ID = "liaison-mobile-cloud-workspace"

type PromptMode = "cloud" | "address"

const LINK_STYLE =
  "font:inherit;font-size:13px;min-height:44px;padding:0 4px;border:0;background:transparent;" +
  "color:var(--fl-link);text-decoration:underline;cursor:pointer"

/** The palette's element id. Exported for the tests. */
export const FIRST_LAUNCH_STYLE_ID = "liaison-first-launch-style"

/**
 * The screen's colours, light and dark. It follows the device's appearance
 * like the app after it: a light screen under a dark device's status bar left
 * the clock and battery white on near white, and the bar's style is the web
 * app's to set (native/status-bar.ts), not this screen's.
 */
const FIRST_LAUNCH_PALETTE = `#${FIRST_LAUNCH_ID}{color-scheme:light;--fl-bg:#e5e6ea;--fl-text:#1f2937;--fl-card:#f7f7f9;--fl-card-border:#dcdde2;--fl-muted:#6b7280;--fl-field:#ffffff;--fl-field-border:#d1d5db;--fl-field-text:#111827;--fl-link:#3f4a63;--fl-button:#3f4a63;--fl-button-text:#ffffff;--fl-alert:#b42318}
@media (prefers-color-scheme: dark){#${FIRST_LAUNCH_ID}{color-scheme:dark;--fl-bg:#111113;--fl-text:#e5e7eb;--fl-card:#1b1b1e;--fl-card-border:#2c2c31;--fl-muted:#9ca3af;--fl-field:#232327;--fl-field-border:#3a3a41;--fl-field-text:#f3f4f6;--fl-link:#c3c9de;--fl-button:#5a6688;--fl-button-text:#ffffff;--fl-alert:#f97066}}`

export function createFirstLaunch(deps: FirstLaunchDependencies): FirstLaunch {
  const doc = deps.document
  const cloudDomain = deps.cloudDomain ?? null
  const language = deps.language ?? doc.defaultView?.navigator?.language ?? "en"
  const copy: FirstLaunchCopy = firstLaunchCopy(language)
  const openUrl =
    deps.openUrl ??
    ((url: string) => {
      // A target=_blank open leaves the app: the native shell hands it to the
      // system browser rather than navigating this webview away.
      doc.defaultView?.open(url, "_blank", "noopener")
    })
  let mode: PromptMode = cloudDomain ? "cloud" : "address"
  let prefill: ((serverAddress: string) => void) | null = null
  let offered: string | null = null
  /** The prompt on screen, so a deep link or a switch can redraw it. */
  let showing: { section: HTMLElement; resolve: (address: string) => void } | null = null

  const modeFor = (serverAddress: string): PromptMode =>
    cloudDomain && workspaceSlugFromAddress(serverAddress, cloudDomain) ? "cloud" : "address"

  const switchTo = (next: PromptMode): void => {
    if (!showing) return
    const { section, resolve } = showing
    section.remove()
    showing = null
    mode = next
    renderPrompt(resolve)
  }

  const linkButton = (text: string, testId: string, onClick: () => void): HTMLButtonElement => {
    const link = doc.createElement("button")
    link.setAttribute("type", "button")
    link.setAttribute("data-testid", testId)
    link.textContent = text
    link.style.cssText = LINK_STYLE
    link.addEventListener("click", onClick)
    return link
  }

  const renderPrompt = (resolve: (address: string) => void, notice?: string): void => {
    const section = doc.createElement("section")
    section.id = FIRST_LAUNCH_ID
    section.setAttribute("role", "dialog")
    section.setAttribute(
      "data-testid",
      mode === "cloud" ? "first-launch-cloud" : "first-launch-address",
    )
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
      // The card is centred by its own auto margins, not by the column: a
      // column centred with `justify-content` cannot scroll back up to what
      // overflows above it. And it MUST scroll: with the keyboard up (a phone
      // in landscape, or a short one) the links under the field were out of
      // reach on a page that could not move.
      "justify-content:flex-start",
      "overflow-y:auto",
      "-webkit-overflow-scrolling:touch",
      "padding:24px",
      // The status bar and the home indicator are not ours to draw under.
      "padding-top:calc(24px + env(safe-area-inset-top))",
      // The keyboard covers the bottom of the page (the web app publishes its
      // height as --keyboard-inset, apps/web primitives/keyboardInset.ts),
      // so the page can scroll its last link above it.
      "padding-bottom:calc(24px + max(env(safe-area-inset-bottom), var(--keyboard-inset, 0px)))",
      // The same backdrop, card and colours as the sign-in screen that follows.
      "align-items:center",
      "background:var(--fl-bg)",
      "color:var(--fl-text)",
      "font:15px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif",
    ].join(";")

    const cloud = mode === "cloud" && cloudDomain !== null
    const inputId = cloud ? CLOUD_INPUT_ID : INPUT_ID

    const label = doc.createElement("label")
    label.setAttribute("for", inputId)
    label.textContent = cloud ? copy.cloudWorkspaceLabel : copy.addressPrompt

    const input = doc.createElement("input")
    input.id = inputId
    input.setAttribute(
      "data-testid",
      cloud ? "first-launch-workspace" : "first-launch-address-input",
    )
    input.setAttribute("type", cloud ? "text" : "url")
    input.setAttribute("inputmode", cloud ? "text" : "url")
    input.setAttribute("autocapitalize", "none")
    input.setAttribute("autocorrect", "off")
    input.setAttribute("spellcheck", "false")
    input.setAttribute("placeholder", cloud ? copy.cloudPlaceholder : "liaison.example.com")

    const helper = doc.createElement("p")
    helper.textContent = cloud ? copy.cloudPrompt : copy.addressHelper

    const alert = doc.createElement("p")
    alert.setAttribute("role", "alert")
    alert.hidden = notice === undefined
    if (notice !== undefined) alert.textContent = notice

    const confirm = doc.createElement("p")
    confirm.textContent = cloud ? copy.cloudDeepLinkConfirm : copy.deepLinkConfirm
    confirm.hidden = true

    const button = doc.createElement("button")
    button.setAttribute("type", "button")
    button.setAttribute("data-testid", "first-launch-submit")
    button.textContent = cloud ? copy.cloudAction : copy.connectAction
    button.addEventListener("click", () => {
      let candidate: string
      if (cloud) {
        const slug = workspaceSlugFromInput(input.value, cloudDomain)
        if (slug === null) {
          alert.textContent = copy.cloudInvalid
          alert.hidden = false
          return
        }
        candidate = workspaceAddress(slug, cloudDomain)
      } else {
        candidate = normalizeServerAddress(input.value)
        if (!isValidServerAddress(candidate)) {
          alert.textContent = copy.addressInvalid
          alert.hidden = false
          return
        }
      }
      alert.hidden = true
      section.remove()
      showing = null
      resolve(candidate)
    })

    const card = doc.createElement("div")
    card.style.cssText = [
      "width:100%",
      "max-width:360px",
      "margin:auto 0",
      "flex-shrink:0",
      "box-sizing:border-box",
      "display:flex",
      "flex-direction:column",
      "gap:12px",
      "padding:24px",
      "background:var(--fl-card)",
      "border:1px solid var(--fl-card-border)",
      "border-radius:14px",
    ].join(";")
    const brand = doc.createElement("div")
    brand.textContent = "Liaison"
    brand.style.cssText = "font-size:22px;font-weight:700;text-align:center;margin-bottom:4px"
    label.style.cssText = "font-size:13px;font-weight:600"
    helper.style.cssText = "margin:0;font-size:13px;color:var(--fl-muted)"
    alert.style.cssText = "margin:0;font-size:13px;color:var(--fl-alert)"
    confirm.style.cssText = "margin:0;font-size:13px"
    // 16px, never the card's inherited 15px: iOS zooms the page on focus into
    // a field under 16px, and Capacitor then DISABLES the pinch gesture the
    // moment a zoom begins (WebViewDelegationHandler), so the zoom can never be
    // undone and every screen after sign-in stayed ~7% too large, cut off on
    // the right and at the tab bar.
    const fieldStyle =
      "font:inherit;font-size:16px;padding:12px;border:1px solid var(--fl-field-border);border-radius:8px;background:var(--fl-field);color:var(--fl-field-text)"
    input.style.cssText = fieldStyle
    // 44 points is the smallest control a thumb reliably hits.
    button.style.cssText =
      "font:inherit;font-weight:600;min-height:44px;padding:12px;border:0;border-radius:8px;" +
      "background:var(--fl-button);color:var(--fl-button-text)"

    if (cloud) {
      // The name, then the fixed domain it lives under, in one bordered field.
      const row = doc.createElement("div")
      row.style.cssText =
        "display:flex;align-items:center;border:1px solid var(--fl-field-border);border-radius:8px;background:var(--fl-field);overflow:hidden"
      input.style.cssText =
        "font:inherit;font-size:16px;padding:12px;border:0;background:transparent;color:var(--fl-field-text);flex:1;min-width:0;outline:none"
      const suffix = doc.createElement("span")
      suffix.setAttribute("data-testid", "first-launch-workspace-suffix")
      suffix.textContent = `.${cloudDomain}`
      suffix.style.cssText =
        "font-size:16px;color:var(--fl-muted);padding:0 12px 0 0;white-space:nowrap"
      row.append(input, suffix)
      const links = doc.createElement("div")
      links.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:0"
      links.append(
        linkButton(copy.cloudForgot, "first-launch-forgot", () =>
          openUrl(cloudPageUrl(cloudDomain, "login", language)),
        ),
        linkButton(copy.cloudSelfHosted, "first-launch-self-hosted", () => switchTo("address")),
      )
      card.append(brand, helper, label, row, confirm, alert, button, links)
    } else {
      card.append(brand, label, input, helper, confirm, alert, button)
      if (cloudDomain !== null) {
        card.append(linkButton(copy.useCloud, "first-launch-use-cloud", () => switchTo("cloud")))
      }
    }
    const palette = doc.createElement("style")
    palette.id = FIRST_LAUNCH_STYLE_ID
    palette.textContent = FIRST_LAUNCH_PALETTE
    section.append(palette, card)
    doc.documentElement.appendChild(section)
    showing = { section, resolve }

    prefill = (serverAddress: string) => {
      // Shown and waiting for the click. The link decides nothing.
      input.value = cloud
        ? (workspaceSlugFromAddress(serverAddress, cloudDomain) ?? serverAddress)
        : serverAddress
      confirm.hidden = false
    }
    if (offered !== null && modeFor(offered) === mode) prefill(offered)
  }

  /** The title, once the server answers again: when the device is back online, or in a minute. */
  const retryBrandingWhenOnline = (address: string): void => {
    const view = doc.defaultView
    let done = false
    const retry = (): void => {
      if (done) return
      void fetchRuntimeBranding(address, deps.fetchImpl)
        .then((branding) => {
          done = true
          applyBranding(doc, branding)
        })
        .catch(() => {})
    }
    view?.addEventListener("online", retry)
    view?.setTimeout(retry, BRANDING_RETRY_MS)
  }

  return {
    async boundAddress(): Promise<string | null> {
      const stored = await deps.storage.get(SERVER_ADDRESS_KEY)
      return stored && isValidServerAddress(stored) ? stored : null
    },
    offerAddress(serverAddress: string): void {
      if (!isValidServerAddress(serverAddress)) return
      offered = serverAddress
      const wanted = modeFor(serverAddress)
      if (showing && wanted !== mode) {
        switchTo(wanted)
        return
      }
      mode = wanted
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
        } catch (err) {
          // THE STORED SERVER IS DOWN, NOT GONE. A signed-in phone launched
          // offline (or while its server restarts) used to land on the first
          // launch screen saying the workspace was not found, which read as a
          // sign-out, and stayed over the app once the server came back. The
          // address was good when it was stored, so it is kept: the app opens
          // signed in and says it is offline (its own connection banner), and
          // the branding follows once the server answers. Only an answer that
          // says the address is wrong brings the prompt back.
          if (candidate === stored && err instanceof BrandingUnreachableError) {
            retryBrandingWhenOnline(candidate)
            return candidate
          }
          notice = mode === "cloud" ? copy.cloudNotFound : copy.addressUnreachable
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
