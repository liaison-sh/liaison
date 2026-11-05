// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  AUTH_SESSION_PLUGIN_NAME,
  apsEnvironment,
  authenticate,
  createLiaisonNative,
  type LiaisonNativePlugin,
} from "./liaison-native"

function fakePlugin(overrides: Partial<LiaisonNativePlugin> = {}): LiaisonNativePlugin {
  return {
    apsEnvironment: async () => ({ environment: "sandbox" }),
    authenticate: async () => ({ url: "liaison://oauth-complete?code=abc" }),
    setThreadOnScreen: async () => {},
    addListener: () => undefined,
    ...overrides,
  }
}

describe("the LiaisonNative wrapper", () => {
  it("returns null on the web, where the plugin does not exist", async () => {
    // bun runs the module as a browser would: no native bridge at all.
    expect(await apsEnvironment()).toBeNull()
    expect(
      await authenticate({ url: "https://example.com/oauth", callbackScheme: "liaison" }),
    ).toBeNull()
  })

  it("returns null when the plugin is not registered on this platform (Android)", async () => {
    const native = createLiaisonNative({ available: () => false, plugin: fakePlugin() })
    expect(await native.apsEnvironment()).toBeNull()
    expect(await native.authenticate({ url: "https://x", callbackScheme: "liaison" })).toBeNull()
  })

  it("passes the APNs environment through, reading development as sandbox", async () => {
    for (const [raw, expected] of [
      ["sandbox", "sandbox"],
      ["development", "sandbox"],
      ["production", "production"],
    ] as const) {
      const native = createLiaisonNative({
        available: () => true,
        plugin: fakePlugin({ apsEnvironment: async () => ({ environment: raw }) }),
      })
      expect(await native.apsEnvironment()).toBe(expected)
    }
  })

  it("returns null for an environment it does not know rather than guessing a host", async () => {
    const native = createLiaisonNative({
      available: () => true,
      plugin: fakePlugin({ apsEnvironment: async () => ({ environment: "staging" }) }),
    })
    expect(await native.apsEnvironment()).toBeNull()
  })

  it("hands authenticate the url and scheme and returns the callback url", async () => {
    const seen: unknown[] = []
    const native = createLiaisonNative({
      available: () => true,
      plugin: fakePlugin({
        authenticate: async (opts) => {
          seen.push(opts)
          return { url: "liaison://oauth-complete?code=abc" }
        },
      }),
    })
    const url = await native.authenticate({
      url: "https://example.com/oauth/start",
      callbackScheme: "liaison",
    })
    expect(url).toBe("liaison://oauth-complete?code=abc")
    expect(seen).toEqual([{ url: "https://example.com/oauth/start", callbackScheme: "liaison" }])
  })

  it("runs an app connection's provider page unchanged and hands back its handoff link", async () => {
    // Connecting an app from the phone opens the PROVIDER's authorize page (not
    // this server's) in the session; the server's handoff page ends it on the
    // liaison scheme, and the link goes back to the call that opened it.
    const provider =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s&redirect_uri=https%3A%2F%2Fliaison.example%2Fapi%2Fconnections%2Fcallback"
    const handoff = `liaison://oauth-complete?code=${"e".repeat(64)}&state=${"f".repeat(43)}`
    const seen: unknown[] = []
    const native = createLiaisonNative({
      available: () => true,
      plugin: fakePlugin({
        authenticate: async (opts) => {
          seen.push(opts)
          return { url: handoff }
        },
      }),
    })
    expect(await native.authenticate({ url: provider, callbackScheme: "liaison" })).toBe(handoff)
    expect(seen).toEqual([{ url: provider, callbackScheme: "liaison" }])
  })

  it("throws an Error with code cancelled when the user closes the sheet", async () => {
    const native = createLiaisonNative({
      available: () => true,
      plugin: fakePlugin({
        authenticate: async () => {
          throw Object.assign(new Error("The user cancelled the sign in"), { code: "cancelled" })
        },
      }),
    })
    const error = await native
      .authenticate({ url: "https://x", callbackScheme: "liaison" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as { code?: string }).code).toBe("cancelled")
  })

  it("passes any other failure through untouched", async () => {
    const native = createLiaisonNative({
      available: () => true,
      plugin: fakePlugin({
        authenticate: async () => {
          throw Object.assign(new Error("no window"), { code: "unavailable" })
        },
      }),
    })
    const error = await native
      .authenticate({ url: "https://x", callbackScheme: "liaison" })
      .catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe("unavailable")
  })
})

