// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, type JSX, Show } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { RichEditor, type RichEditorHandle } from "~/modules/editor/RichEditor"
import { editorOf } from "~/modules/editor/test-helpers"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { ComposerAssist } from "./ComposerAssist"
import {
  FakeMediaRecorder,
  installAudioContext,
  installMic,
  removeMic,
  setGlobal,
} from "./dictation-fakes"
import type { DictationTarget } from "./dictation-insert"
import { SEGMENT_MS } from "./dictation-recorder"
import { DictationMic, RecorderFold, RecorderRow, TIMER_WARN_MS, waveformBars } from "./RecorderBar"
import { useDictation } from "./useDictation"

/** A composer's control row as every surface builds it: tools, then the mic, then Send. */
function Composer(props: { target: () => DictationTarget | undefined; before?: JSX.Element }) {
  const dictation = useDictation({ target: () => props.target() })
  return (
    <div data-testid="row">
      <RecorderRow dictation={dictation}>
        <ComposerAssist target={() => props.target()} />
        <DictationMic dictation={dictation} />
        <button type="button" data-testid="send">
          Send
        </button>
      </RecorderRow>
    </div>
  )
}

function fakeApi(opts: {
  dictation?: boolean
  autoClean?: boolean
  transcribe?: (path: string, body: unknown) => unknown
}) {
  const get = vi.fn().mockImplementation(async (path: string) => {
    if (path === "/assist/capabilities") {
      return { dictation: opts.dictation ?? true, autoClean: opts.autoClean ?? true }
    }
    throw new Error(`unexpected GET ${path}`)
  })
  const post = vi.fn().mockImplementation(async (path: string, body: unknown) => {
    if (path.startsWith("/assist/transcribe")) {
      return (
        opts.transcribe?.(path, body) ?? {
          raw: "T",
          cleaned: "T",
          model: "m",
          cleanModel: null,
          durationSeconds: 1,
        }
      )
    }
    if (path === "/assist/clean-dictation") {
      const text = (body as { text: string }).text
      return { cleaned: `clean(${text})`, cleanModel: "c" }
    }
    throw new Error(`unexpected POST ${path}`)
  })
  const api: Partial<ApiClient> = { get, post }
  return { api: api as ApiClient, get, post }
}

function mountField(api: ApiClient, value = "abcdef", caret = 3) {
  const el = document.createElement("textarea")
  el.value = value
  document.body.appendChild(el)
  el.setSelectionRange(caret, caret)
  const [shown, setShown] = createSignal(true)
  const result = render(() => (
    <ApiContext.Provider value={api}>
      <Show when={shown()}>
        <Composer target={() => el} />
      </Show>
    </ApiContext.Provider>
  ))
  return { el, result, unmountAssist: () => setShown(false) }
}

/** jsdom has no insertText: this one types like a browser does, at the live selection. */
function installInsertText() {
  const exec = vi.fn((command: string, _ui: boolean, text?: string) => {
    const el = document.activeElement
    if (command !== "insertText" || !(el instanceof HTMLTextAreaElement)) return false
    el.setRangeText(text ?? "", el.selectionStart, el.selectionEnd, "end")
    el.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  })
  Object.defineProperty(document, "execCommand", { configurable: true, value: exec })
  return exec
}

const button = () => screen.getByTestId("voice-dictation-button")
const stop = () => screen.getByTestId("voice-dictation-stop")
const recorder = () => screen.queryByTestId("voice-dictation-recorder")
const state = () => recorder()?.getAttribute("data-state") ?? "idle"

async function record() {
  await waitFor(() => expect(screen.getByTestId("voice-dictation-button")).toBeInTheDocument())
  fireEvent.click(button())
  await waitFor(() => expect(state()).toBe("recording"))
}

beforeEach(() => {
  installAudioContext()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  removeMic()
  Reflect.deleteProperty(document, "execCommand")
  document.body.innerHTML = ""
})

