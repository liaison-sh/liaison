// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared oracles for the `.phone.scenario` files.
//
// The first phone scenarios asserted `document.documentElement.scrollWidth <=
// window.innerWidth`. That is a FALSE NEGATIVE for every app surface built as a
// master/detail pane: a fixed `w-[440px]` list inside an `overflow-auto` parent
// clips its own content at 390 px while the document itself never grows, so the
// document-level check stays green over a visibly broken screen.
//
// `expectNoHorizontalClipping` looks at geometry instead: no element the user
// can actually see may have its right edge past the viewport. One pixel of
// slack absorbs sub-pixel layout rounding.
import { expect, type Page } from "@playwright/test"

export interface ClippedElement {
  selector: string
  right: number
  width: number
}

/**
 * The nearest ancestor (walking up to `document.scrollingElement`) whose
 * computed `overflow-x` is not `visible`, plus that ancestor's own right
 * edge. `null` means no such ancestor exists between the element and the
 * scrolling element.
 */
export interface ScrollAncestorInfo {
  overflowX: "auto" | "scroll" | "hidden"
  right: number
}

/** Plain-object geometry snapshot for one candidate element. Kept JSON-safe
 * so the decision logic can run identically inside a browser page.evaluate()
 * and in a plain unit test. */
export interface ClipCandidateInfo {
  right: number
  width: number
  height: number
  top: number
  bottom: number
  innerWidth: number
  innerHeight: number
  ariaHidden: boolean
  visibilityHidden: boolean
  scrollAncestor: ScrollAncestorInfo | null
}

/**
 * Pure decision: should this element be reported as clipping the viewport?
 *
 * - Zero-size, aria-hidden, `visibility: hidden` and vertically off-screen
 *   elements are never candidates: they paint nothing the user can see.
 * - An element whose right edge sits inside the viewport is never a candidate.
 * - Past that, an element inside an `overflow-x: auto`/`scroll` ancestor that
 *   is ITSELF within the viewport is a legitimate horizontal scroller (the
 *   tickets chip rail) and is skipped.
 * - Everything else — clipped by an `overflow: hidden` ancestor (the boxtal
 *   case), clipped with no scrolling ancestor at all, or clipped inside a
 *   scroller that has itself scrolled/overflowed past the viewport — is
 *   flagged.
 */
export function isClippingCandidate(el: ClipCandidateInfo): boolean {
  if (el.ariaHidden || el.visibilityHidden) return false
  if (el.width === 0 || el.height === 0) return false
  if (el.bottom < 0 || el.top > el.innerHeight) return false

  const limit = el.innerWidth + 1
  if (el.right <= limit) return false

  const ancestor = el.scrollAncestor
  if (ancestor && (ancestor.overflowX === "auto" || ancestor.overflowX === "scroll")) {
    if (ancestor.right <= limit) return false
  }
  return true
}

/** Every visible element whose right edge is past the viewport, worst first. */
export async function findHorizontalClipping(page: Page): Promise<{
  innerWidth: number
  offenders: ClippedElement[]
}> {
  const isClippingCandidateSource = isClippingCandidate.toString()
  return await page.evaluate((candidateSource) => {
    // biome-ignore lint/security/noGlobalEval: reconstructing a known, local,
    // dependency-free pure function inside the page context so the exact same
    // decision logic runs here and in the unit test (see phone-helpers.test.ts).
    const isCandidate = new Function(`return (${candidateSource})`)() as (info: unknown) => boolean

    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : ""
      const testid = el.getAttribute("data-testid")
      const cls =
        typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : ""
      return `${el.tagName.toLowerCase()}${id}${testid ? `[data-testid="${testid}"]` : ""}${cls}`
    }

    const scrollingElement = document.scrollingElement
    const nearestScrollAncestor = (el: Element) => {
      let node: Element | null = el.parentElement
      while (node) {
        // An icon's <svg> clips its own drawing (overflow: hidden by default), not the layout:
        // its paths scroll with whatever box holds the icon.
        if (node instanceof SVGElement) {
          node = node.parentElement
          continue
        }
        const overflowX = window.getComputedStyle(node).overflowX
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") {
          const rect = node.getBoundingClientRect()
          return { overflowX, right: rect.right } as const
        }
        if (node === scrollingElement) break
        node = node.parentElement
      }
      return null
    }

    const offenders: Array<{ selector: string; right: number; width: number }> = []
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const style = window.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      const info = {
        right: rect.right,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        ariaHidden: el.closest('[aria-hidden="true"]') !== null,
        visibilityHidden: style.visibility === "hidden" || style.display === "none",
        scrollAncestor: nearestScrollAncestor(el),
      }
      if (isCandidate(info)) {
        offenders.push({ selector: describe(el), right: rect.right, width: rect.width })
      }
    }
    offenders.sort((a, b) => b.right - a.right)
    return { innerWidth: window.innerWidth, offenders: offenders.slice(0, 12) }
  }, isClippingCandidateSource)
}

/**
 * Assert the page fits the phone: nothing visible reaches past `innerWidth`.
 * Catches clipping inside a scroll pane, which a `scrollWidth` check cannot see.
 */
export async function expectNoHorizontalClipping(page: Page): Promise<void> {
  const { innerWidth, offenders } = await findHorizontalClipping(page)
  expect(
    offenders,
    `elements past the ${innerWidth}px viewport: ${JSON.stringify(offenders, null, 2)}`,
  ).toEqual([])
}
