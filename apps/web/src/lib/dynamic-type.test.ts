// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "vitest"
import { applyDynamicType, DYNAMIC_TYPE_DEFAULT_PX, dynamicTypeZoomPercent } from "./dynamic-type"

afterEach(() => {
  document.body.style.removeProperty("-webkit-text-size-adjust")
  document.body.style.removeProperty("text-size-adjust")
})

describe("iOS Dynamic Type", () => {
  it("the default size leaves the page as designed", () => {
    expect(dynamicTypeZoomPercent(DYNAMIC_TYPE_DEFAULT_PX)).toBe(100)
  })

  it("the standard sizes scale the text, xSmall to xxxLarge", () => {
    expect(dynamicTypeZoomPercent(14)).toBe(82)
    expect(dynamicTypeZoomPercent(19)).toBe(112)
    expect(dynamicTypeZoomPercent(23)).toBe(135)
  })

  it("the accessibility sizes stop at the largest standard size, so the phone rows still fit", () => {
    expect(dynamicTypeZoomPercent(53)).toBe(135)
    expect(dynamicTypeZoomPercent(10)).toBe(82)
  })

  it("an unreadable size changes nothing", () => {
    expect(dynamicTypeZoomPercent(Number.NaN)).toBe(100)
    expect(dynamicTypeZoomPercent(0)).toBe(100)
  })

  it("a browser without the system font gets no zoom at all", () => {
    applyDynamicType(document)
    expect(document.body.style.getPropertyValue("-webkit-text-size-adjust")).toBe("")
  })
})
