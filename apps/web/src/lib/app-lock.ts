// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app lock, from the web app's side: whether the workspace is behind a
// biometric right now, and what gets it back.
//
// IT FAILS CLOSED ON A COLD START. Under a shell that published a lock, the
// app starts LOCKED and unlocks itself a tick later if the preference turns
// out to be off. The other way round (start open, lock once the preference
// answers) paints the workspace first and covers it afterwards, which on a
// handed-over phone is the whole of what the lock was for.
//
// In a browser there is no lock at all: `locked` is false forever and nothing
// here subscribes to anything.
//
// FIVE MINUTES IN THE BACKGROUND, not five minutes idle. Switching to the
// camera to take a photo of a serial number and coming back should not ask for
// a face, and a phone put down on a table and picked up by somebody else half
// an hour later should. The clock therefore starts when the app goes to the
// background and is read when it comes back.
//
// THE TOKEN DOES NOT MOVE. The session's refresh token stays exactly where the
// shell already keeps it; this is a screen, not a key. Binding it to the
// keychain behind the biometric is a separate piece of work.
import { type Accessor, createSignal, onCleanup } from "solid-js"
import { type NativeAppLock, nativeAppLock } from "~/lib/native-bridge"

/** How long the app may sit in the background before it locks again. */
export const APP_LOCK_GRACE_MS = 5 * 60_000

/**
 * Whether a return to the foreground has to ask for the biometric again.
 * `backgroundedAt` is null when the app never left, which is the case for
 * every state change that is not a real backgrounding.
 */
export function shouldLockOnResume(
  backgroundedAt: number | null,
  now: number,
  graceMs: number = APP_LOCK_GRACE_MS,
): boolean {
  if (backgroundedAt === null) return false
  return now - backgroundedAt >= graceMs
}

export interface AppLockController {
  /** Whether the lock overlay should be covering the app. */
  locked: Accessor<boolean>
  /** Whether a shell published a lock at all. False in a browser. */
  supported: boolean
  /** Runs the biometric. Clears `locked` only on a real success. */
  unlock: (reason: string) => Promise<boolean>
}

export interface AppLockOptions {
  /** Injected for tests. Defaults to the published bridge. */
  lock?: NativeAppLock | null
  now?: () => number
  graceMs?: number
}

export function createAppLock(options: AppLockOptions = {}): AppLockController {
  const lock = options.lock !== undefined ? options.lock : nativeAppLock()
  const now = options.now ?? (() => Date.now())
  const graceMs = options.graceMs ?? APP_LOCK_GRACE_MS

  if (lock === null) {
    return { locked: () => false, supported: false, unlock: async () => true }
  }

  // Locked until the preference says otherwise: see the header.
  const [locked, setLocked] = createSignal(true)
  let backgroundedAt: number | null = null

  void lock
    .getEnabled()
    .then((enabled) => {
      if (!enabled) setLocked(false)
    })
    .catch(() => {
      // A preference that cannot be read must not wall the user out of a
      // workspace they never locked.
      setLocked(false)
    })

  const off = lock.onAppStateChange((active) => {
    if (!active) {
      backgroundedAt = now()
      return
    }
    const due = shouldLockOnResume(backgroundedAt, now(), graceMs)
    backgroundedAt = null
    if (!due) return
    void lock
      .getEnabled()
      .then((enabled) => {
        if (enabled) setLocked(true)
      })
      .catch(() => {})
  })
  onCleanup(() => off())

  return {
    locked,
    supported: true,
    async unlock(reason: string): Promise<boolean> {
      let ok = false
      try {
        ok = await lock.authenticate(reason)
      } catch {
        ok = false
      }
      if (ok) setLocked(false)
      return ok
    },
  }
}

// --- The Security row's own toggle ---
//
// A settings switch has neither a `createAppLock` controller's lifecycle nor
// its own background clock: it just needs the current preference and a way to
// flip it. These three read the published lock directly, and fail exactly
// like the controller above -- never a throw, never a wall between the viewer
// and their settings screen.

/** Whether the shell offers a biometric lock at all. False in a browser, and
 *  false whenever the shell cannot answer (no sensor enrolled, no shell). */
export async function isAvailable(): Promise<boolean> {
  const lock = nativeAppLock()
  if (!lock) return false
  try {
    return await lock.isAvailable()
  } catch {
    return false
  }
}

/** The current on/off preference. False whenever it cannot be read. */
export async function getEnabled(): Promise<boolean> {
  const lock = nativeAppLock()
  if (!lock) return false
  try {
    return await lock.getEnabled()
  } catch {
    return false
  }
}

/** Persists the on/off preference. A shell that cannot save it is no worse
 *  off than before the tap -- the switch is free to spring back. */
export async function setEnabled(enabled: boolean): Promise<void> {
  const lock = nativeAppLock()
  if (!lock) return
  await lock.setEnabled(enabled)
}
