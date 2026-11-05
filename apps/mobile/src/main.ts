// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mobile boot entry. It is bundled to one classic script and injected into
// the SYNCED copy of apps/web's index.html (scripts/boot-injection.ts), so it
// runs before the web app's own module entry and can do the thing that has to
// happen first: subscribe to `appUrlOpen`. The operating system hands the app
// a deep link as part of LAUNCHING it, so a listener wired up any later drops
// exactly the link a push tap depends on.
//
// It also settles the server address and fetches that server's branding, since
// the app is one build for every fork and nothing about a deployment is baked
// in (onboarding/server-address.ts).
//
// Everything the boot sequence touches is injected, because the sequence
// itself is what the cold start test pins: the subscription happens before the
// app-ready wiring, and the queue releases nothing until the app can route.

import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage"
import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { Preferences } from "@capacitor/preferences"
import { PushNotifications } from "@capacitor/push-notifications"
import {
  type AccessTokenStore,
  createAccessTokenStore,
  type RefreshTokenStore,
} from "./auth/refresh-bridge"
import {
  createSecretRoutedStore,
  type SecretRoutedStore,
  secureStorageStringStore,
} from "./auth/secret-store"
import {
  clearMirroredServerAddress,
  mirrorServerAddress,
  publishServerAddress,
  SERVER_ADDRESS_GLOBAL,
  type SyncStorage,
  serverAddressOrigin,
} from "./boot/server-global"
import { type DeepLinkQueue, deepLinkQueue } from "./deep-link"
import { apsEnvironment, liaisonNativeAvailable, onPushPresentation } from "./native/liaison-native"
import { nativeReceiptStore } from "./native/receipt-store"
import { threadOnScreen } from "./native/thread-on-screen"
import {
  type AddressStorage,
  type FirstLaunch,
  parseConnectLink,
} from "./onboarding/server-address"
import {
  armPushRegistration,
  createPushClient,
  createStoredServerAddress,
  type PushClientDependencies,
  type PushPlugin,
} from "./push-client"
import { createReceiptClient, type ReceiptClient } from "./receipts"
import { createServerList, type KeyValueStore, type ServerList } from "./servers/server-list"

export interface BootDependencies {
  /** Where links arriving before the app can route are held. */
  queue: DeepLinkQueue
  /** Subscribes to the native URL events. */
  addUrlListener: (handler: (url: string) => void) => void
  /** Calls back once the wrapped app's router is live. */
  whenAppReady: (handler: () => void) => void
  /**
   * The first launch flow, when there is one. A `liaison://connect` link is
   * offered to it rather than routed: it repoints the whole install, so it is
   * confirmed with a click.
   */
  firstLaunch?: FirstLaunch
  /**
   * Reloads the page. Called ONCE, and only when the app started with no
   * server address at all (a first launch, or a webview whose storage was
   * cleared): apps/web reads the global while its modules load, so a route
   * that already resolved against nothing stays resolved against nothing.
   * With the address now mirrored, the reload starts the app against the
   * right server in the same tick as the boot script.
   */
  reload?: () => void
  /**
   * Installs the refresh-token bridge on the page, synchronously, before
   * anything else this sequence does (auth/refresh-bridge.ts).
   */
  attachBridge?: () => void
  /**
   * Push registration, handed the address first launch settled. It runs AFTER
   * that address exists, because the permission prompt is asked once per
   * install and a prompt on a screen that cannot say which server is asking is
   * a prompt the user refuses.
   */
  startPush?: (serverAddress: string) => Promise<void>
  /**
   * Where the synchronous hint lives. The webview's localStorage in the app;
   * a test hands in its own so a poisoned hint can be written by hand.
   */
  mirrorStorage?: SyncStorage
  /**
   * Files what a build before the saved server list kept (one address, one
   * refresh token) under that server, BEFORE the bound origin is settled: the
   * refresh the wrapped app fires in its first tick reads its token under that
   * origin, and must find it there (servers/server-list.ts).
   */
  migrate?: () => Promise<void>
  /**
   * Makes sure the page's storage is the settled server's, and starts the page
   * again when it was not (servers/server-list.ts). Answers whether it did.
   */
  reconcileStorage?: (serverAddress: string) => Promise<boolean>
}

/** Subscribes to the platform's URL events through Capacitor. */
export function capacitorUrlListener(handler: (url: string) => void): void {
  void App.addListener("appUrlOpen", (event: { url: string }) => handler(event.url))
}

/**
 * The wrapped app's entry is a deferred module: it runs after this script and
 * before `DOMContentLoaded`, so that event is the first moment a route exists.
 */
export function domReady(handler: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handler, { once: true })
    return
  }
  handler()
}

