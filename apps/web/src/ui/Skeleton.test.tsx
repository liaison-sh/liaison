// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { Skeleton } from "~/ui/Skeleton"

describe("Skeleton", () => {
  it("renders a div with pulse animation", () => {
    const { container } = render(() => <Skeleton class="h-4 w-32" />)
    const el = container.firstElementChild!
    expect(el.tagName).toBe("DIV")
    expect(el.className).toContain("animate-pulse")
    expect(el.className).toContain("bg-surface-hover")
  })

  it("applies custom class names", () => {
    const { container } = render(() => <Skeleton class="h-8 w-full rounded-lg" />)
    const el = container.firstElementChild!
    expect(el.className).toContain("h-8")
    expect(el.className).toContain("w-full")
    expect(el.className).toContain("rounded-lg")
  })
})
