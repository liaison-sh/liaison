// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import path from "node:path"
import { checkRoot, checkSource } from "./lint-button-width"

const IMPORT = `import { Button } from "~/ui/Button"\n`

function check(jsx: string) {
  return checkSource("x.tsx", `${IMPORT}export const X = () => (\n${jsx}\n)\n`)
}

describe("lint-button-width", () => {
  it("flags a full-width Button beside text in a flex row (the Settings > Nodes squeeze)", () => {
    const found = check(
      `<div class="flex items-center justify-between gap-4"><p>Long details</p><Button fullWidth>Detach</Button></div>`,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.parentTag).toBe("div")
    expect(found[0]?.line).toBe(3)
  })

  it("flags w-full set through the class too, and sees through Show and For", () => {
    const found = check(
      `<div class="flex gap-2"><Show when={a}><For each={xs}>{(x) => <Button class="w-full">{x}</Button>}</For></Show></div>`,
    )
    expect(found).toHaveLength(1)
  })

  it("flags a breakpoint row", () => {
    expect(
      check(`<div class="flex flex-col sm:flex-row"><Button fullWidth>Go</Button></div>`),
    ).toHaveLength(1)
  })

  it("passes a button that is full width while stacked and sized to its label once the breakpoint row applies", () => {
    expect(
      check(
        `<div class="flex flex-col gap-2 sm:flex-row"><Button class="w-full sm:w-auto">Go</Button></div>`,
      ),
    ).toEqual([])
    // The override has to come at the row's own breakpoint...
    expect(
      check(
        `<div class="flex flex-col gap-2 lg:flex-row"><Button class="w-full sm:w-auto">Go</Button></div>`,
      ),
    ).toHaveLength(1)
    // ...and cannot rescue a row that is a row on every screen.
    expect(
      check(
        `<div class="flex gap-2 sm:flex-row"><Button class="w-full sm:w-auto">Go</Button></div>`,
      ),
    ).toHaveLength(1)
  })

  it("passes full width in a stacked form, a wrapping row, or with an equal share", () => {
    expect(
      check(`<form class="flex flex-col gap-4"><Button fullWidth type="submit">Go</Button></form>`),
    ).toEqual([])
    expect(check(`<form class="space-y-3"><Button fullWidth>Go</Button></form>`)).toEqual([])
    expect(
      check(
        `<div class="flex flex-wrap gap-2"><Button class={phone() ? "w-full" : undefined}>Go</Button></div>`,
      ),
    ).toEqual([])
    expect(
      check(`<div class="flex gap-2"><Button fullWidth class="flex-1">A</Button></div>`),
    ).toEqual([])
  })

  it("passes a default Button in a row: full width is opt-in", () => {
    expect(check(`<div class="flex items-center gap-3"><p>x</p><Button>Go</Button></div>`)).toEqual(
      [],
    )
  })

  it("leaves a Button whose parent is another component, and files that do not import the shared Button", () => {
    expect(
      check(
        `<div class="flex gap-2"><Dialog.Footer><Button fullWidth>Go</Button></Dialog.Footer></div>`,
      ),
    ).toEqual([])
    expect(
      checkSource(
        "y.tsx",
        `export const Y = () => <div class="flex"><Button fullWidth>Go</Button></div>\n`,
      ),
    ).toEqual([])
  })

  it("the web app is clean", () => {
    expect(checkRoot(path.resolve(import.meta.dir, ".."))).toEqual([])
  })
})
