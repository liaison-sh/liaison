// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  APP_ICON_SVG_MAX_BYTES,
  appIconSvgDataUrl,
  appIconSvgProblems,
  isAppIconName,
} from "./app-icon-svg"

const NS = 'xmlns="http://www.w3.org/2000/svg"'
const CLEAN = `<svg ${NS} viewBox="0 0 24 24"><title>Metrics</title><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><g fill="none" stroke="url(#g)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7" rx="1"/><circle cx="17" cy="8" r="2"/><polyline points="7 14 11 10 15 13"/></g></svg>`

const wrap = (inner: string) => `<svg ${NS} viewBox="0 0 24 24">${inner}</svg>`

describe("appIconSvgProblems", () => {
  it("accepts a clean icon unchanged, and its data URL decodes to the same markup", () => {
    expect(appIconSvgProblems(CLEAN)).toEqual([])
    const url = appIconSvgDataUrl(CLEAN)
    expect(url?.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true)
    expect(decodeURIComponent((url ?? "").slice("data:image/svg+xml;charset=utf-8,".length))).toBe(
      CLEAN,
    )
  })

  it("accepts a leading XML declaration and whitespace between elements", () => {
    expect(
      appIconSvgProblems(
        `<?xml version="1.0" encoding="UTF-8"?>\n${wrap('\n  <path d="M0 0h1"/>\n')}`,
      ),
    ).toEqual([])
  })

  // L1: the declaration could name another encoding than the one the check read; the
  // image is the markup alone, declared UTF-8 by the data URL.
  it("drops the XML declaration from the data URL", () => {
    const url = appIconSvgDataUrl(`<?xml version="1.0" encoding="UTF-16"?>\n${CLEAN}`)
    expect(url).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(CLEAN)}`)
  })

  it.each([
    ["script", wrap("<script>alert(1)</script>"), "the element <script>"],
    ["style element", wrap("<style>path{fill:red}</style>"), "the element <style>"],
    ["style attribute", wrap('<path style="fill:red" d="M0 0"/>'), "the attribute style"],
    [
      "event handler",
      `<svg ${NS} onload="alert(1)"><path d="M0 0"/></svg>`,
      "the attribute onload",
    ],
    ["href", wrap('<a href="javascript:alert(1)"><path d="M0 0"/></a>'), "the attribute href"],
    ["xlink:href", wrap('<use xlink:href="#x"/>'), "the attribute xlink:href"],
    ["foreignObject", wrap("<foreignObject><div/></foreignObject>"), "the element <foreignObject>"],
    ["image", wrap('<image width="1" height="1"/>'), "the element <image>"],
    ["use", wrap('<use x="1"/>'), "the element <use>"],
    [
      "outside reference",
      wrap('<path fill="url(https://evil.example/x.svg#a)" d="M0 0"/>'),
      "a reference outside the icon in fill",
    ],
    // L1: a character reference spells url( past the reference check.
    [
      "numeric reference in an attribute",
      wrap('<path fill="u&#114;l(https://evil.example/x.svg#a)" d="M0 0"/>'),
      "a character reference in fill",
    ],
    [
      "hex reference in an attribute",
      wrap('<path fill="&#x75;rl(https://evil.example/x.svg#a)" d="M0 0"/>'),
      "a character reference in fill",
    ],
    [
      "named reference in an attribute",
      wrap('<path stroke="url&lpar;https://evil.example/x.svg#a)" d="M0 0"/>'),
      "a character reference in stroke",
    ],
    [
      "escape in an attribute",
      wrap('<path id="a&amp;b" d="M0 0"/>'),
      "a character reference in id",
    ],
    [
      "xmlns on a child element",
      wrap('<g xmlns="http://www.w3.org/1999/xhtml"><path d="M0 0"/></g>'),
      "xmlns on <g> (only the root <svg> declares it)",
    ],
    [
      "another namespace on the root",
      '<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 24 24"></svg>',
      'the root <svg> without xmlns="http://www.w3.org/2000/svg"',
    ],
    ["comment", wrap("<!-- hi --><path d='M0 0'/>"), "a comment"],
    ["CDATA", wrap("<![CDATA[x]]>"), "a CDATA section"],
    ["doctype", `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap("")}`, "a declaration or instruction"],
    ["unknown entity", wrap("<title>&x;</title>"), "an unknown character reference in the title"],
    ["text outside title", wrap("hello"), "text outside a <title>"],
    ["non-svg root", `<div ${NS}></div>`, "a root element <div> (it must be <svg>)"],
    [
      "missing xmlns",
      '<svg viewBox="0 0 24 24"></svg>',
      'the root <svg> without xmlns="http://www.w3.org/2000/svg"',
    ],
  ])("rejects %s", (_label, svg, reason) => {
    expect(appIconSvgProblems(svg)).toContain(reason)
    expect(appIconSvgDataUrl(svg)).toBeNull()
  })

  it("rejects malformed markup and an icon over the size limit", () => {
    expect(appIconSvgProblems(`<svg ${NS}><path d="M0 0">`).length).toBeGreaterThan(0)
    expect(appIconSvgProblems(`<svg ${NS}><g></svg>`).length).toBeGreaterThan(0)
    expect(appIconSvgProblems(`<svg ${NS}><path d=M0/></svg>`).length).toBeGreaterThan(0)
    const big = wrap(`<path d="${"M0 0 ".repeat(APP_ICON_SVG_MAX_BYTES / 4)}"/>`)
    expect(appIconSvgProblems(big)).toEqual([
      `the icon is larger than ${APP_ICON_SVG_MAX_BYTES} bytes`,
    ])
    expect(appIconSvgProblems(42)).toEqual(["the icon is not a string"])
  })
})

describe("isAppIconName", () => {
  it("knows Liaison's icon names and nothing else", () => {
    expect(isAppIconName("bar-chart")).toBe(true)
    expect(isAppIconName("BarChart")).toBe(false)
    expect(isAppIconName("<svg/>")).toBe(false)
  })
})
