// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Face ID (or the device passcode) in front of the app.
//
// WHAT THIS IS AND IS NOT. It is a screen the user has to get past, and
// nothing more: the session's refresh token is exactly where it was before,
// in Capacitor Preferences (auth/refresh-bridge.ts), and it is neither moved
// nor re-keyed by this. So the lock stops the person holding the unlocked
// handset from reading the workspace; it does not stop somebody who can read
// the app's data directory. Binding the token to the keychain behind this
// biometric is the follow-up, and it is a different piece of work: it changes
// where a live session lives, which is the one thing this shelf must not do
// casually.
//
// THE PREFERENCE IS NOT A SECRET, and it is kept next to the address rather
// than in the webview's localStorage for the same reason the token is: an
// update that changes the webview's data directory clears localStorage, and a
// lock that silently turns itself off on an update is not a lock.
//
// `allowDeviceCredential` is ON. A user whose biometric fails (a wet finger, a
// mask, a sensor that has stopped working) must still be able to get into
// their own workspace, and the passcode is the platform's own answer to that.
// Without it the only way back in is deleting the app.

export const APP_LOCK_ENABLED_KEY = "liaison.appLock.enabled"

/** Just enough of the biometric plugin to be testable without a device. */
export interface BiometricPlugin {
  checkBiometry: () => Promise<{ isAvailable: boolean }>
  authenticate: (options: { reason: string; allowDeviceCredential: boolean }) => Promise<void>
}

/** The same storage shape first launch asks for (onboarding/server-address.ts). */
export interface LockStorage {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
}

export interface AppStatePlugin {
  addListener: (
    event: "appStateChange",
    handler: (state: { isActive: boolean }) => void,
  ) => Promise<{ remove: () => Promise<void> }>
}

export interface NativeAppLock {
  isAvailable: () => Promise<boolean>
  getEnabled: () => Promise<boolean>
  setEnabled: (enabled: boolean) => Promise<void>
  authenticate: (reason: string) => Promise<boolean>
  onAppStateChange: (handler: (active: boolean) => void) => () => void
}

export interface AppLockDeps {
  biometrics: BiometricPlugin
  storage: LockStorage
  appState: AppStatePlugin
}

export function createAppLock(deps: AppLockDeps): NativeAppLock {
  return {
    async isAvailable(): Promise<boolean> {
      try {
        return Boolean((await deps.biometrics.checkBiometry()).isAvailable)
      } catch {
        // No sensor, no enrolment, or no plugin. All of them mean the same
        // thing to the settings screen: do not offer the toggle.
        return false
      }
    },

    async getEnabled(): Promise<boolean> {
      try {
        return (await deps.storage.get(APP_LOCK_ENABLED_KEY)) === "true"
      } catch {
        // A store that cannot be read must not leave the app unlocked by
        // default... but it also must not lock a user out of a workspace they
        // never asked to lock. Off is the state they last chose by not
        // choosing, so off it is.
        return false
      }
    },

    async setEnabled(enabled: boolean): Promise<void> {
      await deps.storage.set(APP_LOCK_ENABLED_KEY, enabled ? "true" : "false")
    },

    async authenticate(reason: string): Promise<boolean> {
      try {
        await deps.biometrics.authenticate({ reason, allowDeviceCredential: true })
        return true
      } catch {
        // A refusal, a cancel and a missing sensor are one answer here: NOT
        // authenticated. The overlay stays up and offers the control again.
        return false
      }
    },

    onAppStateChange(handler: (active: boolean) => void): () => void {
      // Synchronous unsubscribe over an asynchronous subscribe, exactly as the
      // network listener does (src/native/network.ts).
      let live = true
      let registered: { remove: () => Promise<void> } | null = null
      deps.appState
        .addListener("appStateChange", (state) => {
          if (!live) return
          handler(Boolean(state.isActive))
        })
        .then((handle) => {
          if (!live) {
            void handle.remove().catch(() => {})
            return
          }
          registered = handle
        })
        .catch(() => {})
      return () => {
        live = false
        void registered?.remove().catch(() => {})
        registered = null
      }
    },
  }
}
