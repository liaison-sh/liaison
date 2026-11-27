// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App Store guidelines 2.5.2, 3.2.2 and 4.7: the iOS app carries no catalogue
// of apps to add and no way to install one. One check decides it
// (`appStoreHidden`, lib/native-bridge.ts): the App store settings page is not
// registered there, while the apps already in the workspace keep their
// settings pages. A browser and the Android app are unchanged.
import { afterEach, describe, expect, it } from "vitest"
import { getSettingsSections, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { appStoreHidden, NATIVE_BRIDGE_GLOBAL } from "./native-bridge"

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"
const BROWSER_UA = navigator.userAgent

function runIn(where: "browser" | "ios" | "android"): void {
  const g = globalThis as Record<string, unknown>
  if (where === "browser") delete g[NATIVE_BRIDGE_GLOBAL]
  else g[NATIVE_BRIDGE_GLOBAL] = {}
  const ua = where === "ios" ? IOS_UA : where === "android" ? ANDROID_UA : BROWSER_UA
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true })
}

function sectionHrefs(): string[] {
  resetRegistry()
  resetBootstrap()
  bootstrapKernelApps()
  return getSettingsSections().map((s) => s.href)
}

afterEach(() => {
  runIn("browser")
  resetRegistry()
  resetBootstrap()
})

describe("the App store in the iOS app", () => {
  it("the check is true in the iOS app only", () => {
    runIn("browser")
    expect(appStoreHidden()).toBe(false)
    runIn("android")
    expect(appStoreHidden()).toBe(false)
    runIn("ios")
    expect(appStoreHidden()).toBe(true)
  })

  it("is not registered in the iOS app, and is in a browser and on Android", () => {
    runIn("browser")
    expect(sectionHrefs()).toContain("/settings/store")
    runIn("android")
    expect(sectionHrefs()).toContain("/settings/store")
    runIn("ios")
    const ids = sectionHrefs()
    expect(ids).not.toContain("/settings/store")
    // The Connectors page (installed connectors' settings) stays.
    expect(ids).toContain("/settings/connectors")
  })
})