describe("DictationMic: whether the mic shows", () => {
  it("renders the wand and the mic when the org transcribes and the runtime records", async () => {
    installMic()
    const { api, get } = fakeApi({})
    mountField(api)
    expect(screen.getByTestId("magic-wand")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("voice-dictation-button")).toBeInTheDocument())
    expect(get).toHaveBeenCalledWith("/assist/capabilities", expect.anything())
  })

  it("renders no mic at all when the org cannot transcribe", async () => {
    installMic()
    const { api, get } = fakeApi({ dictation: false })
    mountField(api)
    await waitFor(() => expect(get).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.queryByTestId("voice-dictation-button")).toBeNull()
    expect(screen.getByTestId("magic-wand")).toBeInTheDocument()
  })

  it("renders no mic where the runtime cannot record (no getUserMedia)", async () => {
    const { api, get } = fakeApi({})
    setGlobal("MediaRecorder", FakeMediaRecorder)
    mountField(api)
    await Promise.resolve()
    expect(get).not.toHaveBeenCalled()
    expect(screen.queryByTestId("voice-dictation-button")).toBeNull()
  })

  it("renders no mic where the runtime has no MediaRecorder", async () => {
    installMic()
    setGlobal("MediaRecorder", undefined)
    const { api } = fakeApi({})
    mountField(api)
    await Promise.resolve()
    expect(screen.queryByTestId("voice-dictation-button")).toBeNull()
  })
})

