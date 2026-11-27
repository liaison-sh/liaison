// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App Store guideline 3.1.1: inside the iOS app nothing offers to buy, upgrade,
// add credits or sign up, nor links to a page that ends in a payment. One check
// decides it (`purchaseSurfacesHidden`, lib/native-bridge.ts); these tests hold
// each surface to it, absent in the iOS app and unchanged in a browser and on
// Android.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { micPlatform } from "~/modules/assist/dictation-platform"
import { isProductSiteUrl } from "~/modules/help/help-docs"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { BillingStateTestAccess, ensureBillingModeLoaded } from "~/modules/settings/BillingState"
import { capLimitMessage } from "~/modules/settings/cap-limit-message"
import { isBillingRow } from "~/modules/shell/attention-store"
import { PaymentRequiredNotice } from "~/modules/threads/PaymentRequiredNotice"
import { sendFailureToast } from "~/modules/threads/thread-send"
import { ApiError } from "./api-error"
import { modelLockedReasonKey } from "./model-groups"
import { NATIVE_BRIDGE_GLOBAL, nativeShellPlatform, purchaseSurfacesHidden } from "./native-bridge"

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"
const BROWSER_UA = navigator.userAgent

type Where = "browser" | "ios" | "android"

function runIn(where: Where): void {
  const g = globalThis as Record<string, unknown>
  if (where === "browser") delete g[NATIVE_BRIDGE_GLOBAL]
  else g[NATIVE_BRIDGE_GLOBAL] = {}
  const ua = where === "ios" ? IOS_UA : where === "android" ? ANDROID_UA : BROWSER_UA
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true })
}

const t = (key: string) => `t:${key}`

afterEach(() => {
  cleanup()
  runIn("browser")
  BillingStateTestAccess.reset()
})

describe("the one check", () => {
  it("is true in the iOS app only", () => {
    runIn("browser")
    expect(nativeShellPlatform()).toBeNull()
    expect(purchaseSurfacesHidden()).toBe(false)
    runIn("android")
    expect(nativeShellPlatform()).toBe("android")
    expect(purchaseSurfacesHidden()).toBe(false)
    runIn("ios")
    expect(nativeShellPlatform()).toBe("ios")
    expect(purchaseSurfacesHidden()).toBe(true)
  })

  it("is the same platform answer the dictation hint uses", () => {
    runIn("ios")
    expect(micPlatform()).toBe("ios")
    runIn("android")
    expect(micPlatform()).toBe("android")
  })
})

describe("credits ran out / unpaid invoice in a conversation", () => {
  const mount = (outOfCredits: boolean) =>
    render(() => (
      <I18nProvider initialLocale="en">
        <PaymentRequiredNotice outOfCredits={outOfCredits} />
      </I18nProvider>
    ))

  it("on the web: the sentence and the Billing link", () => {
    runIn("browser")
    mount(true)
    expect(screen.getByTestId("payment-required-billing-link")).toBeTruthy()
    expect(screen.getByTestId("payment-required-notice").textContent).toContain("Open Billing")
  })

  it("on Android: unchanged", () => {
    runIn("android")
    mount(false)
    expect(screen.getByTestId("payment-required-billing-link")).toBeTruthy()
  })

  it("in the iOS app: a plain sentence, no link, no Billing", () => {
    runIn("ios")
    for (const outOfCredits of [true, false]) {
      mount(outOfCredits)
      const notice = screen.getByTestId("payment-required-notice")
      expect(screen.queryByTestId("payment-required-billing-link")).toBeNull()
      expect(notice.querySelector("a, button")).toBeNull()
      expect(notice.textContent).not.toMatch(/Billing|buy|Open/)
      expect(notice.textContent).toContain("Liaison on the web")
      cleanup()
    }
  })

  it("the refused send's toast follows the same rule", () => {
    const err = new ApiError("Usage is paused", 402, "payment_required")
    runIn("browser")
    expect(sendFailureToast(err, t).message).toBe("t:cloud-limits.billing.paymentRequired")
    runIn("ios")
    expect(sendFailureToast(err, t).message).toBe("t:cloud-limits.native.paymentRequired")
  })
})

describe("plan limits", () => {
  const managed = () => ensureBillingModeLoaded({ get: async () => ({ mode: "managed" }) } as never)

  it("on the web the refusal points at a larger plan in Billing", async () => {
    runIn("browser")
    await managed()
    expect(capLimitMessage(t, "SEAT_LIMIT_REACHED")).toBe("t:cloud-limits.caps.seatLimitReached")
  })

  it("in the iOS app it states the limit and the free way out only", async () => {
    runIn("ios")
    await managed()
    expect(capLimitMessage(t, "SEAT_LIMIT_REACHED")).toBe("t:cloud-limits.native.seatLimitReached")
    expect(capLimitMessage(t, "STORAGE_QUOTA_EXCEEDED")).toBe(
      "t:cloud-limits.native.storageLimitReached",
    )
    expect(capLimitMessage(t, "CUSTOM_APP_LIMIT_REACHED")).toBe(
      "t:cloud-limits.native.customAppLimitReached",
    )
  })
})

describe("the rest of the purchase surfaces", () => {
  it("a locked model says why without asking to upgrade in the iOS app", () => {
    runIn("browser")
    expect(modelLockedReasonKey()).toBe("kernel.upgradeToChangeModel")
    runIn("ios")
    expect(modelLockedReasonKey()).toBe("kernel.modelSetByPlan")
  })

  it("the product's own site is recognised, other links are not", () => {
    expect(isProductSiteUrl("https://liaison.sh/docs/admin/settings/")).toBe(true)
    expect(isProductSiteUrl("https://demo.liaison.sh")).toBe(true)
    expect(isProductSiteUrl("https://github.com/example/repo")).toBe(false)
    expect(isProductSiteUrl("not a url")).toBe(false)
  })

  it("the automatic top-up row is a Billing row", () => {
    expect(isBillingRow({ app: "kernel", entity: "billing" })).toBe(true)
    expect(isBillingRow({ app: "kernel", entity: "org_cap" })).toBe(false)
  })
})
