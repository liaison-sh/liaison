// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  APP_LOCK_ENABLED_KEY,
  type AppLockDeps,
  type AppStatePlugin,
  type BiometricPlugin,
  createAppLock,
  type LockStorage,
} from "./app-lock"

function memoryStorage(initial: Record<string, string> = {}): LockStorage & {
  values: Record<string, string>
} {
  const values = { ...initial }
  return {
    values,
    get: async (key) => values[key] ?? null,
    set: async (key, value) => {
      values[key] = value
    },
  }
}

function deps(overrides: Partial<AppLockDeps> = {}): AppLockDeps {
  const biometrics: BiometricPlugin = {
    checkBiometry: async () => ({ isAvailable: true }),
    authenticate: async () => {},
  }
  const appState: AppStatePlugin = {
    addListener: async () => ({ remove: async () => {} }),
  }
  return { biometrics, storage: memoryStorage(), appState, ...overrides }
}

describe("whether the lock can be offered at all", () => {
  it("is available when the device has an enrolled biometric", async () => {
    await expect(createAppLock(deps()).isAvailable()).resolves.toBe(true)
  })

  it("is unavailable with no sensor, no enrolment, or no plugin", async () => {
    const noSensor = deps({
      biometrics: {
        checkBiometry: async () => ({ isAvailable: false }),
        authenticate: async () => {},
      },
    })
    await expect(createAppLock(noSensor).isAvailable()).resolves.toBe(false)

    const noPlugin = deps({
      biometrics: {
        checkBiometry: async () => {
          throw new Error("unimplemented")
        },
        authenticate: async () => {},
      },
    })
    await expect(createAppLock(noPlugin).isAvailable()).resolves.toBe(false)
  })
})

describe("the preference", () => {
  it("is off until it is turned on", async () => {
    const lock = createAppLock(deps())
    await expect(lock.getEnabled()).resolves.toBe(false)
    await lock.setEnabled(true)
    await expect(lock.getEnabled()).resolves.toBe(true)
    await lock.setEnabled(false)
    await expect(lock.getEnabled()).resolves.toBe(false)
  })

  it("lives in native storage, which an app update does not clear", async () => {
    const storage = memoryStorage()
    await createAppLock(deps({ storage })).setEnabled(true)
    expect(storage.values[APP_LOCK_ENABLED_KEY]).toBe("true")
  })

  it("reads as off rather than throwing on an unreadable store", async () => {
    const storage: LockStorage = {
      get: async () => {
        throw new Error("preferences unavailable")
      },
      set: async () => {},
    }
    await expect(createAppLock(deps({ storage })).getEnabled()).resolves.toBe(false)
  })
})

describe("unlocking", () => {
  it("offers the device passcode alongside the biometric", async () => {
    const seen: Array<{ reason: string; allowDeviceCredential: boolean }> = []
    const lock = createAppLock(
      deps({
        biometrics: {
          checkBiometry: async () => ({ isAvailable: true }),
          authenticate: async (options) => {
            seen.push(options)
          },
        },
      }),
    )
    await expect(lock.authenticate("Unlock Liaison")).resolves.toBe(true)
    // Without this a failed sensor leaves deleting the app as the only way in.
    expect(seen).toEqual([{ reason: "Unlock Liaison", allowDeviceCredential: true }])
  })

  it("answers false on a refusal, a cancel, or a missing sensor", async () => {
    const lock = createAppLock(
      deps({
        biometrics: {
          checkBiometry: async () => ({ isAvailable: true }),
          authenticate: async () => {
            throw new Error("User canceled")
          },
        },
      }),
    )
    await expect(lock.authenticate("Unlock Liaison")).resolves.toBe(false)
  })
})

describe("foreground and background", () => {
  it("reports both transitions", async () => {
    const box: { push: ((state: { isActive: boolean }) => void) | null } = { push: null }
    const appState: AppStatePlugin = {
      addListener: async (_event, handler) => {
        box.push = handler
        return { remove: async () => {} }
      },
    }
    const seen: boolean[] = []
    createAppLock(deps({ appState })).onAppStateChange((active) => seen.push(active))
    await Promise.resolve()
    box.push?.({ isActive: false })
    box.push?.({ isActive: true })
    expect(seen).toEqual([false, true])
  })

  it("stops reporting once unsubscribed", async () => {
    const box: { push: ((state: { isActive: boolean }) => void) | null } = { push: null }
    const appState: AppStatePlugin = {
      addListener: async (_event, handler) => {
        box.push = handler
        return { remove: async () => {} }
      },
    }
    const seen: boolean[] = []
    const off = createAppLock(deps({ appState })).onAppStateChange((a) => seen.push(a))
    await Promise.resolve()
    off()
    box.push?.({ isActive: false })
    expect(seen).toEqual([])
  })
})
