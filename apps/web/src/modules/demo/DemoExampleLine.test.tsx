// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The example line says the company is an example, in the world's own words,
// and says nothing where the world is not known.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DemoExampleLine } from "~/modules/demo/DemoExampleLine"
import { _resetDemoWorld, _setDemoWorld } from "~/modules/demo/demo-world"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import kernelEn from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"

const mount = () =>
  render(() => (
    <I18nProvider initialLocale="en">
      <DemoExampleLine />
    </I18nProvider>
  ))

beforeEach(() => _resetDemoWorld())
afterEach(() => cleanup())

describe("the example line", () => {
  it("shows each world's own sentence for a visitor workspace of that world", () => {
    _setDemoWorld("products")
    mount()
    expect(screen.getByTestId("demo-example-line").textContent).toBe(kernelEn.demo.companyExample)
    cleanup()
    _setDemoWorld("saas")
    mount()
    expect(screen.getByTestId("demo-example-line").textContent).toBe(
      kernelEn.demo.world.saas.companyExample,
    )
    cleanup()
    _setDemoWorld("studio")
    mount()
    expect(screen.getByTestId("demo-example-line").textContent).toBe(
      kernelEn.demo.world.studio.companyExample,
    )
  })

  it("names the services company for a services visitor, in the one line the company step, welcome and Home all mount", () => {
    _setDemoWorld("studio")
    mount()
    const line = screen.getByTestId("demo-example-line").textContent ?? ""
    expect(line).toBe(kernelEn.demo.world.studio.companyExample)
    expect(line).toContain("Halden Studio")
    expect(line).not.toMatch(/Resonant|Tideform/)
  })

  it("is absent while the world is unknown: a failed read, or an org that is not a visitor's", () => {
    mount()
    expect(screen.queryByTestId("demo-example-line")).toBeNull()
  })
})
