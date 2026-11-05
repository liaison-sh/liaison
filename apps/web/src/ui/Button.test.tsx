// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { Button } from "~/ui/Button"

describe("Button", () => {
  it("renders with default variant", () => {
    render(() => <Button>Click me</Button>)
    const btn = screen.getByRole("button", { name: "Click me" })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain("bg-accent")
  })

  it("paints the accent fill with the accent foreground token, not a literal", () => {
    render(() => <Button>Send</Button>)
    const btn = screen.getByRole("button", { name: "Send" })
    expect(btn.className).toContain("bg-accent")
    expect(btn.className).toContain("text-accent-foreground")
    expect(btn.className).not.toContain("text-white")
  })

  it("renders ghost variant", () => {
    render(() => <Button variant="ghost">Ghost</Button>)
    const btn = screen.getByRole("button", { name: "Ghost" })
    expect(btn.className).not.toContain("bg-accent")
  })

  it("renders outline variant", () => {
    render(() => <Button variant="outline">Outline</Button>)
    const btn = screen.getByRole("button", { name: "Outline" })
    expect(btn.className).toContain("border")
  })

  it("renders small size", () => {
    render(() => <Button size="sm">Small</Button>)
    const btn = screen.getByRole("button", { name: "Small" })
    expect(btn.className).toContain("text-xs")
  })

  it("sizes to its label by default and spans the row only when asked", () => {
    // The default used to be w-full: in a flex row it took the whole row and
    // squeezed the text beside it to a word per line (Settings > Nodes).
    render(() => <Button>Detach</Button>)
    const detach = screen.getByRole("button", { name: "Detach" })
    expect(detach.className).not.toContain("w-full")
    // and keeps its label on one line when the row runs short
    expect(detach.className).toContain("shrink-0")
    render(() => <Button fullWidth>Sign in</Button>)
    expect(screen.getByRole("button", { name: "Sign in" }).className).toContain("w-full")
  })

  it("handles disabled state", () => {
    render(() => <Button disabled>Disabled</Button>)
    const btn = screen.getByRole("button", { name: "Disabled" })
    expect(btn).toBeDisabled()
    expect(btn.className).toContain("opacity-50")
  })

  it("calls onClick handler", () => {
    const handler = vi.fn()
    render(() => <Button onClick={handler}>Click</Button>)
    fireEvent.click(screen.getByRole("button", { name: "Click" }))
    expect(handler).toHaveBeenCalledOnce()
  })

  it("renders loading state with spinner", () => {
    render(() => <Button loading>Loading</Button>)
    const btn = screen.getByRole("button")
    expect(btn).toBeDisabled()
    expect(btn.querySelector("[data-loading]")).toBeInTheDocument()
  })
})
