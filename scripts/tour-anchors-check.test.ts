// SPDX-License-Identifier: FSL-1.1-ALv2
// S21: a tour naming a testid that does not exist in the web source fails
// the check. The last case is the gate over the real catalogue.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tourCatalogue } from "../packages/shared/src/tours/index"
import { defineTour } from "../packages/shared/src/tours/schema"
import {
  addComposed,
  buildIndex,
  emptyIndex,
  findMissing,
  findTierMismatches,
  hasTestId,
  scanSource,
} from "./tour-anchors-check"

function tourWith(anchor: string, steps: string[] = []) {
  return defineTour({
    id: "kernel.fixture",
    app: "kernel",
    title: "tours.kernel.sample.title",
    summary: "tours.kernel.sample.summary",
    beats: [
      {
        id: "a",
        kind: "do",
        title: "tours.kernel.sample.welcome.title",
        body: "tours.kernel.sample.welcome.body",
        anchor,
        event: { app: "kernel", entity: "message", action: "create" },
        autoplay: steps.length ? steps.map((s) => ({ click: s })) : [{ click: anchor }],
      },
    ],
  })
}

describe("tour anchor check", () => {
  it("fails a tour whose anchor exists nowhere in the source", () => {
    const missing = findMissing([tourWith("tours-no-such-testid-xyz")], buildIndex())
    expect(missing).toEqual([{ tourId: "kernel.fixture", testid: "tours-no-such-testid-xyz" }])
  })

  it("also checks autoplay steps and phone overrides", () => {
    const index = emptyIndex()
    scanSource(`<div data-testid="fixture-a" />`, index)
    const tour = defineTour({
      ...tourWith("fixture-a"),
      beats: [
        {
          id: "a",
          kind: "do",
          title: "tours.kernel.sample.welcome.title",
          body: "tours.kernel.sample.welcome.body",
          anchor: "fixture-a",
          anchorPhone: "fixture-phone-missing",
          event: { app: "kernel", entity: "message", action: "create" },
          autoplay: [{ click: "fixture-a" }],
          autoplayPhone: [
            { type: { testid: "fixture-type-missing", text: "tours.kernel.sample.title" } },
          ],
        },
      ],
    })
    expect(findMissing([tour], index).map((m) => m.testid)).toEqual([
      "fixture-phone-missing",
      "fixture-type-missing",
    ])
  })

  it("accepts prop-passed, object-key and template testids", () => {
    const index = emptyIndex()
    scanSource(
      [
        `<Composer.Send testId="fixture-send" />`,
        `<Composer.Controls testid='fixture-controls' />`,
        `const cfg = { testid: "fixture-obj", "data-testid": "fixture-quoted-key" }`,
        "<div data-testid={`fixture-static`} />",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under scan
        "<button data-testid={`fixture-row-${item.id}`} />",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under scan
        "<span data-testid={`${kind}-tail`} />",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under scan
        "<DataTable rowTestid={(o) => `fixture-line-${o.id}`} />",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under scan
        '<button data-testid={id === "x" ? "fixture-special" : `fixture-tab-${id}`} />',
      ].join("\n"),
      index,
    )
    const ids = [
      "fixture-send",
      "fixture-controls",
      "fixture-obj",
      "fixture-quoted-key",
      "fixture-static",
      "fixture-row-42",
      "fixture-line-7",
      "fixture-special",
      "fixture-tab-routines",
    ]
    expect(findMissing([tourWith(ids[0] ?? "", ids)], index)).toEqual([])
    // An interpolated head gives no prefix: it must not accept anything.
    expect(hasTestId(index, "anything-tail")).toBe(false)
    // The bare prefix itself is not a testid.
    expect(hasTestId(index, "fixture-row-")).toBe(false)
    // A step's `prefix*` target needs a template with exactly that head.
    expect(hasTestId(index, "fixture-row-*")).toBe(true)
    expect(hasTestId(index, "fixture-ro-*")).toBe(false)
    expect(hasTestId(index, "fixture-static*")).toBe(false)
  })

  it("counts each part of a composed component under every root a page gives it", () => {
    const component = [
      "<div data-testid={tid()}>",
      '<form data-testid={tid("dropzone")}>',
      '<RichEditor data-testid={tid("composer")} />',
      "rowTestId={(id) => tid(`message-${id}`)}",
    ].join("\n")
    const page = [
      "<EntityDiscussion",
      "  threadId={id()}",
      "  rowLabel={(m) => m.title}",
      '  testId="contact-discussion"',
      "/>",
    ].join("\n")
    const index = emptyIndex()
    addComposed(index, "EntityDiscussion", component, [page, '<Other testId="x-y" />'])
    expect(hasTestId(index, "contact-discussion.composer")).toBe(true)
    expect(hasTestId(index, "contact-discussion.dropzone")).toBe(true)
    expect(hasTestId(index, "contact-discussion.message-m1")).toBe(true)
    expect(hasTestId(index, "contact-discussion.send")).toBe(false)
    expect(hasTestId(index, "x-y.composer")).toBe(false)
  })

  it("fails a beat whose anchor renders only at the other width", () => {
    const index = emptyIndex()
    scanSource(
      [
        `<div class="flex" data-testid="fixture-phone-row" data-tour-tier="phone" role="tablist">`,
        `<nav\n  data-testid="fixture-wide-nav"\n  data-tour-tier="wide"\n>`,
      ].join("\n"),
      index,
    )
    const show = (anchor: string, anchorPhone?: string) =>
      defineTour({
        id: "kernel.fixture",
        app: "kernel",
        title: "tours.kernel.sample.title",
        summary: "tours.kernel.sample.summary",
        beats: [
          {
            id: "a",
            kind: "show",
            title: "tours.kernel.sample.welcome.title",
            body: "tours.kernel.sample.welcome.body",
            anchor,
            ...(anchorPhone ? { anchorPhone } : {}),
          },
        ],
      })
    // A phone-only row as the desktop anchor: nothing to spotlight at 1280.
    expect(findTierMismatches([show("fixture-phone-row")], index)).toEqual([
      { tourId: "kernel.fixture", beatId: "a", testid: "fixture-phone-row", tier: "wide" },
    ])
    // A desktop-only nav with no phone override: nothing to spotlight at 390.
    expect(findTierMismatches([show("fixture-wide-nav")], index)).toEqual([
      { tourId: "kernel.fixture", beatId: "a", testid: "fixture-wide-nav", tier: "phone" },
    ])
    expect(findTierMismatches([show("fixture-wide-nav", "fixture-phone-row")], index)).toEqual([])
  })

  // Walk D60: Team chat's first step pointed at the desktop rail's Chats entry
  // (`activity-messages`, a template testid) with no phone anchor, so at 390 it
  // found nothing on screen. A tier on a template testid marks every testid
  // with that head.
  it("knows the width of a template testid's tag", () => {
    const index = emptyIndex()
    scanSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the JSX source a template testid is written in
      '<button\n  data-testid={`fixture-rail-${entry.id}`}\n  data-tour-tier="wide"\n>',
      index,
    )
    const beat = (anchorPhone?: string) =>
      defineTour({
        id: "kernel.fixture",
        app: "kernel",
        title: "tours.kernel.sample.title",
        summary: "tours.kernel.sample.summary",
        beats: [
          {
            id: "a",
            kind: "show",
            title: "tours.kernel.sample.welcome.title",
            body: "tours.kernel.sample.welcome.body",
            anchor: "fixture-rail-messages",
            ...(anchorPhone ? { anchorPhone } : {}),
          },
        ],
      })
    expect(findTierMismatches([beat()], index)).toEqual([
      { tourId: "kernel.fixture", beatId: "a", testid: "fixture-rail-messages", tier: "phone" },
    ])
    expect(findTierMismatches([beat("phone-tab-chats")], index)).toEqual([])
  })

  it("no shipped tour points at a surface that renders only at the other width", () => {
    expect(findTierMismatches(tourCatalogue({ includeTestTours: true }), buildIndex())).toEqual([])
  })

  it("every shipped and fixture tour names only testids that exist", () => {
    expect(findMissing(tourCatalogue({ includeTestTours: true }), buildIndex())).toEqual([])
  })

  it("runs on every PR: a step of the CI static job and the release gate, through the package script", () => {
    const root = join(import.meta.dir, "..")
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    expect(pkg.scripts["check:tour-anchors"]).toBe("bun run scripts/tour-anchors-check.ts")
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")
    const job = ci.slice(ci.indexOf("\n  static:"), ci.indexOf("\n  unit:"))
    expect(job).toContain("run: bun run check:tour-anchors")
    const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8")
    expect(release).toContain("run: bun run check:tour-anchors")
  })
})