/** Capacitor Preferences, behind the storage shape first launch asks for. */
export const preferencesStorage: AddressStorage = {
  get: async (key: string) => (await Preferences.get({ key })).value,
  set: async (key: string, value: string) => {
    await Preferences.set({ key, value })
  },
}

/**
 * The one access-token store for this page: the bridge publishes into it, the
 * push client reads from it, and nothing else ever holds a bearer. In memory
 * only, and it dies with the webview.
 */
export const accessTokenStore: AccessTokenStore = createAccessTokenStore()

/**
 * WHAT THE SHELL UNDOES WHEN THE SESSION ENDS.
 *
 * The wrapped app signs out by posting /api/auth/logout, and the shell has a
 * registration of its own behind that session (the push row for this handset).
 * The bridge runs these while the bearer is still in the store, because the
 * call that revokes the row is authenticated with it (auth/refresh-bridge.ts).
 *
 * A set rather than one slot: the push client is registered when push is
 * armed, which is later than the bridge is attached and may not happen at all.
 */
const sessionEndHandlers = new Set<() => Promise<void>>()

export function onSessionEnd(handler: () => Promise<void>): () => void {
  sessionEndHandlers.add(handler)
  return () => {
    sessionEndHandlers.delete(handler)
  }
}

export async function runSessionEndHandlers(): Promise<void> {
  for (const handler of [...sessionEndHandlers]) {
    try {
      await handler()
    } catch {
      // One handler's failure is not the sign-out's.
    }
  }
}

/** Preferences, behind the three calls the saved server list needs. */
export const preferencesKeyValueStore: KeyValueStore & { keys: () => Promise<string[]> } = {
  get: async (key: string) => (await Preferences.get({ key })).value,
  set: async (key: string, value: string) => {
    await Preferences.set({ key, value })
  },
  remove: async (key: string) => {
    await Preferences.remove({ key })
  },
  keys: async () => (await Preferences.keys()).keys,
}

/**
 * What the saved server list files under: the refresh tokens in the OS secret
 * store (the keychain, the Android Keystore), the rest in Preferences
 * (auth/secret-store.ts). The web build has no secret store and keeps all of
 * it in Preferences.
 */
export const deviceKeyValueStore: SecretRoutedStore = createSecretRoutedStore({
  plain: preferencesKeyValueStore,
  secret: Capacitor.isNativePlatform()
    ? secureStorageStringStore(SecureStorage, KeychainAccess.afterFirstUnlockThisDeviceOnly)
    : null,
})

/** The servers this phone knows (servers/server-list.ts). */
export const serverList: ServerList = createServerList({
  store: deviceKeyValueStore,
  fetchImpl: (input, init) => fetch(input, init),
  // A removed server is told which device signs out, so it drops this
  // phone's push row too, and the receipt credential filed for it goes.
  deviceIdFor: async (origin) =>
    (await nativeReceiptStore.getCredential(origin).catch(() => null))?.deviceId ?? null,
  forgetDevice: (origin) => nativeReceiptStore.deleteCredential(origin),
})

/**
 * The refresh token's home on the device: the OS secret store, beside the
 * server address in Preferences (`deviceKeyValueStore`), ONE PER SERVER, read
 * under the origin the bridge is CONFIRMED to be bound to. It is not the webview's cookie jar
 * because the cookie never travelled at all from this origin
 * (auth/refresh-bridge.ts), and not localStorage because the app's own storage
 * is cleared by an update that changes the webview's data directory while the
 * session is meant to survive one. Keyed by origin, a token is only ever read
 * for the server it is about to be presented to.
 */
export const preferencesRefreshStore: RefreshTokenStore = serverList.refreshStoreFor(() =>
  confirmedServerOrigin(),
)

/**
 * The address that has been published for the wrapped app, if one has. It is
 * read from the global rather than kept in a second variable: the global IS
 * the hand-off, and a copy could disagree with it.
 *
 * It answers what the page is USING, which before Preferences settle is the
 * synchronous hint from localStorage, a value page script can write. Anything
 * that decides where a CREDENTIAL goes asks `confirmedServerOrigin` instead.
 */
