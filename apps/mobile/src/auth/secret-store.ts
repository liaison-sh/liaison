// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE THE REFRESH TOKEN LIVES ON THE PHONE.
//
// The refresh token is a month-long session. Plain Capacitor Preferences are an
// ordinary app file (NSUserDefaults, SharedPreferences), copied into device
// backups and readable by anything that reads the app's files. The token lives
// in the operating system's secret store instead, through
// @aparajita/capacitor-secure-storage: the iOS keychain, and on Android a
// value encrypted under an AES key held in the Android Keystore.
//
// The saved server list (servers/server-list.ts) keeps everything it files in
// one key-value store. This module is that store: secret keys (the refresh
// tokens, legacy and per server) go to the secret store, everything else (the
// address, the list, the page storage parked per server) stays in Preferences.
//
// FIRST LAUNCH AFTER THE UPDATE moves a token an earlier build left in
// Preferences into the secret store and deletes the Preferences copy, once,
// before any secret key is read. Written first, deleted second: an app killed
// between the two finds the token already in the secret store next launch and
// only deletes the old copy. A secret store that fails leaves the old copy
// where it is (the next launch tries again) and the failure reaches the caller.
//
// A FRESH INSTALL purges the app's secret-store items first. Uninstalling an
// iOS app deletes its Preferences but not its keychain items, so a reinstall
// (or the next person to install it on that phone) would otherwise sign in with
// the previous install's session. Preferences carry an install flag; a launch
// that finds none deletes every item under the app's key prefix, then sets the
// flag, then moves any Preferences token in. Builds before the flag kept the
// token in Preferences, so an update loses nothing. A purge that fails sets no
// flag: the next call tries again, and no secret is read in between.
//
// Where the plugin is not native (the web build, tests) there is no secret
// store and every key stays in Preferences, as before.

import { REFRESH_TOKEN_KEY } from "./refresh-bridge"

/** The calls the server list makes on its storage (servers/server-list.ts). */
export interface StringStore {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
  remove: (key: string) => Promise<void>
}

/** Preferences, which can also list what it holds. */
export interface ListableStringStore extends StringStore {
  keys: () => Promise<string[]>
}

/** The Preferences key whose presence says this install already purged the secret store. */
export const INSTALL_FLAG_KEY = "liaison.installed"

/** The refresh token keys: the single-server one and `liaison.refreshToken@<origin>`. */
export function isSecretKey(key: string): boolean {
  return key === REFRESH_TOKEN_KEY || key.startsWith(`${REFRESH_TOKEN_KEY}@`)
}

export interface SecretRoutedStore extends StringStore {
  /** Purges a fresh install's secret store and moves secret keys out of Preferences.
   *  Runs by itself before the first call. */
  migrateSecrets: () => Promise<void>
}

export function createSecretRoutedStore(deps: {
  plain: ListableStringStore
  /** The OS secret store, or null where there is none (web, tests). */
  secret: ListableStringStore | null
}): SecretRoutedStore {
  const { plain, secret } = deps
  let installed: Promise<void> | null = null
  let migrated: Promise<void> | null = null

  /** A launch with no install flag is a fresh install: what the secret store holds is a
   *  previous install's. */
  async function purgeIfFreshInstall(target: ListableStringStore): Promise<void> {
    if ((await plain.get(INSTALL_FLAG_KEY)) !== null) return
    for (const key of await target.keys()) await target.remove(key)
    await plain.set(INSTALL_FLAG_KEY, "1")
  }

  function ensureInstalled(): Promise<void> {
    if (secret === null) return Promise.resolve()
    if (installed === null) {
      installed = purgeIfFreshInstall(secret).catch((error: unknown) => {
        installed = null
        throw error
      })
    }
    return installed
  }

  async function moveSecrets(target: StringStore): Promise<void> {
    for (const key of await plain.keys()) {
      if (!isSecretKey(key)) continue
      const value = await plain.get(key)
      // A token already in the secret store is the newer one: it was written
      // after the update, while the Preferences copy predates it.
      if (value !== null && (await target.get(key)) === null) await target.set(key, value)
      await plain.remove(key)
    }
  }

  function migrateSecrets(): Promise<void> {
    if (secret === null) return Promise.resolve()
    if (migrated === null) {
      migrated = ensureInstalled()
        .then(() => moveSecrets(secret))
        .catch((error: unknown) => {
          migrated = null
          throw error
        })
    }
    return migrated
  }

  async function storeFor(key: string): Promise<StringStore> {
    if (secret === null) return plain
    if (!isSecretKey(key)) {
      await ensureInstalled()
      return plain
    }
    await migrateSecrets()
    return secret
  }

  return {
    migrateSecrets,
    get: async (key) => (await storeFor(key)).get(key),
    set: async (key, value) => (await storeFor(key)).set(key, value),
    remove: async (key) => (await storeFor(key)).remove(key),
  }
}

/** Just enough of the plugin (definitions.d.ts of @aparajita/capacitor-secure-storage). */
export interface SecureStoragePluginLike {
  setKeyPrefix: (prefix: string) => Promise<void>
  setSynchronize: (sync: boolean) => Promise<void>
  setDefaultKeychainAccess: (access: number) => Promise<void>
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  /** This app's keys (the current prefix), stripped of the prefix. */
  keys: () => Promise<string[]>
}

/** The plugin's prefix for this app's items, so nothing else's items are touched. */
export const SECRET_KEY_PREFIX = "liaison_"

/**
 * The plugin as a string store. iOS items are kept out of iCloud keychain sync
 * and are `afterFirstUnlockThisDeviceOnly` (the plugin's
 * KeychainAccess.afterFirstUnlockThisDeviceOnly, 3): readable by a background
 * launch once the phone has been unlocked, never carried to another device by a
 * backup. Android's encrypting key lives in the Keystore, which no backup holds.
 */
export function secureStorageStringStore(
  plugin: SecureStoragePluginLike,
  afterFirstUnlockThisDeviceOnly: number,
): ListableStringStore {
  let ready: Promise<void> | null = null
  const configured = (): Promise<void> => {
    if (ready === null) {
      ready = (async () => {
        await plugin.setKeyPrefix(SECRET_KEY_PREFIX)
        await plugin.setSynchronize(false)
        await plugin.setDefaultKeychainAccess(afterFirstUnlockThisDeviceOnly)
      })().catch((error: unknown) => {
        ready = null
        throw error
      })
    }
    return ready
  }
  return {
    get: async (key) => {
      await configured()
      return plugin.getItem(key)
    },
    set: async (key, value) => {
      await configured()
      await plugin.setItem(key, value)
    },
    remove: async (key) => {
      await configured()
      await plugin.removeItem(key)
    },
    keys: async () => {
      await configured()
      return plugin.keys()
    },
  }
}
