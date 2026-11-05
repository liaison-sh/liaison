// SPDX-License-Identifier: FSL-1.1-ALv2
// D2/D4/D8: the panel keeps clear of what it spotlights; the chip covers no control.
import { afterEach, describe, expect, it, vi } from "vitest"
import { pressTargets } from "./panel-layout"
import {
  chipCandidates,
  clearOfCard,
  coveredControls,
  isCoveredByLayer,
  layoutPanel,
  mainArea,
  overlapArea,
  panelCandidates,
  panelFrame,
  pickPlacement,
  placePanel,
  sheetCandidates,
  workAreas,
} from "./placement"

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

const desktop = { width: 1280, height: 800 }
const phone = { width: 390, height: 844 }

describe("panel placement", () => {
  it("sits bottom left of the main panel area when the spotlight is elsewhere", () => {
    const spot = { top: 200, left: 340, width: 500, height: 300 }
    expect(placePanel(panelCandidates(desktop, 240), spot)).toBe("bottom-left")
  })

  it("moves up when the ringed element lies under its corner (a composer)", () => {
    const spot = { top: 700, left: 70, width: 600, height: 80 }
    expect(placePanel(panelCandidates(desktop, 240), spot)).toBe("top-left")
  })

  it("leaves the left side when the whole of it is spotlit (a list beside the rail)", () => {
    const spot = { top: 40, left: 64, width: 420, height: 760 }
    expect(placePanel(panelCandidates(desktop, 240), spot)).toBe("top-right")
  })

  it("keeps off the head of a spotlit list that fills the main panel area (new rows land there)", () => {
    const area = { top: 0, left: 360, width: 920, height: 800 }
    const list = { top: 40, left: 360, width: 920, height: 760 }
    const candidates = panelCandidates(desktop, 240, area)
    expect(placePanel(candidates, list)).toBe("bottom-left")
    // Even from a top corner an earlier step sent it to, and with fewer controls up there.
    const controls = (r: { top: number }) => (r.top < 400 ? 0 : 2)
    for (const current of ["top-left", "top-right", "bottom-right"] as const) {
      expect(
        layoutPanel(candidates, { spot: list, work: [], current, home: "bottom-left", controls })
          .placement,
      ).toBe("bottom-left")
    }
  })

  // Demo walk: the CRM approval card spans the content width and is taller
  // than the free space; the head-weighted pick sent the card bottom left,
  // over the card's Approve, the button Do it for me presses.
  it("never covers what the step presses, ahead of the spotlight's head", () => {
    const area = { top: 0, left: 360, width: 920, height: 800 }
    const card = { top: 120, left: 376, width: 888, height: 660 }
    const approve = { top: 730, left: 392, width: 90, height: 36 }
    const candidates = panelCandidates(desktop, 270, area)
    expect(placePanel(candidates, card)).toBe("bottom-left")
    const layout = layoutPanel(candidates, {
      spot: card,
      work: [],
      press: [approve],
      home: "bottom-left",
    })
    expect(layout.covers).toBeNull()
    const at = candidates.find((c) => c.id === layout.placement)!.rect
    expect(overlapArea(at, approve)).toBe(0)
  })

  it("reports the press target every spot covers, and how far to scroll it clear of the card", () => {
    const area = { top: 0, left: 360, width: 920, height: 800 }
    // A full-height target: every corner covers it.
    const wide = { top: 0, left: 360, width: 920, height: 800 }
    const layout = layoutPanel(panelCandidates(desktop, 270, area), {
      spot: null,
      work: [],
      press: [wide],
      home: "bottom-left",
    })
    expect(layout.covers).toBe(0)
    const card = { top: 514, left: 376, width: 330, height: 270 }
    // A button under the card: moved up above its top edge (the shorter move).
    expect(clearOfCard({ top: 730, left: 392, width: 90, height: 36 }, card, area)).toBe(
      514 - 8 - 766,
    )
    // A button just below the card's top: up is the shorter move.
    expect(clearOfCard({ top: 520, left: 392, width: 90, height: 36 }, card, area)).toBe(
      514 - 8 - 556,
    )
    // Taller than the room above and below the card: no move fits.
    expect(clearOfCard({ top: 100, left: 392, width: 90, height: 700 }, card, area)).toBeNull()
  })

  it("a do beat's press targets are its clicks as on screen, a card pin resolving its button", () => {
    const card = (tool: string) => {
      const root = document.createElement("div")
      root.dataset.testid = "approval-card"
      root.dataset.toolName = tool
      const btn = document.createElement("button")
      btn.dataset.testid = "approval-card-action-approve"
      btn.getClientRects = () => [{}] as unknown as DOMRectList
      root.append(btn)
      document.body.append(root)
      return btn
    }
    card("kernel:web_fetch")
    const crm = card("api-connector:connector_write")
    const click = {
      testid: "approval-card-action-approve",
      where: { attr: "data-tool-name", value: ["api-connector:connector_write", "mail:reply"] },
    }
    const beat = (kind: "do" | "show") =>
      ({ id: "b", kind, autoplay: [{ waitFor: click }, { click }, { waitEvent: true }] }) as never
    expect(pressTargets(beat("do"))).toEqual([crm])
    expect(pressTargets(beat("show"))).toEqual([])
  })

  it("is never placed over the rail or the sidebar: every spot lies in the main panel area", () => {
    const main = document.createElement("main")
    main.dataset.testid = "main-panel"
    document.body.append(main)
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      () => [{}] as unknown as DOMRectList,
    )
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, left: 360, width: 920, height: 800, bottom: 800, right: 1280 }) as DOMRect,
    )
    const area = mainArea(desktop)
    expect(area).toEqual({ top: 0, left: 360, width: 920, height: 800 })
    for (const c of panelCandidates(desktop, 240, area)) {
      expect(c.rect.left).toBeGreaterThanOrEqual(360 + 16)
      expect(c.rect.left + c.rect.width).toBeLessThanOrEqual(1280 - 16)
    }
    // Even a spotlight over the whole main panel never sends it over the sidebar.
    const spot = { top: 0, left: 360, width: 920, height: 800 }
    const id = placePanel(panelCandidates(desktop, 240, area), spot)
    expect(panelFrame(id, area, desktop).left).toBeGreaterThanOrEqual(376)
  })

  it("without the shell on the page, keeps right of the activity bar", () => {
    for (const c of panelCandidates(desktop, 240)) expect(c.rect.left).toBeGreaterThanOrEqual(64)
  })

  it("the bottom corner is measured from the bottom, so the card grows upward", () => {
    const area = { top: 0, left: 360, width: 920, height: 800 }
    expect(panelFrame("bottom-left", area, desktop)).toEqual({ left: 376, bottom: 16 })
    expect(panelFrame("top-left", area, desktop)).toEqual({ left: 376, top: 64 })
  })

  it("returns to its corner once that hides nothing again", () => {
    const candidates = panelCandidates(desktop, 240)
    expect(
      layoutPanel(candidates, { spot: null, work: [], current: "top-left", home: "bottom-left" })
        .placement,
    ).toBe("bottom-left")
  })

  it("phone: the sheet goes to the top when the spotlight is the bottom action bar", () => {
    const bar = { top: 734, left: 0, width: 390, height: 54 }
    expect(placePanel(sheetCandidates(phone, 260), bar)).toBe("top")
    const header = { top: 60, left: 0, width: 390, height: 80 }
    expect(placePanel(sheetCandidates(phone, 260), header)).toBe("bottom")
  })

  it("overlap and the cheapest pick", () => {
    expect(
      overlapArea(
        { top: 0, left: 0, width: 10, height: 10 },
        { top: 5, left: 5, width: 10, height: 10 },
      ),
    ).toBe(25)
    expect(
      overlapArea(
        { top: 0, left: 0, width: 10, height: 10 },
        { top: 10, left: 0, width: 10, height: 10 },
      ),
    ).toBe(0)
    const rect = { top: 0, left: 0, width: 1, height: 1 }
    expect(
      pickPlacement(
        [
          { id: "a", rect },
          { id: "b", rect },
        ],
        () => 3,
      ),
    ).toBe("a")
  })
})