export function publishedServerAddress(): string | null {
  const raw = (globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
  return typeof raw === "string" && raw !== "" ? raw : null
}

/**
 * The origin PREFERENCES confirmed, and null until they answer.
 *
 * The refresh bridge binds to this rather than to the published global: the
 * global may still be holding the boot hint, and a hint written by whoever
 * could run script in the page must never be handed the refresh token. A call
 * made before the answer simply goes without the header, which costs one
 * rotation and never a credential.
 */
let confirmedOrigin: string | null = null

export function confirmedServerOrigin(): string | null {
  return confirmedOrigin
}

/**
 * Resolves the moment the boot sequence has decided the bound origin, with or
 * without one. The refresh bridge waits on this for the two calls that carry
 * the refresh token: they are fired by the wrapped app in its first tick,
 * before native storage has answered, and a refresh with no token is a 401
 * and a login screen in front of a live session.
 */
let markOriginSettled: () => void = () => {}
const originSettled = new Promise<void>((resolve) => {
  markOriginSettled = resolve
})

export function serverOriginSettled(): Promise<void> {
  return originSettled
}

export async function startBoot(deps: BootDependencies): Promise<void> {
  // BEFORE ANY AWAIT: the wrapped app's module entry runs as soon as this
  // script yields, and its first call may be the login or the refresh whose
  // token has to be captured. `serverOrigin` is read per request, so the
  // bridge is installed now and answers correctly the moment the address
  // below is published.
  deps.attachBridge?.()

  // Order is the whole point: subscribe first, wait for the app second.
  deps.addUrlListener((url) => {
    const server = parseConnectLink(url)
    if (server !== null) {
      deps.firstLaunch?.offerAddress(server)
      return
    }
    deps.queue.onAppUrlOpen(url)
  })
  deps.whenAppReady(() => deps.queue.markAppReady())
  // Whether the app started life knowing where its server is. When it did not,
  // everything it has already built points at `capacitor://localhost`.
  const hinted = publishedServerAddress()
  // THE BOUND ORIGIN IS SETTLED FROM STORAGE, NEVER FROM THE NETWORK. The
  // record of which server this install talks to is the stored address;
  // `start()` below also validates it by fetching that server's branding, and
  // on a slow or unreachable network that fetch resolves late or never. The
  // refresh the wrapped app fires in its first tick waits on this settle for a
  // few seconds and then goes out regardless, so a settle behind the fetch was
  // no settle at all: offline, the relaunch refreshed bare, took a 401 and
  // dropped a live session. Reading it here costs one native storage read.
  await deps.migrate?.().catch(() => undefined)
  const bound = await deps.firstLaunch?.boundAddress()
  if (bound) {
    confirmedOrigin = serverAddressOrigin(bound)
    markOriginSettled()
  }
  let serverAddress: string | undefined
  try {
    serverAddress = await deps.firstLaunch?.start()
  } finally {
    // Whatever it decided, the wait is over: a shell with no address must not
    // hold the app's own calls back for the life of the page.
    if (!serverAddress) markOriginSettled()
  }
  if (serverAddress) {
    // PREFERENCES HAVE ANSWERED, so the hint stops deciding anything. The
    // wrapped app is served from capacitor://localhost and has no API at its
    // own origin, so it reads this global to find one (S15, boot/
    // server-global.ts). Published BEFORE push registration, which is itself a
    // call to that server: nothing may talk to a deployment the page cannot
    // name.
    if (!publishServerAddress(globalThis, serverAddress)) {
      markOriginSettled()
      return
    }
    confirmedOrigin = publishedServerAddress()
    markOriginSettled()
    // A hint that pointed somewhere else was either stale or written by
    // whoever could run script in this page. Either way the app has already
    // built requests against it, so the mirror is dropped, rewritten from the
    // confirmed address, and the page is started again.
    const disagreed = hinted !== null && hinted !== confirmedOrigin
    // The page's own storage has to be this server's before anything reads it
    // against this server: a restart here is the same restart a disagreeing
    // hint asks for, with the right storage under it.
    if (await deps.reconcileStorage?.(serverAddress).catch(() => false)) {
      mirrorServerAddress(serverAddress, deps.mirrorStorage)
      return
    }
    if (disagreed) clearMirroredServerAddress(deps.mirrorStorage)
    // The mirror is what makes the NEXT launch synchronous (boot/
    // server-global.ts), so it is written from the settled address every time,
    // not only the first.
    mirrorServerAddress(serverAddress, deps.mirrorStorage)
    if ((hinted === null || disagreed) && deps.reload) {
      deps.reload()
      return
    }
    await deps.startPush?.(serverAddress)
  }
}

/**
 * The Capacitor plugin behind this shell's own seam. The plugin's own
 * `addListener` is a set of overloads keyed on the event name, which no
 * structural type can stand in for, so the widening happens once, here.
 */
export const capacitorPushPlugin: PushPlugin = {
  requestPermissions: () => PushNotifications.requestPermissions(),
  register: () => PushNotifications.register(),
  removeAllDeliveredNotifications: () => PushNotifications.removeAllDeliveredNotifications(),
  getDeliveredNotifications: () => PushNotifications.getDeliveredNotifications(),
  // iOS removes a delivered notification by its identifier (`id`).
  removeDeliveredNotifications: (delivered) =>
    PushNotifications.removeDeliveredNotifications({
      notifications: delivered.notifications.map((n) => ({ id: n.id ?? "", data: n.data })),
    }),
  addListener: (event, handler) =>
    (
      PushNotifications.addListener as unknown as (
        name: string,
        listener: (payload: unknown) => void,
      ) => unknown
    )(event, handler),
}

/** The part of `@capacitor/app` the push client listens to. */
export interface AppStateSource {
  addListener: (
    event: "appStateChange",
    listener: (state: { isActive: boolean }) => void,
  ) => unknown
}

/**
 * The phone's delivery receipts (receipts.ts): credentials in the shared
 * keychain group, the offline queue in the App Group, both through the
 * LiaisonNative plugin. One client per page.
 */
export const receiptClient: ReceiptClient = createReceiptClient({ native: nativeReceiptStore })

/**
 * This device's id on the bound server, for the logout call (A7): the server
 * revokes that device's receipt credential with the session.
 */
export async function boundDeviceId(): Promise<string | null> {
  const origin = confirmedServerOrigin()
  if (origin === null) return null
  return (await nativeReceiptStore.getCredential(origin).catch(() => null))?.deviceId ?? null
}

/**
 * Where a tapped notification from ANOTHER saved server goes: the native
 * servers' `openOn` (servers/server-list.ts), which boot-entry.ts publishes
 * after the push client exists, hence the late binding.
 */
let otherServerOpener: ((server: string, link: string) => Promise<unknown>) | null = null

export function onOtherServerLink(
  opener: ((server: string, link: string) => Promise<unknown>) | null,
): void {
  otherServerOpener = opener
}

/**
 * The push client's dependencies on the device. Both optional hooks are wired
 * here on purpose, and pinned by a test (push-deps.test.ts): without
 * `apsEnvironment` a debug build's sandbox token is sent to the production
 * APNs host and never delivers; without `onForeground` the badge is never
 * cleared and a token the server dropped is not posted again until a relaunch.
 */
export function capacitorPushDeps(
  app: AppStateSource = App,
  nativePresenter: () => boolean = liaisonNativeAvailable,
): PushClientDependencies {
  return {
    plugin: capacitorPushPlugin,
    platform: () => Capacitor.getPlatform(),
    accessToken: async () => accessTokenStore.get(),
    serverAddress: createStoredServerAddress(preferencesStorage),
    queue: deepLinkQueue,
    apsEnvironment,
    // The page's report of the conversation on screen: no in-app notice for it.
    threadOnScreen,
    // iOS: the system banner presents a foreground push and the native
    // presenter reports its decision (ForegroundPushPresenter.swift).
    ...(nativePresenter() ? { onPresentation: onPushPresentation } : {}),
    // Credential storage, the app's final outcome and the NSE's offline queue.
    receipts: receiptClient,
    // A failed registration POST is retried on this timer (S3).
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
    // A tap on another saved server's notification opens that server first.
    openOnServer: async (server, link) => otherServerOpener?.(server, link),
    // The organisation is named in the alert only on a phone with several servers.
    multiServer: async () => (await serverList.snapshot()).servers.length > 1,
    // Debug builds: `LIAISON_DEBUG_FAIL_NEXT_REGISTER=1` at launch (M5).
    forceRegisterFailure: () => nativeReceiptStore.forceRegisterFailure(),
    // Every return to the app clears the badge and re-asserts the token, so a
    // row the server deleted comes back without a relaunch (S10, S12).
    onForeground: (handler) =>
      void app.addListener("appStateChange", (state: { isActive: boolean }) => {
        if (state.isActive) handler()
      }),
  }
}

/**
 * The real push client, ARMED once the server address is known.
 *
 * It does not register here: registration waits for a bearer, which on a first
 * launch arrives only when somebody signs in, minutes later. So the address
 * half is settled by the caller and the bearer half is subscribed to
 * (push-client.ts), and the permission prompt is asked the moment both hold.
 */
/** The armed push client's re-registration, for a change of the saved list. */
let registrationRefresher: (() => Promise<void>) | null = null

export function refreshPushRegistration(): Promise<void> {
  return registrationRefresher?.() ?? Promise.resolve()
}

export function capacitorPush(serverAddress: string): Promise<void> {
  void serverAddress
  const client = createPushClient(capacitorPushDeps())
  registrationRefresher = () => client.refreshRegistration()
  // Never blocks the boot: a device with notifications refused is a device
  // that still runs the app, and a device with nobody signed in yet is the
  // normal first launch.
  armPushRegistration({
    accessTokens: accessTokenStore,
    start: () => client.start(),
    // Sign-out revokes this device. Without it the row survives the session
    // and the next person to sign in on the handset is not the person its
    // notifications are addressed to.
    stop: () => client.logout(),
    onSessionEnd,
  })
  return Promise.resolve()
}
