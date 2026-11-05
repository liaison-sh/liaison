// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { ContextualSaveBar } from "./ContextualSaveBar"

describe("ContextualSaveBar", () => {
  afterEach(() => cleanup())

  it("hidden when dirty=false; visible when dirty=true", () => {
    const [dirty, setDirty] = createSignal(false)
    render(() => <ContextualSaveBar dirty={dirty()} onSave={() => {}} onDiscard={() => {}} />)
    expect(screen.queryByText("Unsaved changes")).toBeNull()
    setDirty(true)
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
  })

  it("Save click invokes onSave; Cmd+S submits; Esc invokes onDiscard", () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(() => <ContextualSaveBar dirty onSave={onSave} onDiscard={onDiscard} />)
    fireEvent.click(screen.getByTestId("save-bar-save"))
    expect(onSave).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: "s", metaKey: true })
    expect(onSave).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onDiscard).toHaveBeenCalled()
  })

  it("disabled state during in-flight save", () => {
    render(() => <ContextualSaveBar dirty saving onSave={() => {}} onDiscard={() => {}} />)
    const saveBtn = screen.getByTestId("save-bar-save") as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it("does not fire Cmd+S when not dirty", () => {
    const onSave = vi.fn()
    render(() => <ContextualSaveBar dirty={false} onSave={onSave} onDiscard={() => {}} />)
    fireEvent.keyDown(document, { key: "s", metaKey: true })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("inactive tab: Escape does not discard and Cmd+S does not save (dirty)", () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(() => (
      <TabVisibilityProvider value={() => false}>
        <ContextualSaveBar dirty onSave={onSave} onDiscard={onDiscard} />
      </TabVisibilityProvider>
    ))
    fireEvent.keyDown(document, { key: "s", metaKey: true })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it("active tab (explicit provider): Escape discards and Cmd+S saves", () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    render(() => (
      <TabVisibilityProvider value={() => true}>
        <ContextualSaveBar dirty onSave={onSave} onDiscard={onDiscard} />
      </TabVisibilityProvider>
    ))
    fireEvent.keyDown(document, { key: "s", metaKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })
})
