// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH APP IS ASKING, AND WHETHER THE SERVER STILL SUPPORTS IT.
//
// A desktop or phone app carries its own web build and updates through its own
// channel, so a server can move past it. The server publishes the oldest
// version of each app it supports (`GET /api/client-policy`, public); the app
// asks once after it connects and, when it is older than that, shows one calm
// notice (modules/shell/ClientVersionNotice.tsx).
//
// Once the server has answered, the app also names itself on its requests:
// `X-Liaison-Client: <desktop|ios|android>/<version>`, on the API client and
// the websocket ticket exchange. ONLY once it has answered: a server older
// than the policy does not list that header among the ones its CORS allows,
// and a request carrying it would be refused before it left the app. The
// header is a label for the server's logs, never a credential.
//
// A browser tab never asks and never sends it: it always runs the server's own
// build.

import { createSignal } from "solid-js"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { apiUrl } from "~/lib/env"
import { nativeBridge } from "~/lib/native-bridge"

export const CLIENT_HEADER = "X-Liaison-Client"
export const CLIENT_POLICY_PATH = "/client-policy"

export type ClientPlatform = "desktop" | "ios" | "android"

/** The app around the page: which one, and its own version. */
export interface ShellClient {
  platform: ClientPlatform
  version: string
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

function parts(version: string): [number, number, number] | null {
  const match = VERSION.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a) ?? [0, 0, 0]
  const right = parts(b) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

export interface ClientPolicyEnv {
  /** The app around the page, or null in a browser. */
  client: () => Promise<ShellClient | null>
  /** The server's policy request. */
  fetchPolicy: () => Promise<Response>
}

export interface ClientPolicy {
  /** Asks the server once; later calls share the first answer. Never throws. */
  start: () => Promise<void>
  /** The header value, or null until (and unless) the server answered. Reactive. */
  header: () => string | null
  /** The app's platform when it is older than the server supports, else null. Reactive. */
  belowMinimum: () => ClientPlatform | null
}

export function createClientPolicy(env: ClientPolicyEnv): ClientPolicy {
  const [header, setHeader] = createSignal<string | null>(null)
  const [below, setBelow] = createSignal<ClientPlatform | null>(null)
  let started: Promise<void> | null = null

  async function run(): Promise<void> {
    try {
      const client = await env.client()
      if (client === null || parts(client.version) === null) return
      const response = await env.fetchPolicy()
      if (!response.ok) return
      const body = (await response.json()) as { data?: Record<string, unknown> } | null
      const minimum = body?.data?.[client.platform]
      if (typeof minimum !== "string" || parts(minimum) === null) return
      setHeader(`${client.platform}/${client.version}`)
      if (compareVersions(client.version, minimum) < 0) setBelow(client.platform)
    } catch {
      // No answer (an older server, no network): no header and no notice.
    }
  }

  return {
    start() {
      started ??= run()
      return started
    },
    header,
    belowMinimum: below,
  }
}

/** The app around this page and its version, from the shell's own bridge. */
export async function shellClient(): Promise<ShellClient | null> {
  const desktop = getDesktopBridge()
  if (desktop !== null) {
    const appVersion = desktop.appVersion
    if (typeof appVersion !== "function") return null
    return { platform: "desktop", version: await appVersion() }
  }
  const phone = nativeBridge()?.clientVersion
  if (typeof phone !== "function") return null
  return await phone()
}

let page: ClientPolicy | null = null

function pagePolicy(): ClientPolicy {
  page ??= createClientPolicy({
    client: shellClient,
    fetchPolicy: () => fetch(apiUrl(CLIENT_POLICY_PATH), { credentials: "omit" }),
  })
  return page
}

/** Asks the server for its client policy, once per page (index.tsx). */
export function startClientPolicy(): Promise<void> {
  page = null
  return pagePolicy().start()
}

/** The page's policy, for the notice. */
export function clientPolicy(): ClientPolicy {
  return pagePolicy()
}

/** The headers naming this app, empty in a browser or before the server answered. */
export function clientHeaders(): Record<string, string> {
  const value = page?.header() ?? null
  return value === null ? {} : { [CLIENT_HEADER]: value }
}