describe("chip placement", () => {
  it("covers no control: skips a spot over a button, keeps the first clear one", () => {
    const button = document.createElement("button")
    document.body.append(button)
    const candidates = chipCandidates(desktop, { width: 200, height: 30 }, false)
    const first = candidates[0]?.rect
    if (!first) throw new Error("no candidate")
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (x: number, y: number) =>
        x >= first.left &&
        x <= first.left + first.width &&
        y >= first.top &&
        y <= first.top + first.height
          ? [button, document.body]
          : [document.body],
    })
    expect(coveredControls(first)).toBe(1)
    expect(pickPlacement(candidates, (r) => coveredControls(r))).toBe("bottom-center")
  })

  it("looks through the tour's own UI to what is under it", () => {
    const chip = document.createElement("div")
    chip.setAttribute("data-tour-ui", "")
    const row = document.createElement("button")
    document.body.append(chip, row)
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [chip, row, document.body],
    })
    expect(coveredControls({ top: 0, left: 0, width: 100, height: 20 })).toBe(1)
  })
})

describe("the work area (D14) and other controls (D12)", () => {
  const bar = { top: 734, left: 0, width: 390, height: 54 }

  it("phone: the sheet leaves the composer sheet the beat opened at the top", () => {
    const sheet = { top: 61, left: 0, width: 390, height: 238 }
    // The spotlight alone would send it to the top, over the sheet.
    expect(placePanel(sheetCandidates(phone, 245), bar)).toBe("top")
    const layout = layoutPanel(sheetCandidates(phone, 245), { spot: bar, work: [sheet] })
    expect(layout).toEqual({ placement: "bottom", crowded: false, covers: null })
  })

  it("phone: an editor that fills the screen leaves no free area", () => {
    const editor = { top: 120, left: 0, width: 390, height: 640 }
    const layout = layoutPanel(sheetCandidates(phone, 245), { spot: null, work: [editor] })
    expect(layout.crowded).toBe(true)
  })

  it("a large spotlight alone never folds the panel", () => {
    const list = { top: 60, left: 0, width: 390, height: 720 }
    expect(layoutPanel(sheetCandidates(phone, 245), { spot: list, work: [] }).crowded).toBe(false)
  })

  it("desktop: among corners clear of the spotlight, the one over fewest controls", () => {
    const spot = { top: 200, left: 340, width: 300, height: 200 }
    const candidates = panelCandidates(desktop, 240)
    const controls = (r: { top: number; left: number }) =>
      r.top < 400 && r.left > 600 ? 3 : r.top > 400 && r.left > 600 ? 2 : 0
    expect(layoutPanel(candidates, { spot, work: [], controls }).placement).toBe("bottom-left")
  })

  it("desktop: when every corner holds a sidebar, the details or the reply box, the middle", () => {
    // Tickets step 4: the details column is spotlit, the composer fills the bottom left.
    const details = { top: 40, left: 960, width: 320, height: 760 }
    const controls = (r: { left: number }) => (r.left < 400 ? 6 : 0)
    const layout = layoutPanel(panelCandidates(desktop, 240), { spot: details, work: [], controls })
    expect(layout.placement).toBe("top-center")
  })

  it("keeps its spot on a tie instead of hopping", () => {
    const candidates = panelCandidates(desktop, 240)
    expect(layoutPanel(candidates, { spot: null, work: [], current: "top-right" }).placement).toBe(
      "top-right",
    )
  })

  it("collects open sheets, the focused field and the beat's typing targets, never the tour's own UI", () => {
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    const tourDialog = document.createElement("div")
    tourDialog.setAttribute("role", "dialog")
    tourDialog.setAttribute("data-tour-ui", "")
    const editor = document.createElement("div")
    editor.dataset.testid = "doc-editor"
    document.body.append(dialog, tourDialog, editor)
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      () => [{}] as unknown as DOMRectList,
    )
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this === dialog ? 10 : this === editor ? 300 : 600
      return { top, left: 0, width: 100, height: 50, bottom: top + 50, right: 100 } as DOMRect
    })
    expect(workAreas(["doc-editor", "not-on-screen"]).map((r) => r.top)).toEqual([10, 300])
  })
})

