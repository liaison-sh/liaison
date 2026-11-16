// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A quoted signing link is cut before inbound text is stored, however the
// mail client wrote it; and the page writer recognises this org's signing mail
// by its header id, on Gmail and IMAP alike, or quoted in a bounce's text.
import { describe, expect, it } from "bun:test"
import { IMAP_INGEST_HEADERS } from "~/modules/apps/sandbox/imap-bridge"
import { cutSigningLinks, SIGNING_LINK_REMOVED } from "./quoted-link"
import { actionMailIdsOf } from "./synced-mail"

const TOKEN = "Zx9_k-3QeLmN0pRsT1uVwXyZaBcDeFgHiJkLmNoPqRs"
const LINK = `https://app.maison.example/a#t=${TOKEN}`

describe("a quoted signing link is cut", () => {
  it("in plain text, with the quote marks and the words around it kept", () => {
    const text = `Thanks, signed.\n\n> Open the document: ${LINK}\n> Regards`
    const out = cutSigningLinks(text)
    expect(out).toBe(`Thanks, signed.\n\n> Open the document: ${SIGNING_LINK_REMOVED}\n> Regards`)
    expect(out).not.toContain(TOKEN)
  })

  it("in HTML, as the link's address and as its shown text", () => {
    const html = `<blockquote><a href="${LINK}">${LINK}</a> <a href='${LINK}'>Read and sign</a></blockquote>`
    const out = cutSigningLinks(html)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain(`href="${SIGNING_LINK_REMOVED}"`)
    expect(out).toContain("Read and sign")
  })

  it("percent-encoded once or twice, as a link-protection wrapper writes it", () => {
    const once = `https://protect.example/?url=https%3A%2F%2Fapp.maison.example%2Fa%23t%3D${TOKEN}&data=05`
    const twice = `https://wrap.example/r?u=https%253A%252F%252Fapp.maison.example%252Fa%2523t%253D${TOKEN}`
    const html = `<a href="${once}">x</a> ${twice}`
    const out = cutSigningLinks(html)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain("&data=05")
  })

  it("written with HTML entities or in another case", () => {
    const entity = `<a href="https://app.maison.example/a&#35;t&#61;${TOKEN}">x</a>`
    const hex = `/a&#x23;t&#x3D;${TOKEN}`
    const upper = `HTTPS://APP.MAISON.EXAMPLE/A#T=${TOKEN}`
    for (const s of [entity, hex, upper]) expect(cutSigningLinks(s)).not.toContain(TOKEN)
  })

  it("leaves text without a signing link as it is", () => {
    const text = "See https://app.maison.example/a and #t=1 and /about#team=2"
    expect(cutSigningLinks(text)).toBe(text)
    expect(cutSigningLinks(null)).toBeNull()
    expect(cutSigningLinks("")).toBe("")
  })
})

describe("the signing mail id a synced message carries", () => {
  const id = "a".repeat(32)

  it("is read from the header in any case, and from the header quoted in a bounce's text", () => {
    expect(actionMailIdsOf({ headers: { "X-Liaison-Action-Mail": id } })).toEqual([id])
    expect(actionMailIdsOf({ headers: { "x-liaison-action-mail": [id] } })).toEqual([id])
    const bounce = `Delivery failed.\n\nReceived: from x\nX-Liaison-Action-Mail: ${id}\nSubject: y`
    expect(actionMailIdsOf({ headers: {}, textBody: bounce })).toEqual([id])
  })

  it("is nothing for a value that is not a 128-bit hex id", () => {
    expect(actionMailIdsOf({ headers: { "x-liaison-action-mail": "not-an-id" } })).toEqual([])
    expect(actionMailIdsOf({ headers: {}, textBody: "hello" })).toEqual([])
  })

  it("is fetched by the IMAP sync, which asks for named headers only", () => {
    expect(IMAP_INGEST_HEADERS as readonly string[]).toContain("x-liaison-action-mail")
  })
})
