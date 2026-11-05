// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app's own native plugin, `LiaisonNative`, compiled into the iOS App
// target (ios/App/App/LiaisonNativePlugin.swift) and registered by
// MainViewController. Two things only native code can do:
//
// - apsEnvironment: which APNs host this build's push tokens belong to. It is
//   read from the provisioning profile the build was signed with, so a debug
//   build from Xcode says `sandbox` and a TestFlight or App Store build (which
//   carries no profile file) says `production`. The server sends each token to
//   the host it names.
// - authenticate: a web sign in through ASWebAuthenticationSession, whose
//   callback URL comes back to this call only, never through the system wide
//   scheme dispatch.
// - the foreground push presentation: iOS asks the app how to present a push
//   that lands while it is open, and ForegroundPushPresenter.swift answers
//   (the system banner, or nothing for the conversation on screen). It needs
//   the conversation on screen (setThreadOnScreen) and reports each decision
//   (`pushPresentation`) so the push client can post it as the receipt.
//
// Android has no such plugin: its one native piece is `authenticate`, from a
// plugin of its own (`LiaisonAuthSession`, android/app/src/main/java/sh/
// liaison/mobile/LiaisonAuthSessionPlugin.java), which runs the page in the
// system browser and resolves the `liaison://` link the browser hands back.
//
// Everywhere neither plugin is registered (the web, tests) every function
// resolves null or does nothing, and the caller keeps its non native path.

import { Capacitor, registerPlugin } from "@capacitor/core"

export type ApsEnvironment = "sandbox" | "production"

export interface AuthenticateOptions {
  /** The page the session opens. */
  url: string
  /** The scheme whose redirect ends the session, without "://". */
  callbackScheme: string
}

/** The plugin as the native side declares it. */
export interface LiaisonNativePlugin {
  apsEnvironment: () => Promise<{ environment: string }>
  authenticate: (options: AuthenticateOptions) => Promise<{ url: string }>
  setThreadOnScreen: (options: { threadId: string | null }) => Promise<void>
  addListener: (event: "pushPresentation", handler: (event: unknown) => void) => unknown
}

/** Android's browser-backed session (LiaisonAuthSessionPlugin.java). */
export interface AuthSessionPlugin {
  authenticate: (options: AuthenticateOptions) => Promise<{ url: string }>
}

export interface LiaisonNative {
  apsEnvironment: () => Promise<ApsEnvironment | null>
  /**
   * Resolves the callback URL, null without the plugin. Rejects with an Error
   * whose `code` is "cancelled" when the user closes the sheet.
   */
  authenticate: (options: AuthenticateOptions) => Promise<string | null>
  /** Tells the native presenter which conversation is on screen. */
  setThreadOnScreen: (threadId: string | null) => void
  /** Each foreground presentation the native presenter decided. */
  onPushPresentation: (handler: (event: unknown) => void) => void
}

const PLUGIN_NAME = "LiaisonNative"
/** The Android plugin's name, as LiaisonAuthSessionPlugin.java declares it. */
export const AUTH_SESSION_PLUGIN_NAME = "LiaisonAuthSession"

function normaliseEnvironment(raw: string): ApsEnvironment | null {
  // The profile's own word for the sandbox is `development`.
  if (raw === "sandbox" || raw === "development") return "sandbox"
  if (raw === "production") return "production"
  return null
}

export function createLiaisonNative(deps: {
  available: () => boolean
  plugin: LiaisonNativePlugin
  /** Android's session, used where the iOS plugin is absent. */
  authSession?: { available: () => boolean; plugin: AuthSessionPlugin }
}): LiaisonNative {
  const session = (): Pick<AuthSessionPlugin, "authenticate"> | null => {
    if (deps.available()) return deps.plugin
    if (deps.authSession?.available()) return deps.authSession.plugin
    return null
  }
  return {
    apsEnvironment: async () => {
      if (!deps.available()) return null
      const { environment } = await deps.plugin.apsEnvironment()
      return normaliseEnvironment(environment)
    },
    authenticate: async (options) => {
      const plugin = session()
      if (!plugin) return null
      try {
        const { url } = await plugin.authenticate({
          url: options.url,
          callbackScheme: options.callbackScheme,
        })
        return url
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (code === "cancelled") {
          const message = error instanceof Error ? error.message : "cancelled"
          throw Object.assign(new Error(message), { code: "cancelled" as const })
        }
        throw error
      }
    },
    setThreadOnScreen: (threadId) => {
      if (!deps.available()) return
      void deps.plugin.setThreadOnScreen({ threadId }).catch(() => undefined)
    },
    onPushPresentation: (handler) => {
      if (!deps.available()) return
      void deps.plugin.addListener("pushPresentation", handler)
    },
  }
}

/**
 * The one proxy for the plugin. Capacitor refuses a second registration of the
 * same name, so other faces of the plugin (native/receipt-store.ts) share it.
 */
const pluginProxy = registerPlugin<LiaisonNativePlugin>(PLUGIN_NAME)

/** Whether the plugin is compiled into this build (iOS only). */
export function liaisonNativeAvailable(): boolean {
  return Capacitor.isPluginAvailable(PLUGIN_NAME)
}

/** The shared proxy, typed as the caller's slice of the native methods. */
export function liaisonNativeProxy<T>(): T {
  return pluginProxy as unknown as T
}

const authSessionProxy = registerPlugin<AuthSessionPlugin>(AUTH_SESSION_PLUGIN_NAME)

const native = createLiaisonNative({
  available: liaisonNativeAvailable,
  plugin: pluginProxy,
  authSession: {
    available: () => Capacitor.isPluginAvailable(AUTH_SESSION_PLUGIN_NAME),
    plugin: authSessionProxy,
  },
})

/** This build's APNs environment, null where there is no native plugin. */
export function apsEnvironment(): Promise<ApsEnvironment | null> {
  return native.apsEnvironment()
}

/**
 * Runs `url` in ASWebAuthenticationSession (iOS) or the system browser
 * (Android) and resolves the callback URL, null where there is no native
 * plugin. Throws an Error with `code` "cancelled" when the user dismisses the
 * sheet or comes back without finishing.
 */
export function authenticate(options: AuthenticateOptions): Promise<string | null> {
  return native.authenticate(options)
}

/** Tells the native presenter the conversation on screen. Nothing off iOS. */
export function nativeThreadOnScreen(threadId: string | null): void {
  native.setThreadOnScreen(threadId)
}

/**
 * Subscribes to the native presenter's decisions: `{outcome, reason?, data}`,
 * `data` being the push payload. Nothing off iOS.
 */
export function onPushPresentation(handler: (event: unknown) => void): void {
  native.onPushPresentation(handler)
}