describe("RecorderBar: one take", () => {
  it("goes requesting → recording → transcribing → idle and inserts at the caret held from the start", async () => {
    const mic = installMic({ hold: true })
    const exec = installInsertText()
    let answer!: (v: unknown) => void
    const { api, post } = fakeApi({
      transcribe: () => new Promise((resolve) => (answer = resolve)),
    })
    const { el } = mountField(api, "abcdef", 3)
    await waitFor(() => expect(screen.getByTestId("voice-dictation-button")).toBeInTheDocument())
    fireEvent.click(button())
    await waitFor(() => expect(state()).toBe("requesting"))
    // The whole row gives way to the recorder line.
    expect(screen.getByTestId("send").closest("[hidden]")).not.toBeNull()
    mic.grant()
    await waitFor(() => expect(state()).toBe("recording"))
    expect(screen.getByTestId("voice-dictation-elapsed").textContent).toBe("0:00")
    expect(screen.getByTestId("voice-dictation-dot")).toBeInTheDocument()
    expect(screen.getByTestId("voice-dictation-waveform").tagName).toBe("CANVAS")
    expect(screen.getByTestId("voice-dictation-discard")).toBeInTheDocument()
    // Stop has a name and takes the focus.
    expect(stop().getAttribute("aria-label")).toBe("Stop and insert")
    expect(document.activeElement).toBe(stop())
    // The caret wanders off while speaking: the text still lands where it was.
    el.setSelectionRange(6, 6)
    fireEvent.click(stop())
    await waitFor(() => expect(state()).toBe("transcribing"))
    expect(screen.getByTestId("voice-dictation-label").textContent).toBe("Transcribing…")
    // Send stays out until the text is in: its place holds a disabled button.
    expect(screen.getByTestId("send").closest("[hidden]")).not.toBeNull()
    expect(screen.getByTestId("voice-dictation-pending")).toBeDisabled()
    await waitFor(() => expect(mic.track.stop).toHaveBeenCalled())
    answer({ raw: "T", cleaned: "T", model: "m", cleanModel: "c", durationSeconds: 1 })
    await waitFor(() => expect(el.value).toBe("abcTdef"))
    expect(recorder()).toBeNull()
    expect(screen.getByTestId("send").closest("[hidden]")).toBeNull()
    // The focus is back in the field, and the text carries its brief tint.
    expect(document.activeElement).toBe(el)
    expect(el.classList.contains("inserted-tint-field")).toBe(true)
    // Through the browser's insertText: one native undo takes it back out.
    expect(exec).toHaveBeenCalledWith("insertText", false, "T")
    const [path, body] = post.mock.calls[0] ?? []
    expect(path).toBe("/assist/transcribe?clean=true")
    expect(body).toBeInstanceOf(Blob)
    expect((body as Blob).type).toBe("audio/webm;codecs=opus")
  })

  it("replaces the selection held at the start", async () => {
    installMic()
    installInsertText()
    const { api } = fakeApi({})
    const { el } = mountField(api, "abcdef", 0)
    el.setSelectionRange(1, 4)
    await record()
    fireEvent.click(stop())
    await waitFor(() => expect(el.value).toBe("aTef"))
  })

  // SK6: the field changed while transcribing (the person kept typing): the
  // offsets held at the start no longer mean that place, so nothing they typed
  // is replaced and the text goes in at the caret as it is now.
  it("a field typed in meanwhile: inserts at the current caret, replacing nothing", async () => {
    installMic()
    installInsertText()
    const { api } = fakeApi({})
    const { el } = mountField(api, "abcdef", 3)
    await record()
    el.setRangeText("XY", 3, 3, "end")
    expect(el.selectionStart).toBe(5)
    fireEvent.click(stop())
    await waitFor(() => expect(el.value).toBe("abcXYTdef"))
  })

  it("a held selection the person typed over: their text stays, the dictation follows", async () => {
    installMic()
    installInsertText()
    const { api } = fakeApi({})
    const { el } = mountField(api, "abcdef", 0)
    el.setSelectionRange(1, 4)
    await record()
    el.setRangeText("Q", 1, 4, "end")
    fireEvent.click(stop())
    await waitFor(() => expect(el.value).toBe("aQTef"))
  })

  it("follows the user's setting: clean=false when auto clean-up is off", async () => {
    installMic()
    installInsertText()
    const { api, post } = fakeApi({ autoClean: false })
    mountField(api)
    await record()
    fireEvent.click(stop())
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0]?.[0]).toBe("/assist/transcribe?clean=false")
  })

  it("discard drops the take: nothing uploaded, mic released, text untouched, row back", async () => {
    const mic = installMic()
    const { api, post } = fakeApi({})
    const { el } = mountField(api)
    await record()
    fireEvent.click(screen.getByTestId("voice-dictation-discard"))
    await waitFor(() => expect(recorder()).toBeNull())
    expect(mic.track.stop).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 10))
    expect(post).not.toHaveBeenCalled()
    expect(el.value).toBe("abcdef")
    expect(screen.getByTestId("send").closest("[hidden]")).toBeNull()
    expect(document.activeElement).toBe(el)
  })

  it("Escape drops the take, uploading nothing", async () => {
    const mic = installMic()
    const { api, post } = fakeApi({})
    const { el } = mountField(api)
    await record()
    // Wherever the focus is (the stop button has it).
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    stop().dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true)
    await waitFor(() => expect(recorder()).toBeNull())
    expect(mic.track.stop).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 10))
    expect(post).not.toHaveBeenCalled()
    expect(el.value).toBe("abcdef")
  })

  it("Escape with no take running is left to the page", async () => {
    installMic()
    const { api } = fakeApi({})
    mountField(api)
    await waitFor(() => expect(button()).toBeInTheDocument())
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    document.body.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(false)
  })

  it("the timer turns red from 4:45", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    installMic()
    const { api } = fakeApi({})
    mountField(api)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(button())
    await vi.advanceTimersByTimeAsync(0)
    const elapsed = () => screen.getByTestId("voice-dictation-elapsed")
    await vi.advanceTimersByTimeAsync(TIMER_WARN_MS - 1_000)
    expect(elapsed().textContent).toBe("4:44")
    expect(elapsed().classList.contains("text-danger")).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(elapsed().textContent).toBe("4:45")
    expect(elapsed().classList.contains("text-danger")).toBe(true)
  })

  it("unmounting while recording releases the mic and uploads nothing", async () => {
    const mic = installMic()
    const { api, post } = fakeApi({})
    const { unmountAssist } = mountField(api)
    await record()
    unmountAssist()
    expect(mic.track.stop).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 10))
    expect(post).not.toHaveBeenCalled()
  })

  it("stops by itself at 5:00 and transcribes what was recorded", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    const mic = installMic()
    installInsertText()
    const { api, post } = fakeApi({})
    const { el } = mountField(api)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(button())
    await vi.advanceTimersByTimeAsync(0)
    expect(state()).toBe("recording")
    await vi.advanceTimersByTimeAsync(61_000)
    expect(screen.getByTestId("voice-dictation-elapsed").textContent).toBe("1:01")
    expect(post).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(240_000)
    expect(mic.track.stop).toHaveBeenCalled()
    // 300 s in 45 s windows: seven self-contained segments, each sent raw.
    expect(FakeMediaRecorder.instances).toHaveLength(7)
    expect(post.mock.calls.filter(([p]) => p === "/assist/transcribe?clean=false")).toHaveLength(7)
    expect(post.mock.calls.some(([p]) => p === "/assist/clean-dictation")).toBe(true)
    expect(el.value).toContain("clean(")
    // The text is in and the row is back.
    expect(recorder()).toBeNull()
  })

  it("a take stopped at 5:00 says so while it is transcribed", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    installMic()
    const { api } = fakeApi({ transcribe: () => new Promise(() => {}) })
    mountField(api)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(button())
    await vi.advanceTimersByTimeAsync(301_000)
    expect(state()).toBe("transcribing")
    expect(screen.getByTestId("voice-dictation-label").textContent).toContain(
      "Recording stopped at 5 minutes",
    )
  })

  it("a long take: segments sent raw in order, joined, then ONE clean-up of the whole", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    installMic()
    installInsertText()
    const { api, post } = fakeApi({
      transcribe: (_p, body) =>
        (body as Blob).text().then((t) => ({
          raw: t === "segment-0" ? "one" : "two",
          cleaned: "",
          model: "m",
          cleanModel: null,
          durationSeconds: 45,
        })),
    })
    const { el } = mountField(api, "", 0)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(button())
    await vi.advanceTimersByTimeAsync(SEGMENT_MS + 5_000)
    expect(FakeMediaRecorder.instances).toHaveLength(2)
    // The second recorder starts before the first stops: no gap between them.
    fireEvent.click(stop())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const clean = post.mock.calls.find(([p]) => p === "/assist/clean-dictation")
    expect(clean?.[1]).toEqual({ text: "one two" })
    expect(el.value).toBe("clean(one two)")
  })

  // SK7: a take's uploads are cancellable. Leaving (unmount) mid-transcription
  // aborts the request in flight instead of letting it run, be paid for, and
  // land nowhere; a long take whose first piece fails stops sending the rest.
  it("unmounting while transcribing aborts the upload in flight", async () => {
    installMic()
    const signals: AbortSignal[] = []
    const { api, post } = fakeApi({ transcribe: () => new Promise(() => {}) })
    post.mockImplementation(
      async (_path: string, _body: unknown, init?: { signal?: AbortSignal }) => {
        if (init?.signal) signals.push(init.signal)
        return new Promise(() => {})
      },
    )
    const { unmountAssist } = mountField(api)
    await record()
    fireEvent.click(stop())
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    unmountAssist()
    expect(signals[0]?.aborted).toBe(true)
  })

  it("a long take whose first piece fails stops: no further piece is sent, the rest are aborted", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    installMic()
    const signals: AbortSignal[] = []
    const { api, post } = fakeApi({})
    post.mockImplementation(
      async (path: string, body: unknown, init?: { signal?: AbortSignal }) => {
        if (!path.startsWith("/assist/transcribe")) throw new Error(`unexpected POST ${path}`)
        if (init?.signal) signals.push(init.signal)
        if ((await (body as Blob).text()) === "segment-0") {
          throw new ApiError("upstream 502", 502, "upstream_failed")
        }
        // The others answer a second later, unless aborted first.
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve({
                raw: "x",
                cleaned: "x",
                model: "m",
                cleanModel: null,
                durationSeconds: 45,
              }),
            1_000,
          )
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            reject(new DOMException("aborted", "AbortError"))
          })
        })
      },
    )
    mountField(api)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(button())
    await vi.advanceTimersByTimeAsync(0)
    // Five windows recorded, then Stop: five pieces, four sent at once.
    await vi.advanceTimersByTimeAsync(SEGMENT_MS * 4 + 5_000)
    fireEvent.click(stop())
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(state()).toBe("error")
    expect(post.mock.calls.filter(([p]) => p === "/assist/transcribe?clean=false")).toHaveLength(4)
    expect(signals).toHaveLength(4)
    expect(signals.every((s) => s.aborted)).toBe(true)
  })

  it("a refused microphone says where to turn it back on, in the UI language", async () => {
    installMic({ deny: "NotAllowedError" })
    const { api, post } = fakeApi({})
    const el = document.createElement("textarea")
    render(() => (
      <I18nProvider initialLocale="fr">
        <ApiContext.Provider value={api}>
          <Composer target={() => el} />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    await waitFor(() => expect(screen.getByTestId("voice-dictation-button")).toBeInTheDocument())
    fireEvent.click(button())
    const note = await screen.findByTestId("voice-dictation-note")
    expect(note.textContent).toContain("L'accès au micro est bloqué")
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(post).not.toHaveBeenCalled()
  })

  // V4: headless and embedded engines refuse a denied prompt with
  // NotSupportedError. With a microphone listed, that is a refusal, not a
  // missing device.
  it("NotSupportedError with a microphone listed says access is blocked", async () => {
    installMic({ deny: "NotSupportedError" })
    const { api } = fakeApi({})
    mountField(api)
    await waitFor(() => expect(screen.getByTestId("voice-dictation-button")).toBeInTheDocument())
    fireEvent.click(button())
    const note = await screen.findByTestId("voice-dictation-note")
    expect(note.textContent).toContain("Microphone access is blocked")
  })

  it("NotSupportedError with no microphone listed says none is available", async () => {
    installMic({ deny: "NotSupportedError", devices: ["audiooutput"] })
    const { api } = fakeApi({})
    mountField(api)
    await waitFor(() => expect(screen.getByTestId("voice-dictation-button")).toBeInTheDocument())
    fireEvent.click(button())
    const note = await screen.findByTestId("voice-dictation-note")
    expect(note.textContent).toContain("No microphone is available")
  })

  it("a failed transcription says so in words, never the server's message", async () => {
    installMic()
    const { api } = fakeApi({
      transcribe: () => {
        throw new ApiError("upstream 502 from provider-x", 502, "upstream_failed")
      },
    })
    mountField(api)
    await record()
    fireEvent.click(stop())
    const note = await screen.findByTestId("voice-dictation-note")
    expect(note.textContent).toBe("Couldn't transcribe the recording. Please try again.")
    expect(state()).toBe("error")
    // An error stays in the line, with a dismiss that brings the row back.
    fireEvent.click(screen.getByTestId("voice-dictation-dismiss"))
    expect(recorder()).toBeNull()
    expect(screen.getByTestId("send").closest("[hidden]")).toBeNull()
  })
})

