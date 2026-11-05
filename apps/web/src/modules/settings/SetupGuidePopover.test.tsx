// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { SetupGuidePopover } from "./SetupGuidePopover"

describe("SetupGuidePopover", () => {
  it("renders no `?` trigger when there is no setupGuide", () => {
    render(() => <SetupGuidePopover guide={undefined} />)
    expect(screen.queryByTestId("setup-guide-trigger")).not.toBeInTheDocument()
  })

  it("renders no `?` trigger for an empty setupGuide object", () => {
    render(() => <SetupGuidePopover guide={{}} />)
    expect(screen.queryByTestId("setup-guide-trigger")).not.toBeInTheDocument()
  })

  it("shows summary, each step, and the docs link when opened", async () => {
    render(() => (
      <SetupGuidePopover
        guide={{
          summary: "Connect read-only.",
          steps: ["Open settings", "Create a token"],
          docsUrl: "https://docs.test/guide",
        }}
      />
    ))
    fireEvent.click(screen.getByRole("button", { name: /how to connect/i }))
    expect(await screen.findByTestId("setup-guide-content")).toHaveTextContent("Connect read-only.")
    const steps = await screen.findAllByTestId("setup-guide-step")
    expect(steps).toHaveLength(2)
    expect(steps[0]).toHaveTextContent("Open settings")
    expect(steps[1]).toHaveTextContent("Create a token")
    expect(screen.getByTestId("setup-guide-docs")).toHaveAttribute(
      "href",
      "https://docs.test/guide",
    )
  })

  it("renders markdown inside a step as sanitized HTML", async () => {
    render(() => <SetupGuidePopover guide={{ steps: ["Open **Settings**"] }} />)
    fireEvent.click(screen.getByRole("button", { name: /how to connect/i }))
    const step = await screen.findByTestId("setup-guide-step")
    expect(step.innerHTML).toContain("<strong>")
    expect(step).toHaveTextContent("Settings")
  })
})
