// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import {
  buildMailHtmlDocument,
  extractBodyClass,
  extractBodyCss,
  htmlHasImages,
  MailMessageRenderer,
  mailHasAuthoredColors,
  SHADOW_BASE_CSS,
  themeCssFromElement,
} from "./MailMessageRenderer"

const rendererMocks = vi.hoisted(() => ({
  isSenderImageAllowed: vi.fn(() => false),
  allowSenderImageDomain: vi.fn(),
  accessToken: () => null as string | null,
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn() }),
}))
vi.mock("~/modules/mail/mail-account-store", () => ({
  isSenderImageAllowed: rendererMocks.isSenderImageAllowed,
  allowSenderImageDomain: rendererMocks.allowSenderImageDomain,
}))
vi.mock("~/modules/mail/mail-sanitize", () => ({
  prepareMailHtml: (html: string) => html,
  sanitizeInlineStyle: (css: string) => css,
}))
vi.mock("~/modules/auth/auth-store", () => ({
  accessToken: () => rendererMocks.accessToken(),
}))

beforeEach(() => {
  rendererMocks.isSenderImageAllowed.mockReturnValue(false)
  rendererMocks.allowSenderImageDomain.mockReset()
  rendererMocks.accessToken = () => null
})

describe("MailMessageRenderer — theme inheritance", () => {
  test("SHADOW_BASE_CSS applies CSS custom properties inside the iframe body", () => {
    expect(SHADOW_BASE_CSS).toMatch(/body[\s\S]*color:\s*var\(--color-text/)
    expect(SHADOW_BASE_CSS).toMatch(/body[\s\S]*background:\s*transparent/)
    expect(SHADOW_BASE_CSS).toContain("var(--color-accent")
    expect(SHADOW_BASE_CSS).toContain("var(--color-border")
    // Hardcoded colors should only appear as fallback values inside var(), not standalone.
    expect(SHADOW_BASE_CSS).not.toMatch(/(?<!,\s*)#1a1a1a/)
    expect(SHADOW_BASE_CSS).not.toMatch(/(?<!\()\s*white\s*;/)
  })

  test("the frame takes the host's colour scheme, so a dark theme gets no white canvas", () => {
    const host = document.createElement("div")
    host.style.setProperty("--color-text", "#eeeeee")
    host.style.colorScheme = "dark"
    document.body.appendChild(host)
    try {
      const css = themeCssFromElement(host)
      expect(css).toContain("--color-text: #eeeeee;")
      expect(css).toContain("color-scheme: dark;")
    } finally {
      host.remove()
    }
  })

  test("buildMailHtmlDocument keeps email CSS in a full document", () => {
    const doc = buildMailHtmlDocument("<style>body { text-align: center; }</style><p>Hello</p>")
    expect(doc).toContain('<meta charset="utf-8">')
    expect(doc).toContain('<base target="_blank">')
    // The browser, not the regex CSS filter, decides what an email may load.
    expect(doc).toContain('http-equiv="Content-Security-Policy"')
    expect(doc).toContain("default-src 'none'")
    expect(doc).not.toMatch(/img-src[^"]*https?:/)
    expect(doc).toContain("body { text-align: center; }")
  })

  test("preserves safe body-level layout hints from full email documents", () => {
    const html =
      '<html><body class="email centered" align="center" style="margin: 0 auto; max-width: 640px"><p>Hello</p></body></html>'
    expect(extractBodyCss(html)).toContain("margin: 0 auto")
    expect(extractBodyCss(html)).toContain("text-align: center")
    expect(extractBodyClass(html)).toBe("email centered")

    const doc = buildMailHtmlDocument(
      "<p>Hello</p>",
      "",
      extractBodyCss(html),
      extractBodyClass(html),
    )
    expect(doc).toContain('class="email centered"')
    expect(doc).toContain("max-width: 640px")
  })
})

describe("MailMessageRenderer — authored colours", () => {
  afterEach(() => cleanup())

  test("a plain email sets no colours of its own", () => {
    expect(mailHasAuthoredColors("<p>Hi there,</p><p>My favourite color: blue.</p>")).toBe(false)
    expect(mailHasAuthoredColors('<div dir="ltr" style="font-size:14px">Hello</div>')).toBe(false)
    // Neither a border colour nor a colour scheme nor a neutral value is a colour.
    expect(
      mailHasAuthoredColors(
        '<p style="border-color:#ccc; color: inherit; background: transparent">x</p><style>:root { color-scheme: light dark; }</style>',
      ),
    ).toBe(false)
    // A tracking background image stripped by the sanitizer is not a colour.
    expect(mailHasAuthoredColors('<td style="background: /* stripped */">x</td>')).toBe(false)
  })

  test("any authored text or background colour counts", () => {
    expect(mailHasAuthoredColors('<p style="color:#333">Dark text</p>')).toBe(true)
    expect(mailHasAuthoredColors('<p style="font-size:14px color:#333">no semicolons</p>')).toBe(
      true,
    )
    expect(mailHasAuthoredColors("<style>p { color: #333; }</style><p>x</p>")).toBe(true)
    expect(mailHasAuthoredColors('<table bgcolor="#111111"><tr><td>x</td></tr></table>')).toBe(true)
    expect(mailHasAuthoredColors('<font color="red">x</font>')).toBe(true)
    expect(mailHasAuthoredColors("<p>x</p>", "background-color: #f4f4f4")).toBe(true)
  })

  test("flattenQuotes keeps only the first blockquote level indented", () => {
    const html =
      "<blockquote><p>Level one</p><blockquote><p>Level two</p></blockquote></blockquote>"
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody={html}
        textBody={null}
        senderDomain="example.com"
        flattenQuotes
      />
    ))
    const doc = screen.getByTestId("mail-message-body").getAttribute("srcdoc") ?? ""
    expect(doc).toContain("blockquote blockquote { margin-left: 0 !important;")
    cleanup()
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody={html}
        textBody={null}
        senderDomain="example.com"
      />
    ))
    expect(screen.getByTestId("mail-message-body").getAttribute("srcdoc")).not.toContain(
      "blockquote blockquote",
    )
  })

  test("a plain email follows the app theme", () => {
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody="<p>Plain hello</p>"
        textBody="Plain hello"
        senderDomain="example.com"
      />
    ))
    const frame = screen.getByTestId("mail-message-body")
    expect(frame.getAttribute("data-color-source")).toBe("theme")
    expect(frame.getAttribute("srcdoc")).not.toContain("color-scheme: light")
    expect(frame.className).toContain("bg-transparent")
  })

  test("authored dark text renders on a light sheet", () => {
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody={'<p style="color:#333">Designed hello</p>'}
        textBody="Designed hello"
        senderDomain="example.com"
      />
    ))
    const frame = screen.getByTestId("mail-message-body")
    expect(frame.getAttribute("data-color-source")).toBe("authored")
    const doc = frame.getAttribute("srcdoc") ?? ""
    expect(doc).toContain("color-scheme: light")
    expect(doc).toMatch(/html \{ background: #ffffff/)
    // The app's colour variables stay out, so the base CSS falls back to light.
    expect(doc).not.toContain("--color-text:")
    expect(doc).toContain('style="color:#333"')
  })

  test("a light-on-dark newsletter keeps its own colours", () => {
    const html =
      '<html><body bgcolor="#101820"><table style="background-color:#101820"><tr><td style="color:#f5f5f5">News</td></tr></table></body></html>'
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody={html}
        textBody="News"
        senderDomain="example.com"
      />
    ))
    const frame = screen.getByTestId("mail-message-body")
    expect(frame.getAttribute("data-color-source")).toBe("authored")
    const doc = frame.getAttribute("srcdoc") ?? ""
    expect(doc).toContain("background-color: #101820")
    expect(doc).toContain("color:#f5f5f5")
  })
})

