// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { Input } from "~/ui/Input"

describe("Input", () => {
  it("renders an input element", () => {
    render(() => <Input placeholder="Email" />)
    expect(screen.getByPlaceholderText("Email")).toBeInTheDocument()
  })

  it("applies error styles when error prop is set", () => {
    render(() => <Input error="Required field" />)
    const input = screen.getByRole("textbox")
    expect(input.className).toContain("border-error")
  })

  it("renders error message", () => {
    render(() => <Input error="Required field" />)
    expect(screen.getByText("Required field")).toBeInTheDocument()
  })

  it("renders label when provided", () => {
    render(() => <Input label="Email" />)
    expect(screen.getByText("Email")).toBeInTheDocument()
  })

  it("calls onInput handler", () => {
    const handler = vi.fn()
    render(() => <Input onInput={handler} />)
    fireEvent.input(screen.getByRole("textbox"), { target: { value: "test" } })
    expect(handler).toHaveBeenCalled()
  })

  it("supports type=password", () => {
    render(() => <Input type="password" placeholder="Password" />)
    const input = screen.getByPlaceholderText("Password")
    expect(input).toHaveAttribute("type", "password")
  })
})