describe("the foreground push presentation (ForegroundPushPresenter.swift)", () => {
  it("forwards the conversation on screen and subscribes to the decisions on iOS", () => {
    const sent: Array<string | null> = []
    const events: string[] = []
    const native = createLiaisonNative({
      available: () => true,
      plugin: fakePlugin({
        setThreadOnScreen: async ({ threadId }) => {
          sent.push(threadId)
        },
        addListener: (event) => {
          events.push(event)
          return undefined
        },
      }),
    })
    native.setThreadOnScreen("t1")
    native.setThreadOnScreen(null)
    native.onPushPresentation(() => {})
    expect(sent).toEqual(["t1", null])
    expect(events).toEqual(["pushPresentation"])
  })

  it("does nothing where the plugin is not registered", () => {
    let touched = false
    const native = createLiaisonNative({
      available: () => false,
      plugin: fakePlugin({
        setThreadOnScreen: async () => {
          touched = true
        },
        addListener: () => {
          touched = true
          return undefined
        },
      }),
    })
    native.setThreadOnScreen("t1")
    native.onPushPresentation(() => {})
    expect(touched).toBe(false)
  })

  it("on Android, runs the session through the auth-session plugin and hands back its link", async () => {
    // Android has no LiaisonNative plugin (no APNs, no foreground presenter),
    // only the browser-backed session (LiaisonAuthSessionPlugin.java).
    const provider = "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s"
    const handoff = `liaison://oauth-complete?code=${"e".repeat(64)}&state=${"f".repeat(43)}`
    const seen: unknown[] = []
    const native = createLiaisonNative({
      available: () => false,
      plugin: fakePlugin(),
      authSession: {
        available: () => true,
        plugin: {
          authenticate: async (opts) => {
            seen.push(opts)
            return { url: handoff }
          },
        },
      },
    })
    expect(await native.authenticate({ url: provider, callbackScheme: "liaison" })).toBe(handoff)
    expect(seen).toEqual([{ url: provider, callbackScheme: "liaison" }])
    // Nothing else of the iOS plugin turns on.
    expect(await native.apsEnvironment()).toBeNull()
  })

  it("on Android, coming back without signing in is a cancel, like closing the sheet", async () => {
    const native = createLiaisonNative({
      available: () => false,
      plugin: fakePlugin(),
      authSession: {
        available: () => true,
        plugin: {
          authenticate: async () => {
            throw Object.assign(new Error("The sign in was cancelled."), { code: "cancelled" })
          },
        },
      },
    })
    await expect(
      native.authenticate({ url: "https://x/authorize", callbackScheme: "liaison" }),
    ).rejects.toMatchObject({ code: "cancelled" })
  })

  it("the Android activity registers the auth-session plugin under the name the wrapper calls", () => {
    const java = path.join(import.meta.dir, "../../android/app/src/main/java/sh/liaison/mobile")
    const plugin = readFileSync(path.join(java, "LiaisonAuthSessionPlugin.java"), "utf8")
    expect(plugin).toContain(`@CapacitorPlugin(name = "${AUTH_SESSION_PLUGIN_NAME}")`)
    const activity = readFileSync(path.join(java, "MainActivity.java"), "utf8")
    const register = activity.indexOf("registerPlugin(LiaisonAuthSessionPlugin.class)")
    expect(register).toBeGreaterThan(-1)
    // Before the bridge starts, or the plugin is not on it.
    expect(register).toBeLessThan(activity.indexOf("super.onCreate"))
  })
})
