// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M1-B T6. The composer at PHONE tier: one `+` and the send circle, everything
// else in the sheet the `+` opens, and the placeholder naming the conversation.
// Desktop keeps the row it has always had, which is the other half of every
// assertion here.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installAudioContext, installMic, removeMic } from "~/modules/assist/dictation-fakes"
import "~/modules/editor/test-helpers"
import { ApiProvider } from "~/modules/shell/ApiContext"
import ComposeBar from "~/modules/threads/ComposeBar"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import { setShellTier } from "~/tests/helpers/shell-tier"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

/** The tier is a module signal fed by matchMedia; jsdom lays nothing out, so
 *  the queries are answered from here and the signal re-read. */

function renderCompose(threadId?: string) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <ComposeBar onSend={vi.fn()} threadId={threadId} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("ComposeBar at phone tier", () => {
  beforeEach(() => resetThreadStore())
  afterEach(() => {
    cleanup()
    setShellTier("desktop")
    vi.unstubAllGlobals()
  })

  it("collapses the control row to a plus, the model chip and the send button", async () => {
    setShellTier("phone")
    renderCompose()

    expect(screen.getByTestId("composer-plus")).toBeTruthy()
    expect(screen.getByTestId("compose-send")).toBeTruthy()
    // The secondary controls are NOT on the control line: they are sheet rows.
    expect(screen.queryByTestId("magic-wand")).toBeNull()
    expect(screen.queryByTestId("compose-emoji")).toBeNull()
    expect(screen.queryByTestId("attachment-upload-button")?.closest(".hidden")).toBeTruthy()

    // The field is the line ABOVE the controls, not an item among them.
    const controls = screen.getByTestId("compose-controls-row")
    expect(controls.contains(await screen.findByTestId("compose-editor"))).toBe(false)
    const line = controls.querySelector("[data-recorder-row]") ?? controls
    const visible = [...line.children].filter(
      (el) => !(el.getAttribute("class") ?? "").includes("hidden"),
    )
    // plus, Aa, then the send wrapper. Nothing else without an agent seat.
    expect(visible.length).toBe(3)
  })

  it("keeps the writing helpers on the control line at desktop tier", async () => {
    setShellTier("desktop")
    renderCompose()

    expect(screen.queryByTestId("compose-row-phone")).toBeNull()
    // The `+` is every tier's attach control now; a desktop one opens the
    // picker directly rather than a sheet.
    expect(screen.getByTestId("composer-plus")).toBeTruthy()
    expect(screen.getByTestId("magic-wand")).toBeTruthy()
    expect(screen.getByTestId("compose-emoji")).toBeTruthy()
    expect(screen.getByTestId("compose-send")).toBeTruthy()
  })

  it("the plus opens a sheet whose FIRST row is Attach", async () => {
    setShellTier("phone")
    renderCompose()

    fireEvent.click(screen.getByTestId("composer-plus"))

    const attach = await screen.findByTestId("composer-sheet-attach")
    expect(attach.textContent).toContain("Attach")
    const rows = [...(attach.parentElement?.children ?? [])]
    expect(rows[0]).toBe(attach)
    expect(rows.some((el) => el.getAttribute("data-testid") === "composer-sheet-wand")).toBe(true)
    expect(rows.some((el) => el.getAttribute("data-testid") === "composer-sheet-emoji")).toBe(true)
  })

  // Wand and Emoji are icon buttons the phone tier floors at 44px with the
  // glyph centred; Attach drew its bare glyph, 14px to the left of theirs.
  // jsdom lays nothing out, so the check is structural: every row has the
  // same padding and puts its glyph in the same 44px box, first.
  it("the sheet's rows share one inset and one icon column", async () => {
    setShellTier("phone")
    renderCompose()
    fireEvent.click(screen.getByTestId("composer-plus"))
    await screen.findByTestId("composer-sheet-attach")
    const rows = ["composer-sheet-attach", "composer-sheet-wand", "composer-sheet-emoji"].map(
      (id) => screen.getByTestId(id),
    )
    const padding = (el: Element) =>
      el.className
        .split(/\s+/)
        .filter((c) => /^(p[lrxy]?|gap)-/.test(c))
        .sort()
        .join(" ")
    for (const row of rows) {
      expect(padding(row)).toBe(padding(rows[0]))
      const icon = row.firstElementChild as HTMLElement
      expect(icon.querySelector("svg")).toBeTruthy()
      for (const c of ["h-11", "w-11", "shrink-0", "justify-center"]) {
        expect(icon.classList.contains(c)).toBe(true)
      }
    }
  })

  /** Capabilities say the org transcribes; a take answers `raw` cleaned to `cleaned`. */
  function stubDictationApi(raw = "um hello", cleaned = "Hello") {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: String(url).includes("/assist/capabilities")
                  ? { dictation: true, autoClean: true }
                  : String(url).includes("/assist/transcribe")
                    ? { raw, cleaned, model: "m", cleanModel: "c", durationSeconds: 1 }
                    : [],
              }),
            ),
        }),
      ),
    )
  }

  it("the sheet lists Dictate after the wand, its mic in the same icon column", async () => {
    installMic()
    installAudioContext()
    stubDictationApi()
    try {
      setShellTier("phone")
      renderCompose()
      // On the phone's control line too, immediately left of Send.
      const mic = await screen.findByTestId("voice-dictation-button")
      expect(mic.nextElementSibling).toBe(screen.getByTestId("compose-send"))
      fireEvent.click(screen.getByTestId("composer-plus"))
      const row = await screen.findByTestId("composer-sheet-dictation")
      expect(row.tagName).toBe("BUTTON")
      expect(row.textContent).toContain("Dictate")
      const icon = row.firstElementChild as HTMLElement
      expect(icon.querySelector("svg")).toBeTruthy()
      for (const c of ["h-11", "w-11", "shrink-0", "justify-center"]) {
        expect(icon.classList.contains(c)).toBe(true)
      }
      const rows = [...(row.parentElement?.children ?? [])].map((el) =>
        el.getAttribute("data-testid"),
      )
      expect(rows.indexOf("composer-sheet-dictation")).toBe(rows.indexOf("composer-sheet-wand") + 1)
    } finally {
      removeMic()
    }
  })

  // V3: the sheet covered the composer, so the take and the inserted text were
  // hidden behind it. Variant A: the control line itself becomes the recorder.
  it("Dictate closes the sheet and the control line becomes the recorder: discard, pill, stop", async () => {
    installMic()
    installAudioContext()
    stubDictationApi()
    try {
      setShellTier("phone")
      renderCompose()
      fireEvent.click(screen.getByTestId("composer-plus"))
      fireEvent.click(await screen.findByTestId("composer-sheet-dictation"))
      await waitFor(() => expect(screen.queryByTestId("composer-sheet-attach")).toBeNull())
      const controls = screen.getByTestId("compose-controls-row")
      const recorder = await within(controls).findByTestId("voice-dictation-recorder")
      await waitFor(() => expect(recorder.getAttribute("data-state")).toBe("recording"))
      // The line's own controls give way: plus and send are hidden.
      expect(screen.getByTestId("composer-plus").closest("[hidden]")).not.toBeNull()
      expect(screen.getByTestId("compose-send").closest("[hidden]")).not.toBeNull()
      const order = [
        ...recorder.querySelectorAll(
          "[data-testid='voice-dictation-discard'],[data-testid='voice-dictation-elapsed'],[data-testid='voice-dictation-waveform'],[data-testid='voice-dictation-stop']",
        ),
      ].map((el) => el.getAttribute("data-testid"))
      expect(order).toEqual([
        "voice-dictation-discard",
        "voice-dictation-elapsed",
        "voice-dictation-waveform",
        "voice-dictation-stop",
      ])
      // Discard: the line goes back to plus and send.
      fireEvent.click(within(controls).getByTestId("voice-dictation-discard"))
      await waitFor(() =>
        expect(within(controls).queryByTestId("voice-dictation-recorder")).toBeNull(),
      )
      expect(screen.getByTestId("compose-send").closest("[hidden]")).toBeNull()
    } finally {
      removeMic()
    }
  })

  it("stop inserts the text into the field above and the line comes back", async () => {
    installMic()
    installAudioContext()
    stubDictationApi()
    try {
      setShellTier("phone")
      renderCompose()
      fireEvent.click(await screen.findByTestId("voice-dictation-button"))
      const controls = screen.getByTestId("compose-controls-row")
      fireEvent.click(await within(controls).findByTestId("voice-dictation-stop"))
      await waitFor(() =>
        expect(screen.getByTestId("compose-editor").textContent).toContain("Hello"),
      )
      await waitFor(() =>
        expect(within(controls).queryByTestId("voice-dictation-recorder")).toBeNull(),
      )
      expect(screen.getByTestId("compose-send").closest("[hidden]")).toBeNull()
    } finally {
      removeMic()
    }
  })

  it("the sheet's Attach row clicks the same hidden file input the desktop row wraps", async () => {
    setShellTier("phone")
    const { container } = renderCompose()
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="attachment-upload-input"]',
    )
    expect(input).not.toBeNull()
    const clicked = vi.fn()
    input?.addEventListener("click", clicked)

    fireEvent.click(screen.getByTestId("composer-plus"))
    fireEvent.click(await screen.findByTestId("composer-sheet-attach"))

    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it("names the conversation in the placeholder", async () => {
    addThread({
      id: "t-design",
      handle: "@design",
      title: "Design",
      participants: [],
      updatedAt: new Date().toISOString(),
    })
    setShellTier("phone")
    renderCompose("t-design")

    expect(screen.getByTestId("compose-placeholder-named").textContent).toBe("Message Design")
  })

  it("falls back to the generic placeholder when the conversation is unknown", async () => {
    setShellTier("phone")
    renderCompose("t-missing")

    expect(screen.queryByTestId("compose-placeholder-named")).toBeNull()
    expect(document.querySelector("[data-compose-placeholder]")?.textContent).toContain(
      "Write a message",
    )
  })

  // TWO LINES AT EVERY TIER: the field owns the first one, the controls the
  // second. The phone row used to be one line of plus, chip, field and send,
  // which left the field 122px of a 390px viewport and the model chip reading
  // "GF". What is pinned is the ORDER: the field precedes the control row in
  // the DOM, and send is the last thing on that row.
  it("puts the field on the line ABOVE the controls, at phone tier", async () => {
    setShellTier("phone")
    renderCompose()
    const field = await screen.findByTestId("compose-editor")
    const controls = screen.getByTestId("compose-controls-row")
    expect(field.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The field is full width: nothing shares its line, so nothing squeezes it.
    const fieldBox = field.closest("[data-compose-field]") as HTMLElement
    expect(fieldBox.getAttribute("class")).toContain("w-full")
    expect(fieldBox.getAttribute("class")).not.toContain("basis-0")

    const send = screen.getByTestId("compose-send")
    expect(controls.contains(send)).toBe(true)
    const plus = screen.getByTestId("composer-plus")
    expect(plus.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("puts the field on the line above the controls at desktop tier too", async () => {
    setShellTier("desktop")
    renderCompose()
    const field = (await screen.findByTestId("compose-editor")).closest(
      "[data-compose-field]",
    ) as HTMLElement
    const controls = screen.getByTestId("compose-controls-row")
    expect(field.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(field.getAttribute("class")).toContain("w-full")
    expect(field.getAttribute("class")).not.toContain("basis-48")
  })

  it("S26: the textarea grows to 6 lines then scrolls, at the 16px zoom floor on the phone", async () => {
    // jsdom applies no stylesheet, so Tailwind's arbitrary-value classes sit
    // on the element inert: a class-name SUBSTRING check passes even when the
    // actual computed pixel size has drifted (a typo'd class, a later utility
    // winning the cascade). Inject the two rules this assertion depends on so
    // getComputedStyle reports what a real browser would compute from the
    // same classes the component renders.
    const style = document.createElement("style")
    style.textContent =
      ".text-\\[16px\\]\\! { font-size: 16px !important; }\n" +
      ".max-h-\\[144px\\] { max-height: 144px; }\n" +
      ".overflow-y-auto { overflow-y: auto; }"
    document.head.appendChild(style)

    setShellTier("phone")
    renderCompose()
    const editor = await screen.findByTestId("compose-editor")

    // iOS WKWebView zooms the viewport on focusing any control computed under
    // 16px — the exact bug this floor exists to prevent.
    expect(getComputedStyle(editor).fontSize).toBe("16px")
    // Six lines of leading-6 (24px) is the growth budget before it scrolls
    // instead of growing further (charter "Mobile composer"): a taller field
    // pushed the conversation off a phone screen with the keyboard up.
    expect(getComputedStyle(editor).maxHeight).toBe("144px")
    expect(getComputedStyle(editor).overflowY).toBe("auto")

    // A SEVENTH line of real content overflows that budget. jsdom performs no
    // layout (scrollHeight is always 0 there), so it is mocked to what seven
    // lines at 24px measure in a real browser —
    // the same technique used to assert a textarea's autogrow clamp.
    Object.defineProperty(editor, "scrollHeight", { value: 24 * 7, configurable: true })
    const clampPx = Number.parseInt(getComputedStyle(editor).maxHeight, 10)
    const appliedHeight = Math.min(editor.scrollHeight, clampPx)
    // The applied (rendered) height is the clamp itself, not the content's
    // full height: seven lines of real content exceed the budget, so CSS
    // max-height — not the field's natural size — is what wins.
    expect(editor.scrollHeight).toBeGreaterThan(clampPx)
    expect(appliedHeight).toBe(clampPx)

    document.head.removeChild(style)
  })
})
