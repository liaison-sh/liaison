// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Page links in the reader (S13, S14): a link renders as an empty span holding the id
// (never a label, even one an older text still holds), the page draws the title the
// resolver answers into it, and a page the reader cannot open is the neutral label
// with no title anywhere. Titles are asked in batches and asked again on a rename.
import { describe, expect, it, vi } from "vitest"
import { hydratePageLinks } from "./hydrate-tokens"
import { renderMarkdown } from "./markdown"
import {
  pageLinkDeps,
  pickPages,
  RESOLVE_BATCH,
  refreshPageTitle,
  resetPageTitles,
  watchPageTitle,
} from "./page-links"

const READ = "11111111-1111-4111-8111-111111111111"
const SECRET = "33333333-3333-4333-8333-333333333333"
const t = ((key: string) =>
  key === "kernel.editor.pageUnavailable" ? "Page you cannot open" : key) as never

/** A server that answers the titles of `readable` only, and records each call. */
function server(readable: Record<string, string>) {
  const post = vi.fn(async (_path: string, body: unknown) => {
    const ids = (body as { ids: string[] }).ids
    return ids.filter((id) => id in readable).map((id) => ({ id, title: readable[id]! }))
  })
  const get = vi.fn(async () => [{ id: READ, title: readable[READ] }])
  return { post, get } as unknown as { post: typeof post; get: typeof get }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("reader markdown", () => {
  it("a link is an empty span holding the id, whatever label the text holds", () => {
    const html = renderMarkdown(
      [
        `Bare [](knowledge:document:${SECRET})`,
        `Agent @[Secret plan](knowledge:document:${SECRET})`,
        `Labelled [Secret plan](knowledge:document:${SECRET})`,
        `Nested @[Q3 [draft] Zephyr](knowledge:document:${SECRET})`,
        "`code [](knowledge:document:" + SECRET + ")`",
      ].join("\n\n"),
    )
    expect(html).not.toContain("Secret")
    expect(html).not.toContain("Zephyr")
    expect(html).not.toContain("draft")
    expect(html.match(/<span data-page-link="[^"]+"><\/span>/g)?.length).toBe(4)
    // Code shows its text as written, never a link.
    expect(html).toContain("<code>")
  })

  it("an image of a page address is not a page link", () => {
    const html = renderMarkdown(`![x](knowledge:document:${SECRET})`)
    expect(html).not.toContain("data-page-link")
  })
})

describe("reader chips", () => {
  it("draws readable titles, the neutral label for the rest, and opens on click", async () => {
    resetPageTitles()
    const api = server({ [READ]: "Return procedure" })
    const root = document.createElement("div")
    root.innerHTML = renderMarkdown(
      `See [](knowledge:document:${READ}) and @[Secret plan](knowledge:document:${SECRET})`,
    )
    const deps = pageLinkDeps(api as never, t)
    const open = vi.spyOn(deps, "open").mockImplementation(() => {})
    const stop = hydratePageLinks(root, deps)
    await tick()
    const [a, b] = root.querySelectorAll<HTMLElement>("[data-page-link]")
    expect(a?.textContent).toBe("Return procedure")
    expect(a?.getAttribute("role")).toBe("link")
    expect(b?.textContent).toBe("Page you cannot open")
    expect(b?.dataset.state).toBe("unavailable")
    expect(b?.hasAttribute("role")).toBe(false)
    expect(root.innerHTML).not.toContain("Secret")
    expect(root.querySelector("[title]")).toBeNull()
    // One request for both chips.
    expect(api.post).toHaveBeenCalledTimes(1)
    b?.click()
    expect(open).not.toHaveBeenCalled()
    a?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(open).toHaveBeenCalledWith(READ, "Return procedure")
    stop()
  })
})

describe("title resolver", () => {
  it("asks once per tick, in batches the server accepts", async () => {
    resetPageTitles()
    const api = server({})
    const ids = Array.from(
      { length: RESOLVE_BATCH + 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    )
    const seen: unknown[] = []
    for (const id of ids) watchPageTitle(api as never, id, (title) => seen.push(title))
    await tick()
    await tick()
    expect(api.post).toHaveBeenCalledTimes(2)
    expect((api.post.mock.calls[0]![1] as { ids: string[] }).ids.length).toBe(RESOLVE_BATCH)
    expect(seen.filter((s) => s === null).length).toBe(ids.length)
  })

  it("a rename asks again for the chips that show the page, and only for them", async () => {
    resetPageTitles()
    const titles: Record<string, string> = { [READ]: "Old name" }
    const api = server(titles)
    const seen: unknown[] = []
    const stop = watchPageTitle(api as never, READ, (title) => seen.push(title))
    await tick()
    titles[READ] = "New name"
    refreshPageTitle(api as never, READ)
    await tick()
    expect(seen.at(-1)).toBe("New name")
    stop()
    refreshPageTitle(api as never, READ)
    await tick()
    expect(api.post).toHaveBeenCalledTimes(2)
  })

  it("a failed request shows the neutral label and asks again next time", async () => {
    resetPageTitles()
    const api = server({ [READ]: "Return procedure" })
    api.post.mockRejectedValueOnce(new Error("offline"))
    const first: unknown[] = []
    watchPageTitle(api as never, READ, (title) => first.push(title))
    await tick()
    expect(first.at(-1)).toBeNull()
    const second: unknown[] = []
    watchPageTitle(api as never, READ, (title) => second.push(title))
    await tick()
    expect(second.at(-1)).toBe("Return procedure")
  })

  it("the picker leaves out the page itself and makes its titles known", async () => {
    resetPageTitles()
    const api = server({ [READ]: "Return procedure" })
    expect(await pickPages(api as never, "ret", READ)).toEqual([])
    expect(api.get).toHaveBeenCalledWith("/knowledge/documents/pick?q=ret", expect.anything())
    const found = await pickPages(api as never, "  ret ")
    expect(found).toEqual([{ id: READ, title: "Return procedure" }])
    const seen: unknown[] = []
    watchPageTitle(api as never, READ, (title) => seen.push(title))
    expect(seen).toEqual(["Return procedure"])
    expect(api.post).not.toHaveBeenCalled()
  })
})
