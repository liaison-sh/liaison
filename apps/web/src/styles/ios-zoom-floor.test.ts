// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The 16px floor is a TIER rule for the same reason the touch floor is: iOS
// zooms on focus for any field under 16px and never zooms back, so one control
// styled small anywhere is one screen the user cannot get back. jsdom computes
// no layout and applies no stylesheet cascade, so what is pinned here is the
// rule itself; the live computed size is read off the simulator in the walk.
//
// The blocks are PARSED rather than sliced. Reading from the first phone tier
// `@media` to the end of the file made the assertions cover whatever happened
// to sit last in the stylesheet, and left a second phone tier block added
// above it unchecked, which is exactly where a small field would come back.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "vitest"

/** The phone tier's own breakpoint (modules/shell/Shell.tsx). */
const PHONE_TIER_PX = 639

/** The body of the block whose opening brace is at `open`, braces balanced. */
function blockBody(css: string, open: number): string {
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1
    else if (css[i] === "}") {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error("unbalanced braces in index.css")
}

/** Every `@media` block that applies at the phone tier, however many there are. */
function phoneTierBlocks(css: string): string[] {
  const blocks: string[] = []
  const opener = /@media([^{]*)\{/g
  let match: RegExpExecArray | null = opener.exec(css)
  while (match !== null) {
    const widths = [...match[1].matchAll(/max-width:\s*(\d+(?:\.\d+)?)px/g)].map((m) =>
      Number(m[1]),
    )
    if (widths.some((width) => width <= PHONE_TIER_PX)) {
      blocks.push(blockBody(css, match.index + match[0].length - 1))
    }
    match = opener.exec(css)
  }
  return blocks
}

const css = readFileSync(resolve(__dirname, "..", "index.css"), "utf-8")

describe("phone tier text field zoom floor", () => {
  const blocks = phoneTierBlocks(css)

  test("declares the floor at the phone tier breakpoint", () => {
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.some((block) => /font-size:\s*16px/.test(block))).toBe(true)
  })

  test("covers every field a finger can focus, plus the composer placeholder", () => {
    const covering = blocks.filter((block) => /font-size:\s*16px/.test(block))
    for (const selector of [
      "input",
      "textarea",
      "select",
      '[contenteditable="true"]',
      '[role="textbox"]',
      "[data-compose-placeholder]",
    ]) {
      expect(covering.some((block) => block.includes(selector))).toBe(true)
    }
  })

  test("declares no font size under the floor in any phone tier block", () => {
    const sizes = blocks.flatMap((block) =>
      [...block.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])),
    )
    expect(sizes.length).toBeGreaterThan(0)
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16)
  })
})

// The tier rule is `:root :is(...)`, specificity (0,2,0), so it outranks any
// utility class a component can carry. The one thing it cannot outrank is an
// inline style, which is why those are swept rather than trusted.
describe("no component styles itself under the floor inline", () => {
  const MODULES = resolve(__dirname, "..", "modules")

  function componentFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) componentFiles(full, found)
      // Tests carry sample email HTML with sizes of its own; what ships is
      // the components.
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full)
    }
    return found
  }

  test("declares no inline font size under the floor anywhere in the modules", () => {
    const files = componentFiles(MODULES)
    expect(files.length).toBeGreaterThan(50)
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, "utf-8")
      for (const match of text.matchAll(/font-?[sS]ize"?'?:\s*"?'?(\d+(?:\.\d+)?)px/g)) {
        if (Number(match[1]) < 16) offenders.push(`${file.slice(MODULES.length + 1)}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
