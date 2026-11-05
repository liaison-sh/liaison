// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Custom headers (S28): a saved header shows only its name; its value is
// write-only. The editor's patch is the API's: value sets, null removes.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CustomHeadersEditor, type HeaderPatch } from "~/modules/mcp-manager/CustomHeadersEditor"

afterEach(cleanup)

describe("CustomHeadersEditor", () => {
  it("shows saved names with an empty value; replacing, removing and adding make one patch", () => {
    const onChange = vi.fn<(p: HeaderPatch) => void>()
    render(() => (
      <CustomHeadersEditor savedNames={["X-Workspace", "X-Region"]} onChange={onChange} />
    ))
    const name0 = screen.getByTestId("mcp-header-name-0") as HTMLInputElement
    expect(name0.value).toBe("X-Workspace")
    expect(name0).toBeDisabled()
    expect((screen.getByTestId("mcp-header-value-0") as HTMLInputElement).value).toBe("")

    // Untouched saved headers say nothing (they stay as they are).
    fireEvent.click(screen.getByTestId("mcp-header-add"))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.input(screen.getByTestId("mcp-header-value-0"), { target: { value: "new-ws" } })
    fireEvent.click(screen.getByTestId("mcp-header-remove-1"))
    fireEvent.input(screen.getByTestId("mcp-header-name-2"), { target: { value: "X-Tenant" } })
    fireEvent.input(screen.getByTestId("mcp-header-value-2"), { target: { value: "t-1" } })
    expect(onChange).toHaveBeenLastCalledWith({
      "X-Workspace": "new-ws",
      "X-Region": null,
      "X-Tenant": "t-1",
    })

    // Keeping the removed one again drops it from the patch.
    fireEvent.click(screen.getByTestId("mcp-header-remove-1"))
    expect(onChange).toHaveBeenLastCalledWith({ "X-Workspace": "new-ws", "X-Tenant": "t-1" })
  })

  it("a new row removed again leaves nothing", () => {
    const onChange = vi.fn<(p: HeaderPatch) => void>()
    render(() => <CustomHeadersEditor onChange={onChange} />)
    fireEvent.click(screen.getByTestId("mcp-header-add"))
    fireEvent.input(screen.getByTestId("mcp-header-name-0"), { target: { value: "X-A" } })
    fireEvent.input(screen.getByTestId("mcp-header-value-0"), { target: { value: "1" } })
    expect(onChange).toHaveBeenLastCalledWith({ "X-A": "1" })
    fireEvent.click(screen.getByTestId("mcp-header-remove-0"))
    expect(onChange).toHaveBeenLastCalledWith({})
    expect(screen.queryByTestId("mcp-header-row-0")).toBeNull()
  })
})
