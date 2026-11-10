// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Do it for me": plays a beat's autoplay script in the real UI. Clicks are the
 * full pointer sequence a mouse produces (Kobalte menus open on pointerdown),
 * typing goes through `insertText` one character at a time at human speed (so
 * ProseMirror, textareas and their pickers see real input), and every step
 * resolves its target with the same visible-anchor resolver as the spotlight.
 * A target that never appears stops the script and says which one; nothing is
 * ever skipped silently. A guard that does not hold (a `require` step, or a
 * step pinned to an entity the tour has not created) refuses: the script stops
 * before doing anything more, so it never works on the wrong thing.
 */
import {
  RUN_CONVERSATION,
  refCreated,
  refTestId,
  refWhere,
  type TourElementRef,
  type TourStep,
} from "@liaison/shared"
import { type AnchorPin, editableTarget, isEditable, resolveVisibleAnchor } from "./visible-anchor"

export type AutoplayResult =
  | { status: "done" }
  | { status: "failed"; missing: string }
  /** A guard did not hold on `target` (a testid); nothing after it ran. */
  | { status: "refused"; target: string }
  | { status: "aborted" }

export interface AutoplayCursor {
  /** Move the ghost cursor over `el`; resolves when it got there. */
  moveTo(el: HTMLElement, signal: AbortSignal): Promise<void>
}

export interface AutoplayOptions {
  cursor: AutoplayCursor
  signal: AbortSignal
  /** Delay between typed chunks (a few characters each: `TYPE_TICKS` chunks per text). */
  typeDelayMs?: number
  /** How long a step waits for its target to appear. */
  findTimeoutMs?: number
  /** Pause after each step so a person can follow. */
  stepPauseMs?: number
  /**
   * Entity ids the run's completed do beats created, by beat id
   * (`createdEntityIds(progress.beatStates)`): what a step's `created` pin reads.
   */
  created?: Readonly<Record<string, string>>
  /**
   * The text a `type` step names is a copy key: this resolves it in the
   * person's language (the panel's translator). Unset, the text is typed as is.
   */
  text?: (key: string) => string
  /**
   * Opens a conversation with the person's agent where they are (the chat
   * dock beside the screen, or its own screen on a phone): what an
   * `openRunConversation` step does with the run's conversation. Unset, the
   * step refuses.
   */
  openConversation?: (threadId: string) => void
}

/**
 * Typing is quick: a text goes in over at most TYPE_TICKS chunks, one every
 * TYPE_DELAY_MS (about a fifth of a second whatever its length), so the
 * person sees it fill without waiting on it.
 */
export const TYPE_DELAY_MS = 16
export const TYPE_TICKS = 12

/**
 * The tour is typing into a field: only the person's own typing takes over
 * then (`watchTakeover`); a press, a scroll or the mouse never cuts a sentence
 * short.
 */
let typingNow = 0
export const FIND_TIMEOUT_MS = 5000
const FIND_POLL_MS = 100
/** How often a step looks again for an element re-rendered while the cursor moved to it. */
const REFIND_TRIES = 3
const STEP_PAUSE_MS = 250

class Aborted extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted())
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Aborted())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

type RunOptions = Required<Omit<AutoplayOptions, "cursor" | "openConversation">> &
  Pick<AutoplayOptions, "openConversation">

/** A step's target with its created-entity pin resolved; null when the pinned beat created nothing. */
interface Target {
  testid: string
  where?: AnchorPin
}

function resolveRef(ref: TourElementRef, created: RunOptions["created"]): Target | null {
  const testid = refTestId(ref)
  // A fixed attribute value (the person's own agent conversation's composer and Send).
  const where = refWhere(ref)
  if (where) return { testid, where }
  const pin = refCreated(ref)
  if (!pin) return { testid }
  const value = created[pin.beat]
  return value ? { testid, where: { attr: pin.attr, value } } : null
}

const visible = (t: Target) => resolveVisibleAnchor(t.testid, document, t.where)

/** Already the selected one: a script never flips a toggle it meant to switch on. */
function isActive(el: HTMLElement): boolean {
  return ["data-active", "aria-pressed", "aria-selected", "aria-checked"].some(
    (a) => el.getAttribute(a) === "true",
  )
}

/** A control that ignores a press: disabled, natively or by its ARIA state. */
function isDisabled(el: HTMLElement): boolean {
  return el.matches(":disabled") || el.getAttribute("aria-disabled") === "true"
}

/**
 * The target on screen, waited for up to the find timeout. `ready` narrows it
 * to one that can be acted on: a typing step's field may be on screen before
 * the editor inside it has loaded (the composer's stand-in, editor/index.tsx),
 * and typing waits for that editor instead of giving up.
 */
