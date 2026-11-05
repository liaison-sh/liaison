// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M1-B T8. The geometry and the timing, pinned as pure functions, plus one
// render pass proving a row's actions are there to be pressed.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createLongPressTracker,
  LONG_PRESS_MOVE_PX,
  LONG_PRESS_MS,
  resolveSwipe,
  SWIPE_COMMIT_PX,
  SWIPE_FULL_FRACTION,
  SwipeRow,
  swipeOffset,
} from "~/ui/SwipeRow"

describe("resolveSwipe", () => {
  const WIDTH = 390

  it("a rightward drag reveals nothing", () => {
    expect(resolveSwipe(40, WIDTH)).toBe("closed")
    expect(resolveSwipe(0, WIDTH)).toBe("closed")
  })

  it("a short leftward drag springs back", () => {
    expect(resolveSwipe(-10, WIDTH)).toBe("closed")
    expect(resolveSwipe(-(SWIPE_COMMIT_PX - 1), WIDTH)).toBe("closed")
  })

  it("past the 60px threshold the row stays open", () => {
    expect(resolveSwipe(-SWIPE_COMMIT_PX, WIDTH)).toBe("open")
    expect(resolveSwipe(-120, WIDTH)).toBe("open")
  })

  it("past 60% of the row's width it commits the first action", () => {
    const full = WIDTH * SWIPE_FULL_FRACTION
    expect(resolveSwipe(-(full - 1), WIDTH)).toBe("open")
    expect(resolveSwipe(-full, WIDTH)).toBe("commit")
    expect(resolveSwipe(-WIDTH, WIDTH)).toBe("commit")
  })

  it("a zero width row (never laid out) still honours the pixel threshold", () => {
    expect(resolveSwipe(-10, 0)).toBe("closed")
    expect(resolveSwipe(-90, 0)).toBe("open")
  })
})

describe("swipeOffset", () => {
  it("follows the finger leftward and never rightward", () => {
    expect(swipeOffset(-40, 390)).toBe(40)
    expect(swipeOffset(25, 390)).toBe(0)
  })

  it("never exceeds the row's own width", () => {
    expect(swipeOffset(-900, 390)).toBe(390)
  })
})

describe("createLongPressTracker", () => {
  afterEach(() => vi.useRealTimers())

  it("fires once the finger has rested for the full 500ms", () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const t = createLongPressTracker(fired)

    t.start(100, 100)
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(fired).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it("is cancelled by a move beyond the tolerance", () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const t = createLongPressTracker(fired)

    t.start(100, 100)
    t.move(100 + LONG_PRESS_MOVE_PX + 1, 100)
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)

    expect(fired).not.toHaveBeenCalled()
  })

  it("survives a move inside the tolerance (a resting finger jitters)", () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const t = createLongPressTracker(fired)

    t.start(100, 100)
    t.move(100 + LONG_PRESS_MOVE_PX, 100 - LONG_PRESS_MOVE_PX)
    vi.advanceTimersByTime(LONG_PRESS_MS)

    expect(fired).toHaveBeenCalledTimes(1)
  })

  it("a vertical move (the page scrolling) cancels it too", () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const t = createLongPressTracker(fired)

    t.start(100, 100)
    t.move(100, 140)
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)

    expect(fired).not.toHaveBeenCalled()
  })

  it("an explicit cancel stops it, and a restart re-arms it", () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const t = createLongPressTracker(fired)

    t.start(0, 0)
    t.cancel()
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(fired).not.toHaveBeenCalled()

    t.start(0, 0)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(fired).toHaveBeenCalledTimes(1)
  })
})

