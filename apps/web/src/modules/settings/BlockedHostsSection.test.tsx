// SPDX-License-Identifier: FSL-1.1-ALv2
// The AI models page's "Blocked hosts" setting: what it shows and the request
// each change sends (add, remove, reset to the server's default).

import type { BlockedHostsView } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { BlockedHostsSection } from "./BlockedHostsSection"

const DEFAULT: BlockedHostsView = {
  hosts: ["OpenInference"],
  isDefault: true,
  defaultHosts: ["OpenInference"],
}

function setup(initial: BlockedHostsView) {
  const patch = vi
    .fn()
    .mockImplementation(async (_path: string, body: { blockedHosts: string[] | null }) => ({
      blockedHosts:
        body.blockedHosts === null
          ? DEFAULT
          : { hosts: body.blockedHosts, isDefault: false, defaultHosts: DEFAULT.defaultHosts },
    }))
  const onSaved = vi.fn()
  const api: Partial<ApiClient> = { patch }
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api as ApiClient}>
        <BlockedHostsSection value={initial} onSaved={onSaved} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { patch, onSaved }
}

const input = () => screen.getByTestId("ai-models-blocked-hosts-input") as HTMLInputElement

afterEach(() => cleanup())

describe("Blocked hosts setting", () => {
  it("shows the server's default list with its help line and no reset", () => {
    setup(DEFAULT)
    const section = screen.getByTestId("ai-models-blocked-hosts")
    expect(section.textContent).toContain("Blocked hosts")
    expect(section.textContent).toContain(
      "OpenRouter never routes this workspace's requests to these hosts.",
    )
    expect(screen.getByTestId("ai-models-blocked-host-OpenInference")).toBeTruthy()
    expect(screen.getByTestId("ai-models-blocked-hosts-default")).toBeTruthy()
    expect(screen.queryByTestId("ai-models-blocked-hosts-reset")).toBeNull()
  })

  it("adds a host: saves the whole list, shows the chip and offers the reset", async () => {
    const { patch, onSaved } = setup(DEFAULT)
    fireEvent.input(input(), { target: { value: "  Wafer " } })
    fireEvent.click(screen.getByTestId("ai-models-blocked-hosts-add"))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/ai/models", {
        blockedHosts: ["OpenInference", "Wafer"],
      }),
    )
    await waitFor(() => expect(screen.getByTestId("ai-models-blocked-host-Wafer")).toBeTruthy())
    expect(screen.getByTestId("ai-models-blocked-hosts-reset")).toBeTruthy()
    expect(onSaved).toHaveBeenCalled()
    expect(input().value).toBe("")
  })

  it("does not add a host already on the list (any case)", () => {
    const { patch } = setup(DEFAULT)
    fireEvent.input(input(), { target: { value: "openinference" } })
    const add = screen.getByTestId("ai-models-blocked-hosts-add") as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(patch).not.toHaveBeenCalled()
  })

  it("removes a host; an empty list says no host is blocked", async () => {
    const { patch } = setup({ ...DEFAULT, hosts: ["Wafer"], isDefault: false })
    fireEvent.click(screen.getByTestId("ai-models-blocked-host-remove-Wafer"))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/ai/models", { blockedHosts: [] }),
    )
    await waitFor(() => expect(screen.getByTestId("ai-models-blocked-hosts-none")).toBeTruthy())
  })

  it("resets to the server's default by sending null", async () => {
    const { patch } = setup({ ...DEFAULT, hosts: ["Wafer"], isDefault: false })
    fireEvent.click(screen.getByTestId("ai-models-blocked-hosts-reset"))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/ai/models", { blockedHosts: null }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("ai-models-blocked-host-OpenInference")).toBeTruthy(),
    )
    expect(screen.queryByTestId("ai-models-blocked-hosts-reset")).toBeNull()
  })
})