describe("RecorderBar in a rich editor", () => {
  it("inserts at the held caret in one ProseMirror step that one undo takes back", async () => {
    installMic()
    const { api } = fakeApi({
      transcribe: () => ({
        raw: "uh <b>",
        cleaned: "<b>",
        model: "m",
        cleanModel: "c",
        durationSeconds: 1,
      }),
    })
    let handle: RichEditorHandle | undefined
    render(() => (
      <ApiContext.Provider value={api}>
        <RichEditor
          preset="minimal"
          value="Hello world"
          ref={(h) => {
            handle = h
          }}
          data-testid="field"
        />
        <Composer target={(): DictationTarget | undefined => handle} />
      </ApiContext.Provider>
    ))
    const field = await screen.findByTestId("field")
    const editor = editorOf(field)
    // The caret after "Hello" (position 1 is the paragraph's start).
    editor.commands.setTextSelection(6)
    await record()
    // Typing elsewhere meanwhile: the held place moves along with the text.
    editor.commands.insertContentAt(1, "Oh ")
    fireEvent.click(stop())
    // Plain text, never markup: "<b>" stays three characters.
    await waitFor(() => expect(editor.getText()).toBe("Oh Hello<b> world"))
    // One undo is the way back (there is no raw-transcript offer).
    // The inserted text is tinted for a moment.
    expect(field.querySelector(".inserted-tint")?.textContent).toBe("<b>")
    editor.commands.undo()
    expect(editor.getText()).toBe("Oh Hello world")
  })
})

