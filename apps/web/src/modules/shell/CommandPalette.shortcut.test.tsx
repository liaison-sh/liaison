// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A command's keystroke is declared as a platform-neutral `mod+<key>` spec.
 * The palette used to print whatever string the registration carried, so a
 * command with a spec showed the raw spec and a command with none showed
 * nothing at all next to the command glyph: the reader never learned the
 * keystroke. One formatter now serves the palette and the shortcuts overlay.
 */
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerCommand, resetRegistry } from "~/framework/app-registry"
import { ApiProvider } from "~/modules/shell/ApiContext"
import CommandPalette from "~/modules/shell/CommandPalette"
import { formatKeyLabel } from "~/modules/shell/key-label"
import { resetTabStore } from "~/modules/shell/tab-store"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: { threads: [], users: [] } })),
    }),
  ),
)

function renderPalette() {
  const [isOpen] = createSignal(true)
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <CommandPalette isOpen={isOpen()} onClose={() => {}} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("formatKeyLabel", () => {
  it("names the platform modifier and KEEPS the key it is pressed with", () => {
    expect(formatKeyLabel("mod+.", true)).toBe("⌘ + .")
    expect(formatKeyLabel("mod+.", false)).toBe("Ctrl + .")
    expect(formatKeyLabel("mod+shift+t", true)).toBe("⌘ + ⇧ + T")
    expect(formatKeyLabel("mod+shift+t", false)).toBe("Ctrl + Shift + T")
    expect(formatKeyLabel("escape", false)).toBe("Esc")
  })
})

describe("CommandPalette shortcut column", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("prints the full platform label for a command that declares a keystroke", () => {
    registerCommand({
      id: "test:toggle-chat",
      label: "Toggle chat",
      shortcut: "mod+.",
      execute: vi.fn(),
    })
    renderPalette()
    const row = screen.getByText("Toggle chat").closest("button")
    expect(row).not.toBeNull()
    // The whole keystroke, not the bare modifier and not the raw `mod+.` spec.
    expect(row?.textContent).toContain(formatKeyLabel("mod+.", false))
    expect(row?.textContent).not.toContain("mod+")
  })

  it("prints nothing extra for a command with no keystroke", () => {
    registerCommand({ id: "test:plain", label: "Plain command", execute: vi.fn() })
    renderPalette()
    const row = screen.getByText("Plain command").closest("button")
    expect(row?.textContent?.trim()).toBe("Plain command")
  })
})
