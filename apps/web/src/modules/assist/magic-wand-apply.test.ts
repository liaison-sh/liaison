// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { applyCorrection, readTarget } from "./magic-wand-apply"

describe("readTarget", () => {
  it("returns the whole textarea value (and a whole-value region) when nothing is selected", () => {
    const ta = document.createElement("textarea")
    ta.value = "teh cat"
    ta.setSelectionRange(0, 0)
    const r = readTarget(ta, "text")
    expect(r.text).toBe("teh cat")
    expect(r.format).toBe("text")
    expect(r.target.region).toEqual({ type: "textarea", start: 0, end: 7 })
  })

  it("returns only the selected substring of a textarea (and its exact region)", () => {
    const ta = document.createElement("textarea")
    ta.value = "hello teh cat"
    ta.setSelectionRange(6, 9) // "teh"
    const r = readTarget(ta, "text")
    expect(r.text).toBe("teh")
    expect(r.format).toBe("text")
    expect(r.target.region).toEqual({ type: "textarea", start: 6, end: 9 })
  })

  it("returns whole innerHTML (and an all-contents region) for a contentEditable with no selection", () => {
    const div = document.createElement("div")
    div.innerHTML = "<p>teh cat</p>"
    const r = readTarget(div, "html")
    expect(r.text).toBe("<p>teh cat</p>")
    expect(r.format).toBe("html")
    expect(r.target.region).toEqual({ type: "all" })
  })
})

describe("applyCorrection", () => {
  // happy-dom does not implement document.execCommand at all (the property is
  // undefined), so vi.spyOn can't wrap it — install a fresh mock per test. The
  // real browser behaviour (mutation + native undo) is exercised by the Task 8
  // Playwright journey.
  function stubExec(): ReturnType<typeof vi.fn> {
    const exec = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: typeof exec }).execCommand = exec
    return exec
  }

  it("restores the captured whole-value region then insertText for a textarea", () => {
    const ta = document.createElement("textarea")
    ta.value = "teh"
    document.body.appendChild(ta)
    ta.setSelectionRange(0, 0)
    const { target } = readTarget(ta, "text")
    // Caret moves AFTER read (simulating the user during the async call) — the
    // captured region must win, not the live caret.
    ta.setSelectionRange(1, 1)
    const exec = stubExec()
    applyCorrection(target, "the")
    expect(ta.selectionStart).toBe(0)
    expect(ta.selectionEnd).toBe(3) // captured whole-value region restored
    expect(exec).toHaveBeenCalledWith("insertText", false, "the")
  })

  it("uses insertHTML for an html target", () => {
    const div = document.createElement("div")
    div.contentEditable = "true"
    div.innerHTML = "<p>teh</p>"
    document.body.appendChild(div)
    const { target } = readTarget(div, "html")
    const exec = stubExec()
    applyCorrection(target, "<p>the</p>")
    expect(exec).toHaveBeenCalledWith("insertHTML", false, "<p>the</p>")
  })
})