async function find(target: Target, opts: RunOptions, ready?: (el: HTMLElement) => boolean) {
  const deadline = Date.now() + opts.findTimeoutMs
  for (;;) {
    const el = visible(target)
    if (el && (!ready || ready(el))) return el
    if (Date.now() >= deadline) return null
    await sleep(FIND_POLL_MS, opts.signal)
  }
}

function center(el: HTMLElement): { clientX: number; clientY: number } {
  const r = el.getBoundingClientRect()
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
}

/**
 * What a mouse pressing the middle of `el` actually hits: the deepest element
 * there when it lies inside `el` (a row whose click handler is on the button
 * filling it), else `el` itself.
 */
export function clickTarget(el: HTMLElement): HTMLElement {
  if (typeof document.elementFromPoint !== "function") return el
  const at = center(el)
  const hit = document.elementFromPoint(at.clientX, at.clientY)
  return hit instanceof HTMLElement && hit !== el && el.contains(hit) ? hit : el
}

/** pointerdown → mousedown → pointerup → mouseup → click, as a mouse does. */
export function ghostClick(el: HTMLElement): void {
  const at = center(el)
  const base = { bubbles: true, cancelable: true, composed: true, button: 0, ...at }
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true }
  const PointerCtor: typeof MouseEvent =
    typeof PointerEvent === "function" ? PointerEvent : MouseEvent
  el.dispatchEvent(new PointerCtor("pointerdown", { ...pointer, buttons: 1 }))
  const down = new MouseEvent("mousedown", { ...base, buttons: 1 })
  el.dispatchEvent(down)
  // A real mousedown moves focus unless the page prevents it (pickers do, to
  // keep the caret in the editor); a synthetic one never does by itself.
  if (!down.defaultPrevented && el.isConnected && document.activeElement !== el) {
    if (el.tabIndex >= 0 || isEditable(el)) el.focus()
  }
  el.dispatchEvent(new PointerCtor("pointerup", { ...pointer, buttons: 0 }))
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 1 }))
}

/**
 * Where typing starts: over the field's whole content (a typing step replaces
 * it, so a draft left by a takeover is never prefixed), or at its end for an
 * `append` step that continues text an earlier step wrote.
 */
function placeCaret(target: HTMLElement, append: boolean): void {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const end = target.value.length
    target.setSelectionRange(append ? end : 0, end)
    return
  }
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(target)
  if (append) range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * Insert one character where the caret is, as typing does. `insertText` is
 * what the browser runs for a keystroke (beforeinput/input, undo stack,
 * ProseMirror's DOM observer). Where it is unavailable (a non-browser DOM) a
 * text field gets the same edit through its value and an input event.
 */
function insertChar(target: HTMLElement, ch: string): void {
  const done =
    typeof document.execCommand === "function" && document.execCommand("insertText", false, ch)
  if (done) return
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? start
    target.setRangeText(ch, start, end, "end")
  } else {
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (range && target.contains(range.startContainer)) {
      range.deleteContents()
      const node = document.createTextNode(ch)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
    } else {
      target.append(ch)
    }
  }
  target.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }),
  )
}

function press(target: HTMLElement, key: string): void {
  const init = { key, bubbles: true, cancelable: true, composed: true }
  target.dispatchEvent(new KeyboardEvent("keydown", init))
  target.dispatchEvent(new KeyboardEvent("keyup", init))
}