describe("MailMessageRenderer — image banner", () => {
  test("htmlHasImages returns false for HTML without img tags", () => {
    expect(htmlHasImages("<p>No images here</p>")).toBe(false)
    expect(htmlHasImages(null)).toBe(false)
    expect(htmlHasImages("")).toBe(false)
  })

  test("htmlHasImages returns true for HTML with img tags", () => {
    expect(htmlHasImages('<p>Look: <img src="https://example.com/pic.jpg" /></p>')).toBe(true)
    expect(htmlHasImages('<IMG SRC="pic.png">')).toBe(true)
  })

  test("hides banner when HTML has no img tags", () => {
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody="<p>No images here</p>"
        textBody="No images here"
        senderDomain="example.com"
      />
    ))
    expect(screen.queryByTestId("mail-image-banner")).toBeNull()
  })

  test("shows banner when HTML contains img tags and images are blocked", () => {
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody={'<p>Look: <img src="https://example.com/pic.jpg" /></p>'}
        textBody="Look:"
        senderDomain="example.com"
      />
    ))
    expect(screen.getByTestId("mail-image-banner")).toBeDefined()
    expect(screen.getByTestId("mail-message-body").getAttribute("srcdoc")).toContain("[Image]")
  })

  test("load images re-renders the iframe with img tags", async () => {
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody={'<p>Look: <img src="https://example.com/pic.jpg" alt="Picture" /></p>'}
        textBody="Look:"
        senderDomain="example.com"
      />
    ))
    expect(screen.getByTestId("mail-message-body").getAttribute("srcdoc")).toContain("[Picture]")
    await fireEvent.click(screen.getByTestId("mail-load-images"))
    expect(screen.queryByTestId("mail-image-banner")).toBeNull()
    expect(screen.getByTestId("mail-message-body").getAttribute("srcdoc")).toContain("<img")
  })

  test("hides banner when sender images are already allowed", () => {
    rendererMocks.isSenderImageAllowed.mockReturnValue(true)
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody={'<p>Look: <img src="https://example.com/pic.jpg" /></p>'}
        textBody="Look:"
        senderDomain="example.com"
      />
    ))
    expect(screen.queryByTestId("mail-image-banner")).toBeNull()
  })
})