describe("SwipeRow rendering", () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("renders each action beside the row and runs the one that is pressed", () => {
    const read = vi.fn()
    const pin = vi.fn()
    render(() => (
      <SwipeRow
        actions={[
          { label: "Read", onSelect: read },
          { label: "Pin", tone: "accent", onSelect: pin },
        ]}
      >
        <div data-testid="row-body">Engineering</div>
      </SwipeRow>
    ))

    expect(screen.getByTestId("row-body")).toBeTruthy()
    const rail = screen.getByTestId("swipe-row-actions")
    expect(rail.children.length).toBe(2)

    fireEvent.click(screen.getByTestId("swipe-action-pin"))
    expect(pin).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("swipe-action-read"))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("starts closed", () => {
    render(() => (
      <SwipeRow actions={[{ label: "Read", onSelect: vi.fn() }]}>
        <div>row</div>
      </SwipeRow>
    ))
    expect(screen.getByTestId("swipe-row").getAttribute("data-swipe-open")).toBe("false")
  })

  // F5: none of the tests above ever drive an actual pointer sequence through
  // the component — `resolveSwipe`/`swipeOffset` are pinned as pure functions,
  // but nothing proved the DOM handlers are actually WIRED to them. Commenting
  // out `onPointerMove`/`onPointerUp` on the draggable div (leaving only
  // `onPointerDown`) leaves every test above green, since none of them ever
  // fires a move or an up.
  it("a leftward drag past the 60px threshold leaves the row open on release", () => {
    render(() => (
      <SwipeRow actions={[{ label: "Read", onSelect: vi.fn() }]}>
        <div data-testid="row-body">row</div>
      </SwipeRow>
    ))
    const row = screen.getByTestId("swipe-row")
    const draggable = screen.getByTestId("row-body").parentElement as HTMLElement

    fireEvent.pointerDown(draggable, { pointerId: 1, button: 0, clientX: 300, clientY: 0 })
    fireEvent.pointerMove(draggable, { pointerId: 1, clientX: 200, clientY: 0 })
    expect(row.getAttribute("data-swipe-open")).toBe("true")
    fireEvent.pointerUp(draggable, { pointerId: 1, clientX: 200, clientY: 0 })

    expect(row.getAttribute("data-swipe-open")).toBe("true")
  })

  it("a drag past 60% of the row's width commits the first action on release", () => {
    const read = vi.fn()
    const pin = vi.fn()
    render(() => (
      <SwipeRow
        actions={[
          { label: "Read", onSelect: read },
          { label: "Pin", onSelect: pin },
        ]}
      >
        <div data-testid="row-body">row</div>
      </SwipeRow>
    ))
    const row = screen.getByTestId("swipe-row")
    const draggable = screen.getByTestId("row-body").parentElement as HTMLElement
    // jsdom lays nothing out (offsetWidth is always 0), so the row's width —
    // what the 60% threshold is measured against — is mocked to a real value,
    // the same way `resolveSwipe`'s own tests pin it.
    Object.defineProperty(row, "offsetWidth", { value: 200, configurable: true })

    fireEvent.pointerDown(draggable, { pointerId: 1, button: 0, clientX: 300, clientY: 0 })
    fireEvent.pointerMove(draggable, { pointerId: 1, clientX: 150, clientY: 0 }) // dx = -150, 75%
    fireEvent.pointerUp(draggable, { pointerId: 1, clientX: 150, clientY: 0 })

    // The FIRST action's onSelect runs a full swipe, no tap on the rail needed.
    expect(read).toHaveBeenCalledTimes(1)
    expect(pin).not.toHaveBeenCalled()
    expect(row.getAttribute("data-swipe-open")).toBe("false")
  })

  it("a long press with the finger still down fires onLongPress and snaps the row shut", () => {
    vi.useFakeTimers()
    const onLongPress = vi.fn()
    render(() => (
      <SwipeRow actions={[{ label: "Read", onSelect: vi.fn() }]} onLongPress={onLongPress}>
        <div data-testid="row-body">row</div>
      </SwipeRow>
    ))
    const row = screen.getByTestId("swipe-row")
    const draggable = screen.getByTestId("row-body").parentElement as HTMLElement

    fireEvent.pointerDown(draggable, { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    expect(onLongPress).not.toHaveBeenCalled()
    vi.advanceTimersByTime(LONG_PRESS_MS)

    expect(onLongPress).toHaveBeenCalledTimes(1)
    // A long press and a swipe are exclusive: the row is closed, not left
    // half-open under the actions sheet the press just opened.
    expect(row.getAttribute("data-swipe-open")).toBe("false")
  })
  // F6. A pointer captured on pointerdown retargets the following click to the
  // capture element, so the button INSIDE the row never sees it and phone rows
  // (Mail, Tickets) do not open on tap. The capture is therefore taken only
  // once the gesture has proven itself horizontal, and always released.
  it("a tap with no horizontal movement never captures the pointer, so the row's click lands", () => {
    const opened = vi.fn()
    render(() => (
      <SwipeRow actions={[{ label: "Read", onSelect: vi.fn() }]}>
        <button type="button" data-testid="row-open" onClick={opened}>
          row
        </button>
      </SwipeRow>
    ))
    const draggable = screen.getByTestId("row-open").parentElement as HTMLElement
    const capture = vi.fn()
    const release = vi.fn()
    Object.assign(draggable, { setPointerCapture: capture, releasePointerCapture: release })

    fireEvent.pointerDown(draggable, { pointerId: 1, button: 0, clientX: 120, clientY: 40 })
    fireEvent.pointerUp(draggable, { pointerId: 1, clientX: 120, clientY: 40 })

    expect(capture).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("row-open"))
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it("a horizontal drag captures the pointer once and releases it on pointerup", () => {
    render(() => (
      <SwipeRow actions={[{ label: "Read", onSelect: vi.fn() }]}>
        <div data-testid="row-body">row</div>
      </SwipeRow>
    ))
    const draggable = screen.getByTestId("row-body").parentElement as HTMLElement
    const capture = vi.fn()
    const release = vi.fn()
    Object.assign(draggable, { setPointerCapture: capture, releasePointerCapture: release })

    fireEvent.pointerDown(draggable, { pointerId: 7, button: 0, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(draggable, { pointerId: 7, clientX: 260, clientY: 40 })
    fireEvent.pointerMove(draggable, { pointerId: 7, clientX: 230, clientY: 40 })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(7)
    expect(release).not.toHaveBeenCalled()

    fireEvent.pointerUp(draggable, { pointerId: 7, clientX: 230, clientY: 40 })
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith(7)
  })

  it("a cancelled gesture releases the capture too", () => {
    render(() => (
      <SwipeRow actions={[{ label: "Read", onSelect: vi.fn() }]}>
        <div data-testid="row-body">row</div>
      </SwipeRow>
    ))
    const draggable = screen.getByTestId("row-body").parentElement as HTMLElement
    const release = vi.fn()
    Object.assign(draggable, { setPointerCapture: vi.fn(), releasePointerCapture: release })

    fireEvent.pointerDown(draggable, { pointerId: 3, button: 0, clientX: 300, clientY: 40 })
    fireEvent.pointerMove(draggable, { pointerId: 3, clientX: 240, clientY: 40 })
    fireEvent.pointerCancel(draggable, { pointerId: 3, clientX: 240, clientY: 40 })

    expect(release).toHaveBeenCalledTimes(1)
  })
})
