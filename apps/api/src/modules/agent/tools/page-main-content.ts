// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A FETCHED PAGE'S MAIN CONTENT, without its chrome.
//
// web_fetch turned the whole page into text: the site navigation, the menus,
// the language picker, the footer and the cookie banner came first, and a page
// was observed coming back as nothing but its language menu (the extract mode
// cut it to the head of the page, which was all chrome). Here the page's chrome
// is removed before the conversion: navigation landmarks, the page-level
// header, footer and sidebars (those inside the page's <main> or an <article>
// are content and stay), cookie and consent banners, language pickers, form
// selects, and the non-text elements (scripts, styles, inline images).
//
// No data loss: when what is left is so short that the main content may have
// been inside what was removed (a site that wraps its body in a <header>, a
// page that is nothing but a menu), the full page is used instead.

/** Elements removed wherever they are: never the main content. */
const ALWAYS_REMOVED = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "select",
  "nav",
  '[role="navigation" i]',
  '[role="search" i]',
  '[role="contentinfo" i]',
  "a[hreflang]",
  '[id*="cookie-banner" i]',
  '[class*="cookie-banner" i]',
  '[id*="cookie-consent" i]',
  '[class*="cookie-consent" i]',
  '[id*="cookie-notice" i]',
  '[class*="cookie-notice" i]',
  '[id*="cookiebanner" i]',
  '[class*="cookiebanner" i]',
  '[id*="consent-banner" i]',
  '[class*="consent-banner" i]',
  '[id^="onetrust" i]',
  '[class*="language-switch" i]',
  '[id*="language-switch" i]',
  '[class*="lang-switch" i]',
  '[class*="language-select" i]',
  '[id*="language-select" i]',
  '[class*="language-picker" i]',
  '[class*="language-menu" i]',
  '[class*="skip-link" i]',
].join(", ")

/** Page-level chrome: removed outside <main> and <article>, kept inside them. */
const CHROME_OUTSIDE_CONTENT = 'header, footer, aside, [role="banner" i], [role="complementary" i]'

/** Below this many characters of text left, stripping may have taken the content. */
export const MAIN_CONTENT_MIN_CHARS = 200

/** The visible text length of an HTML string, roughly: tags and whitespace runs collapsed. */
export function visibleTextLength(html: string): number {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, "x")
    .replace(/\s+/g, " ")
    .trim().length
}

/** `html` without its chrome (see the header). Exported for tests. */
export function stripPageChrome(html: string): string {
  let contentDepth = 0
  const rewriter = new HTMLRewriter()
    .on(ALWAYS_REMOVED, {
      element(el) {
        el.remove()
      },
    })
    .on("main, article, [role='main' i]", {
      element(el) {
        if (el.selfClosing) return
        contentDepth++
        try {
          el.onEndTag(() => {
            contentDepth--
          })
        } catch {
          // An element without an end tag (malformed page): counted as closed.
          contentDepth--
        }
      },
    })
    .on(CHROME_OUTSIDE_CONTENT, {
      element(el) {
        if (contentDepth === 0) el.remove()
      },
    })
  return rewriter.transform(html)
}

/**
 * The page to convert: `html` without its chrome, or `html` itself when the
 * stripped page keeps under MAIN_CONTENT_MIN_CHARS of text and under half of
 * the full page's text, or when stripping fails.
 */
export function pageMainContent(html: string): string {
  let stripped: string
  try {
    stripped = stripPageChrome(html)
  } catch {
    return html
  }
  const kept = visibleTextLength(stripped)
  if (kept >= MAIN_CONTENT_MIN_CHARS) return stripped
  return kept * 2 >= visibleTextLength(html) ? stripped : html
}
