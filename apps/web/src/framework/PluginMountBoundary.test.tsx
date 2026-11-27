// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import type { Component } from "solid-js"
import { describe, expect, it } from "vitest"
import { PluginMountBoundary } from "~/framework/PluginMountBoundary"

const Crasher: Component = () => {
  throw new Error("boom")
}
const Good: Component = () => <div data-testid="good">ok</div>

describe("PluginMountBoundary", () => {
  it("named fallback contains app name + error message when child throws", () => {
    const { container } = render(() => (
      <PluginMountBoundary appName="shopify">
        <Crasher />
      </PluginMountBoundary>
    ))
    expect(container.textContent).toMatch(/shopify/i)
    expect(container.textContent).toMatch(/boom/)
    expect(container.querySelector("[data-testid=plugin-mount-error-shopify]")).not.toBeNull()
  })

  it("child renders unchanged when nothing throws", () => {
    const { container } = render(() => (
      <PluginMountBoundary appName="shopify">
        <Good />
      </PluginMountBoundary>
    ))
    expect(container.querySelector("[data-testid=good]")?.textContent).toBe("ok")
  })

  it("non-Error throws are stringified safely", () => {
    const StrCrasher: Component = () => {
      throw "string-thrown"
    }
    const { container } = render(() => (
      <PluginMountBoundary appName="x">
        <StrCrasher />
      </PluginMountBoundary>
    ))
    expect(container.textContent).toMatch(/string-thrown/)
  })
})

describe("PluginMountBoundary and the request limit", () => {
  it("a 429 is a calm wait with a retry that mounts the part again, not a crash", async () => {
    const { ApiError } = await import("~/lib/api-error")
    const { fireEvent } = await import("@solidjs/testing-library")
    let refuse = true
    const Limited: Component = () => {
      if (refuse) throw new ApiError("Too many requests", 429)
      return <div data-testid="limited-ok">ok</div>
    }
    const { container, getByRole, findByTestId } = render(() => (
      <PluginMountBoundary appName="calendar">
        <Limited />
      </PluginMountBoundary>
    ))
    expect(container.querySelector("[data-testid=plugin-mount-error-calendar]")).toBeNull()
    expect(container.querySelector("[data-testid=plugin-mount-busy-calendar]")).not.toBeNull()
    expect(container.textContent).not.toMatch(/crashed/i)
    refuse = false
    fireEvent.click(getByRole("button"))
    expect((await findByTestId("limited-ok")).textContent).toBe("ok")
  })
})