// D20, phone: the input line itself becomes the recorder (WhatsApp-style).
// While a take runs the field folds away, kept mounted with its text and its
// history; when the take ends it comes back with the text at the caret and
// the focus in it. Desktop keeps the text above the recorder row.
describe("RecorderFold: the phone composer's field gives way to the recorder", () => {
  function PhoneComposer(props: {
    target: () => DictationTarget | undefined
    field: JSX.Element
    phone: boolean
  }) {
    const dictation = useDictation({ target: () => props.target() })
    return (
      <div>
        <RecorderFold dictation={dictation} when={props.phone}>
          <div data-testid="field-line">{props.field}</div>
        </RecorderFold>
        <RecorderRow dictation={dictation} variant={props.phone ? "phone" : "row"}>
          <DictationMic dictation={dictation} />
          <button type="button" data-testid="send">
            Send
          </button>
        </RecorderRow>
      </div>
    )
  }

  function mountRich(phone: boolean) {
    installMic()
    const { api } = fakeApi({
      transcribe: () => ({
        raw: "T",
        cleaned: " there",
        model: "m",
        cleanModel: "c",
        durationSeconds: 1,
      }),
    })
    let handle: RichEditorHandle | undefined
    render(() => (
      <ApiContext.Provider value={api}>
        <PhoneComposer
          phone={phone}
          target={(): DictationTarget | undefined => handle}
          field={
            <RichEditor
              preset="minimal"
              value="Hello"
              ref={(h) => {
                handle = h
              }}
              data-testid="field"
            />
          }
        />
      </ApiContext.Provider>
    ))
  }

  it("at phone width the field folds while recording and transcribing, then returns with the text and the focus", async () => {
    mountRich(true)
    const field = await screen.findByTestId("field")
    const editor = editorOf(field)
    editor.commands.setTextSelection(6)
    expect(field.closest("[hidden]")).toBeNull()
    await record()
    expect(field.closest("[hidden]")).not.toBeNull()
    expect(field.isConnected).toBe(true)
    fireEvent.click(stop())
    await waitFor(() => expect(editor.getText()).toBe("Hello there"))
    expect(field.closest("[hidden]")).toBeNull()
    expect(field.contains(document.activeElement)).toBe(true)
    editor.commands.undo()
    expect(editor.getText()).toBe("Hello")
  })

  it("discarding the take brings the field back unchanged", async () => {
    mountRich(true)
    const field = await screen.findByTestId("field")
    await record()
    expect(field.closest("[hidden]")).not.toBeNull()
    fireEvent.click(screen.getByTestId("voice-dictation-discard"))
    expect(field.closest("[hidden]")).toBeNull()
    expect(editorOf(field).getText()).toBe("Hello")
  })

  it("on desktop the text stays visible above the recorder row", async () => {
    mountRich(false)
    const field = await screen.findByTestId("field")
    await record()
    expect(field.closest("[hidden]")).toBeNull()
  })
})