describe("MailMessageRenderer — proxied-image blob URL lifecycle", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  test("superseded render run revokes every blob URL it created instead of orphaning them", async () => {
    rendererMocks.isSenderImageAllowed.mockReturnValue(true)
    rendererMocks.accessToken = () => "test-token"

    let blobCounter = 0
    const createdUrls: string[] = []
    const revokedUrls: string[] = []
    // First fetch (for the FIRST html) resolves only after we manually flush it,
    // so we can rerender with a different htmlBody while it's still in flight.
    // Definite assignment: the Promise executor runs synchronously, so the gate
    // resolver is always set before we use it. `!` keeps TS from narrowing the
    // variable back to its `null` initializer at the call site (control-flow
    // analysis can't see through the executor closure).
    let resolveFirstFetch!: () => void
    const firstFetchGate = new Promise<void>((resolve) => {
      resolveFirstFetch = resolve
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("first.jpg")) {
          await firstFetchGate
        }
        return {
          ok: true,
          blob: async () => new Blob(["x"]),
        } as unknown as Response
      }),
    )
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const u = `blob:mock-${blobCounter++}`
        createdUrls.push(u)
        return u
      }),
      revokeObjectURL: vi.fn((u: string) => {
        revokedUrls.push(u)
      }),
    })

    const [html, setHtml] = createSignal(
      '<p>Look: <img src="https://example.com/api/mail/image-proxy?u=first.jpg" /></p>',
    )
    render(() => (
      <MailMessageRenderer
        accountId="acc-1"
        htmlBody={html()}
        textBody="Look:"
        senderDomain="example.com"
      />
    ))

    // Supersede the in-flight run before its fetch resolves.
    setHtml('<p>Look: <img src="https://example.com/api/mail/image-proxy?u=second.jpg" /></p>')

    await waitFor(() => {
      expect(createdUrls.some((u) => revokedUrls.includes(u))).toBe(false)
      expect(screen.getByTestId("mail-message-body").getAttribute("srcdoc")).toContain("<img")
    })

    // Now let the first (superseded) fetch resolve and create its blob URL.
    resolveFirstFetch?.()
    await waitFor(() => {
      // The superseded run's URL must have been created AND immediately revoked.
      expect(createdUrls.length).toBeGreaterThanOrEqual(2)
      const supersededUrl = createdUrls[createdUrls.length - 1]
      expect(revokedUrls).toContain(supersededUrl)
    })
  })
})

describe("MailMessageRenderer — links on desktop (LIF-6)", () => {
  afterEach(() => {
    cleanup()
    uninstallFakeBridge()
  })

  test("a link in the mail body opens through the shell, not the dead _blank target", async () => {
    const fake = installFakeBridge()
    render(() => (
      <MailMessageRenderer
        accountId="acc"
        htmlBody='<a href="https://example.com/offer">offer</a>'
        textBody={null}
        senderDomain="example.com"
      />
    ))
    const iframe = screen.getByTestId("mail-message-body") as HTMLIFrameElement
    const doc = iframe.contentDocument as Document
    doc.body.innerHTML = '<a href="https://example.com/offer">offer</a>'
    fireEvent.load(iframe)
    const FrameMouseEvent = (iframe.contentWindow as unknown as typeof globalThis).MouseEvent
    const event = new FrameMouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    doc.querySelector("a")?.dispatchEvent(event)
    await waitFor(() =>
      expect(fake.calls.openedExternalUrls).toEqual(["https://example.com/offer"]),
    )
    expect(event.defaultPrevented).toBe(true)
  })
})
