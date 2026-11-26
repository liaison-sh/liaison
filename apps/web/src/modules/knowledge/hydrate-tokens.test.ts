// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reader of a page (S11, S12): a file token renders as an empty span holding the
// id, and the page mounts the file's view into it. A hostile body draws no element
// that fetches anything. The control renders the same body with the sanitizer off,
// proving the hostile body would otherwise draw remote images.
import { editorMarkdown } from "@liaison/shared"
import { waitFor } from "@solidjs/testing-library"
import { Marked } from "marked"
import { describe, expect, it, vi } from "vitest"
import type { FileViewDeps } from "~/modules/editor/file-view"
import { hydrateFileTokens } from "./hydrate-tokens"
import { renderMarkdown } from "./markdown"

const MINE = "11111111-1111-4111-8111-111111111111"
const OTHER_ORG = "99999999-9999-4999-8999-999999999999"

const HOSTILE_BODY = [
  "# Hostile page",
  "![web](https://evil.example/md.png)",
  '<img src="https://evil.example/raw.png" srcset="https://evil.example/set.png 2x">',
  '<picture><source srcset="https://evil.example/pic.png"><img src="https://evil.example/pic2.png"></picture>',
  '<p style="background-image:url(https://evil.example/css.png)">styled</p>',
  '<svg><image href="https://evil.example/svg.png"/></svg>',
  "![svg](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=)",
  '<a href="data:text/html,<img src=https://evil.example/a.png>">data link</a>',
  `<span data-page-file="https://evil.example/span.png">bad span</span>`,
  `<span data-page-file="${OTHER_ORG}"></span>`,
  `Mine: ![](liaison-file:${MINE}) and another org's: ![](liaison-file:${OTHER_ORG})`,
  "<style>body{background:url(https://evil.example/style.png)}</style>",
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<iframe src="https://evil.example/frame"></iframe>',
].join("\n\n")

/** Every attribute value the browser would fetch, anywhere under `root`. */
function fetchable(root: ParentNode): string[] {
  const out: string[] = []
  for (const el of root.querySelectorAll("*")) {
    for (const attr of ["src", "srcset", "href", "poster", "background", "data"]) {
      const v = el.getAttribute(attr)
      if (!v) continue
      if (attr === "href" && el.tagName === "A") continue // a link is fetched on a click only
      out.push(`${el.tagName.toLowerCase()}[${attr}]=${v}`)
    }
    const style = el.getAttribute("style")
    if (style && /url\(/i.test(style)) out.push(`${el.tagName.toLowerCase()}[style]`)
    if (["STYLE", "LINK", "IFRAME", "OBJECT", "EMBED"].includes(el.tagName))
      out.push(el.tagName.toLowerCase())
  }
  return out
}

function deps(): FileViewDeps {
  return {
    resolve: vi.fn(async (id: string) =>
      id === MINE ? { id, filename: "chart.png", mimeType: "image/png", sizeBytes: 10 } : null,
    ),
    imageUrl: vi.fn(async (id: string) => `blob:http://localhost/${id}`),
    labels: { unavailable: "Image not available", loading: "Loading", download: (n) => n },
  }
}

describe("the reader of a page", () => {
  it("control: with the sanitizer off, the hostile body draws remote images", () => {
    const raw = document.createElement("div")
    raw.innerHTML = new Marked({ gfm: true }, editorMarkdown).parse(HOSTILE_BODY, {
      async: false,
    }) as string
    expect(fetchable(raw).filter((f) => f.includes("evil.example")).length).toBeGreaterThan(3)
  })

  it("renders a file token as an empty span holding only the id", () => {
    const html = renderMarkdown(`A ![](liaison-file:${MINE}) B ![alt](liaison-file:${MINE})`)
    expect(html.trim()).toBe(
      `<p>A <span data-page-file="${MINE}"></span> B <span data-page-file="${MINE}"></span></p>`,
    )
  })

  it("a hostile body: nothing fetchable before or after the files are mounted", async () => {
    const root = document.createElement("div")
    root.innerHTML = renderMarkdown(HOSTILE_BODY)
    expect(fetchable(root)).toEqual([])
    const view = deps()
    const stop = hydrateFileTokens(root, view, "Image or file")
    await waitFor(() =>
      expect(root.querySelectorAll('[data-testid="liaison-file-unavailable"]').length).toBe(2),
    )
    await waitFor(() => expect(root.querySelector("img")).not.toBeNull())
    // The only picture is this app's blob of the page's own file.
    expect(fetchable(root)).toEqual([`img[src]=blob:http://localhost/${MINE}`])
    // The bad span was neither looked up nor kept as a file.
    expect(view.resolve).not.toHaveBeenCalledWith("https://evil.example/span.png")
    expect(view.resolve).toHaveBeenCalledWith(OTHER_ORG)
    stop()
  })

  it("looks up nothing for a span whose value is not a file id, even unsanitized", () => {
    const root = document.createElement("div")
    root.innerHTML = '<span data-page-file="https://evil.example/x.png">x</span>'
    const view = deps()
    hydrateFileTokens(root, view, "Image or file")
    expect(view.resolve).not.toHaveBeenCalled()
    expect(root.textContent).toBe("")
  })
})