// V1: a take with no speech in it is not sent (a speech model hears "No, no,
// no..." in silence). The level is read every 50 ms; silence and steady room
// noise are not speech, a burst of voice is.
describe("RecorderBar: a take with no speech", () => {
  const SILENCE = 128
  const ROOM_NOISE = 130
  const VOICE = 170

  async function takeOf(level: () => number, ms: number) {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    installAudioContext(level)
    installMic()
    installInsertText()
    const { api, post } = fakeApi({})
    const { el } = mountField(api, "abc", 3)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(button())
    await vi.advanceTimersByTimeAsync(0)
    expect(state()).toBe("recording")
    await vi.advanceTimersByTimeAsync(ms)
    fireEvent.click(stop())
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
    return { el, post }
  }

  it("silence: nothing is sent or inserted, and the control says no speech was heard", async () => {
    const { el, post } = await takeOf(() => SILENCE, 3_000)
    expect(post).not.toHaveBeenCalled()
    expect(el.value).toBe("abc")
    expect(state()).toBe("error")
    // Said in the recorder line, with nothing to dismiss: it goes by itself.
    expect(screen.getByTestId("voice-dictation-note").textContent).toBe(
      "No speech heard. Nothing was inserted.",
    )
    expect(screen.queryByTestId("voice-dictation-dismiss")).toBeNull()
    await vi.advanceTimersByTimeAsync(1_900)
    expect(recorder()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(recorder()).toBeNull()
    expect(screen.getByTestId("send").closest("[hidden]")).toBeNull()
  })

  // The notice used to collapse the line to a bare sentence: the row jumped
  // in height and the buttons vanished under the pointer. It keeps the
  // recording line's geometry: discard, the timer and stop (disabled) stay
  // where they were, the sentence takes the waveform's place.
  it("no speech keeps the recorder line's geometry, the notice where the waveform was", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    installAudioContext(() => SILENCE)
    installMic()
    installInsertText()
    const { api } = fakeApi({})
    mountField(api, "abc", 3)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(button())
    await vi.advanceTimersByTimeAsync(3_000)
    const line = recorder() as HTMLElement
    const shape = (el: HTMLElement) =>
      Array.from(el.children).map((c) => [c.tagName, c.getAttribute("class")])
    const recording = { class: line.getAttribute("class"), shape: shape(line) }
    const slot = screen.getByTestId("voice-dictation-waveform").closest("[data-recorder-slot]")
    expect(slot).not.toBeNull()
    fireEvent.click(stop())
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
    expect(state()).toBe("error")
    const notice = recorder() as HTMLElement
    expect(notice.getAttribute("class")).toBe(recording.class)
    expect(shape(notice)).toEqual(recording.shape)
    expect(screen.getByTestId("voice-dictation-discard")).toBeInTheDocument()
    expect(screen.getByTestId("voice-dictation-elapsed").textContent).toBe("0:03")
    expect((screen.getByTestId("voice-dictation-stop") as HTMLButtonElement).disabled).toBe(true)
    const note = screen.getByTestId("voice-dictation-note")
    expect(note.closest("[data-recorder-slot]")).not.toBeNull()
    expect(note.classList.contains("truncate")).toBe(true)
    expect(screen.queryByTestId("voice-dictation-waveform")).toBeNull()
    await vi.advanceTimersByTimeAsync(2_100)
    expect(recorder()).toBeNull()
  })

  it("low steady room noise: nothing is sent", async () => {
    const { post } = await takeOf(() => ROOM_NOISE, 3_000)
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByTestId("voice-dictation-note").textContent).toBe(
      "No speech heard. Nothing was inserted.",
    )
  })

  it("a burst of voice over the room noise is sent and inserted", async () => {
    let started: number | undefined
    const { el, post } = await takeOf(() => {
      started ??= Date.now()
      const t = Date.now() - started
      return t > 1_000 && t < 1_600 ? VOICE : ROOM_NOISE
    }, 3_000)
    expect(post).toHaveBeenCalledTimes(1)
    expect(el.value).toBe("abcT")
  })

  it("an audio context that never runs gives no readings: the take is sent, not judged silent", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    })
    installAudioContext(SILENCE, { state: "suspended" })
    installMic()
    installInsertText()
    const { api, post } = fakeApi({})
    mountField(api, "abc", 3)
    await vi.advanceTimersByTimeAsync(0)
    fireEvent.click(button())
    await vi.advanceTimersByTimeAsync(3_000)
    fireEvent.click(stop())
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("a long take: a silent segment is not sent, the spoken one is", async () => {
    let started: number | undefined
    const { post } = await takeOf(() => {
      started ??= Date.now()
      return Date.now() - started > SEGMENT_MS + 5_000 ? VOICE : SILENCE
    }, SEGMENT_MS + 15_000)
    const sent = post.mock.calls.filter(([p]) => String(p).startsWith("/assist/transcribe"))
    expect(sent).toHaveLength(1)
    const body = sent[0]?.[1]
    expect(body).toBeInstanceOf(Blob)
    expect(await (body as Blob).text()).toBe("segment-1")
  })
})

describe("waveformBars", () => {
  it("puts the newest level at the right and leaves unreached slots empty", () => {
    expect(waveformBars([0.2, 0.5, 0.9], 5)).toEqual([null, null, 0.2, 0.5, 0.9])
    expect(waveformBars([0.1, 0.2, 0.5, 0.9], 2)).toEqual([0.5, 0.9])
  })
})