/** Play `steps` (stopping at a `waitEvent`: the server's event moves the beat on). */
export async function runAutoplay(
  steps: readonly TourStep[],
  options: AutoplayOptions,
): Promise<AutoplayResult> {
  const opts: RunOptions = {
    signal: options.signal,
    typeDelayMs: options.typeDelayMs ?? TYPE_DELAY_MS,
    findTimeoutMs: options.findTimeoutMs ?? FIND_TIMEOUT_MS,
    stepPauseMs: options.stepPauseMs ?? STEP_PAUSE_MS,
    created: options.created ?? {},
    text: options.text ?? ((key) => key),
    openConversation: options.openConversation,
  }
  try {
    for (const step of steps) {
      if (opts.signal.aborted) return { status: "aborted" }
      if ("waitEvent" in step) return { status: "done" }
      if ("openRunConversation" in step) {
        // Only the conversation the run recorded: never some other one instead.
        const threadId = opts.created[RUN_CONVERSATION]
        if (!threadId || !opts.openConversation)
          return { status: "refused", target: "compose-field" }
        opts.openConversation(threadId)
        await sleep(opts.stepPauseMs, opts.signal)
        continue
      }
      if ("click" in step && step.unlessVisible) {
        const unless = resolveRef(step.unlessVisible, opts.created)
        if (!unless) return { status: "refused", target: refTestId(step.unlessVisible) }
        if (visible(unless)) continue
      }
      const ref: TourElementRef =
        "click" in step
          ? step.click
          : "type" in step
            ? step.type.created
              ? { testid: step.type.testid, created: step.type.created }
              : step.type.where
                ? { testid: step.type.testid, where: step.type.where }
                : step.type.testid
            : "press" in step
              ? step.press.testid
              : "require" in step
                ? step.require.testid
                : step.waitFor
      const pinned = resolveRef(ref, opts.created)
      if (!pinned) return { status: "refused", target: refTestId(ref) }
      // A preferred mark narrows an unpinned click to the rows carrying it, when any is on screen.
      const preferred =
        "click" in step && step.prefer && !pinned.where
          ? { testid: pinned.testid, where: step.prefer }
          : null
      const target = preferred && visible(preferred) ? preferred : pinned
      // A typing step waits for the editor inside its field; a press waits for
      // a control that takes it: a disabled button drops the click (a send
      // button greys out while the live connection reconnects for an instant)
      // and the script would go on as if it had pressed.
      const ready =
        "type" in step
          ? (e: HTMLElement) => editableTarget(e) !== null
          : "click" in step
            ? (e: HTMLElement) => !isDisabled(e)
            : undefined
      let el = await find(target, opts, ready)
      if (!el) return { status: "failed", missing: target.testid }
      if ("waitFor" in step) continue
      if ("require" in step) {
        if (el.getAttribute(step.require.attr) !== step.require.value) {
          return { status: "refused", target: target.testid }
        }
        continue
      }
      if ("click" in step && step.unlessActive && isActive(el)) continue
      await options.cursor.moveTo(el, opts.signal)
      // The screen may have re-rendered the element during the glide (a list
      // refetch rebuilds its cards): a press on the detached one reaches no
      // handler, where a hand always presses what is on screen. Find it again.
      // It may also have been disabled meanwhile: wait until it takes the press again.
      for (
        let tries = 0;
        tries < REFIND_TRIES && (!visible(target)?.isSameNode(el) || (ready && !ready(el)));
        tries++
      ) {
        const fresh = await find(target, opts, ready)
        if (!fresh) return { status: "failed", missing: target.testid }
        el = fresh
        await options.cursor.moveTo(el, opts.signal)
      }
      // Never a press that reaches nothing reported as done.
      if (ready && !ready(el)) return { status: "failed", missing: target.testid }
      if ("click" in step) {
        ghostClick(clickTarget(el))
      } else if ("type" in step) {
        const field = editableTarget(el)
        if (!field) return { status: "failed", missing: target.testid }
        if (document.activeElement !== field) ghostClick(field)
        field.focus()
        placeCaret(field, step.type.append === true)
        const chars = [...opts.text(step.type.text)]
        const chunk = Math.max(1, Math.ceil(chars.length / TYPE_TICKS))
        typingNow += 1
        try {
          for (let i = 0; i < chars.length; i += chunk) {
            for (const ch of chars.slice(i, i + chunk)) insertChar(field, ch)
            await sleep(opts.typeDelayMs, opts.signal)
          }
        } finally {
          typingNow -= 1
        }
      } else if ("press" in step) {
        const field = editableTarget(el) ?? el
        field.focus()
        press(field, step.press.key)
      }
      await sleep(opts.stepPauseMs, opts.signal)
    }
    return { status: "done" }
  } catch (err) {
    if (err instanceof Aborted) return { status: "aborted" }
    throw err
  }
}

/** Marks the tour's own UI (panel, chip, completion card): input there is never a takeover. */
export const TOUR_UI_ATTR = "data-tour-ui"

/**
 * Watch for the person taking over: a REAL (`isTrusted`) key, pointer press or
 * wheel anywhere in the window; while the tour types into a field, only a key.
 * Moving the mouse, hovering or a focus change is never a takeover: a hand on
 * the mouse once stopped Do it for me mid-sentence. The ghost's own synthetic
 * events are never trusted, so they never trip it. Returns the unsubscribe.
 */
export function watchTakeover(
  onTakeover: () => void,
  isUserInput: (e: Event) => boolean = (e) => e.isTrusted === true,
): () => void {
  // Input on the tour's own panel is the person talking to the tour (Skip,
  // Pause, Stop), not taking over the app: handing over there reflowed the
  // panel under the pointer and the press landed on another element.
  const onTourUi = (e: Event) =>
    e.target instanceof Element && e.target.closest(`[${TOUR_UI_ATTR}]`) !== null
  const fire = (e: Event) => {
    if (!isUserInput(e) || onTourUi(e)) return
    if (typingNow > 0 && e.type !== "keydown") return
    onTakeover()
  }
  const kinds = ["pointerdown", "keydown", "wheel"] as const
  for (const k of kinds) window.addEventListener(k, fire, true)
  return () => {
    for (const k of kinds) window.removeEventListener(k, fire, true)
  }
}