describe("a spotlight under a later layer (D13)", () => {
  const box = { top: 700, left: 0, width: 390, height: 50 }

  function hits(list: Element[]) {
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => list,
    })
  }

  it("is covered when a sheet is the topmost thing over its centre", () => {
    const anchor = document.createElement("div")
    const inner = document.createElement("button")
    anchor.append(inner)
    const sheet = document.createElement("div")
    const panel = document.createElement("section")
    panel.setAttribute("data-tour-ui", "")
    document.body.append(anchor, sheet, panel)
    window.innerWidth = 390
    window.innerHeight = 844
    hits([sheet, anchor, document.body])
    expect(isCoveredByLayer(anchor, box)).toBe(true)
    hits([panel, inner, anchor, document.body])
    expect(isCoveredByLayer(anchor, box)).toBe(false)
    hits([document.body])
    expect(isCoveredByLayer(anchor, box)).toBe(false)
    Reflect.deleteProperty(document, "elementsFromPoint")
  })

  // Walk 2026-10-26: the three subtasks the agent made were never ringed. The
  // group's centre is its second row, which the first-row check took for a layer.
  it("a group is not covered by its own rows", () => {
    const rows = [0, 1, 2].map(() => document.createElement("li"))
    const cell = document.createElement("span")
    rows[1]?.append(cell)
    const sheet = document.createElement("div")
    document.body.append(...rows, sheet)
    window.innerWidth = 1280
    window.innerHeight = 800
    hits([cell, rows[1] as Element, document.body])
    expect(isCoveredByLayer(rows, box)).toBe(false)
    hits([sheet, rows[1] as Element, document.body])
    expect(isCoveredByLayer(rows, box)).toBe(true)
    Reflect.deleteProperty(document, "elementsFromPoint")
  })
})

describe("the phone chip (D4)", () => {
  it("climbs above an action bar that fills the bottom edge, and keeps off the header", () => {
    const control = document.createElement("button")
    document.body.append(control)
    const size = { width: 220, height: 30 }
    const candidates = chipCandidates(phone, size, true)
    // The action bar sits on the bottom row; the header on the top one.
    const onControl = (y: number) => y > 700 || y < 60
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (_x: number, y: number) => (onControl(y) ? [control] : [document.body]),
    })
    const id = pickPlacement(candidates, (r) => coveredControls(r))
    Reflect.deleteProperty(document, "elementsFromPoint")
    expect(id).toMatch(/^row\d+-/)
    const rect = candidates.find((c) => c.id === id)?.rect
    expect(rect && rect.top + rect.height).toBeLessThanOrEqual(700)
  })
})
