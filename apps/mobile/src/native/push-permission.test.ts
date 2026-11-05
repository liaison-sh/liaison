// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone's push permission, as Settings -> Notifications reads and asks
// for it on the "This device" row (apps/web settings/notification-settings).
import { describe, expect, it } from "bun:test"
import { publishedNativeBridge } from "../bridge/native-bridge"
import { createPushPermission, type PushPermissionPlugin } from "./push-permission"
import { installNativeShelf } from "./shelf"

function fakePlugin(
  checked: string,
  requested: string,
): PushPermissionPlugin & { registers: () => number } {
  let registers = 0
  return {
    checkPermissions: async () => ({ receive: checked }),
    requestPermissions: async () => ({ receive: requested }),
    register: async () => {
      registers++
    },
    registers: () => registers,
  }
}

describe("the push permission behind the bridge", () => {
  it("reads the three states the settings row shows", async () => {
    expect(await createPushPermission(fakePlugin("granted", "granted")).check()).toBe("granted")
    expect(await createPushPermission(fakePlugin("denied", "denied")).check()).toBe("denied")
    expect(await createPushPermission(fakePlugin("prompt", "prompt")).check()).toBe("prompt")
    expect(await createPushPermission(fakePlugin("prompt-with-rationale", "prompt")).check()).toBe(
      "prompt",
    )
  })

  it("registers for a token once the person allows, so the server gets it", async () => {
    const plugin = fakePlugin("prompt", "granted")
    expect(await createPushPermission(plugin).request()).toBe("granted")
    expect(plugin.registers()).toBe(1)
  })

  it("does not register when the person refuses", async () => {
    const plugin = fakePlugin("prompt", "denied")
    expect(await createPushPermission(plugin).request()).toBe("denied")
    expect(plugin.registers()).toBe(0)
  })

  it("still answers granted when the registration itself fails", async () => {
    const plugin: PushPermissionPlugin = {
      checkPermissions: async () => ({ receive: "granted" }),
      requestPermissions: async () => ({ receive: "granted" }),
      register: async () => {
        throw new Error("no APNs on this build")
      },
    }
    expect(await createPushPermission(plugin).request()).toBe("granted")
  })

  it("is published on the bridge by the shelf", () => {
    const target: Record<string, unknown> = {}
    installNativeShelf(target)
    const permission = publishedNativeBridge(target)?.pushPermission
    expect(typeof permission?.check).toBe("function")
    expect(typeof permission?.request).toBe("function")
  })
})
