// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The docs page layout (two columns: sidebar + page). Pure string templating;
 * styles live in `docs/_theme/docs.css`, behaviour in `docs/_theme/docs.js`.
 * Every page works without JavaScript; the search box and the phone menu
 * button only appear once the script has run.
 */

export interface TemplateLink {
  title: string
  href: string
}

export interface TemplatePage {
  id: string
  title: string
  description: string
  /** Show the description under the title (only when the page wrote its own). */
  showLede: boolean
  canonical: string
  /** Relative path from this page to the docs root, ending in `/`. */
  root: string
  isLanding: boolean
  section?: { title: string; href: string; abs: string }
  bodyHtml: string
  toc: { depth: number; text: string; id: string }[]
  screenshot?: { src: string; alt: string; abs: string }
  prev?: TemplateLink
  next?: TemplateLink
  editUrl: string
  sidebar: { title: string; pages: { id: string; url: string; title: string }[] }[]
  stub: boolean
}

/** App pages that carry an app colour square (hues in docs.css, `.app-<key>`). */
const APP_HUE_KEYS: Record<string, string> = {
  "apps/mail": "mail",
  "apps/tickets": "tickets",
  "apps/knowledge": "knowledge",
  "apps/invoicing": "invoicing",
  "apps/boxtal": "shipping",
  "apps/store": "store",
  "apps/pennylane": "accounting",
  "apps/projects": "projects",
  "apps/calendar": "calendar",
  "apps/contacts": "contacts",
  "apps/agents": "agents",
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;")
}

function jsonLd(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`
}

const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7"/><path d="M10 8 V20 H22" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="22" cy="20" r="2.5"/></svg>`

function searchBox(extraClass: string): string {
  return `<div class="search ${extraClass}" data-search hidden><input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false"><kbd>/</kbd><ul class="results" role="listbox" hidden></ul></div>`
}

function sidebar(p: TemplatePage): string {
  const sections = p.sidebar.map((s) => {
    const items = s.pages.map((page) => {
      const href = page.url ? `${p.root}${page.url}/` : p.root
      const current = page.id === p.id ? ' class="on" aria-current="page"' : ""
      const hue = APP_HUE_KEYS[page.id]
      const square = page.id.startsWith("apps/")
        ? `<i class="sq${hue ? ` app-${hue}` : ""}" aria-hidden="true"></i>`
        : ""
      return `<li><a href="${escapeAttr(href)}"${current}>${square}${escapeHtml(page.title)}</a></li>`
    })
    return `<h4>${escapeHtml(s.title)}</h4><ul>${items.join("")}</ul>`
  })
  return `<aside class="side" id="side">${searchBox("side-search")}<nav aria-label="Docs">${sections.join("")}</nav></aside>`
}

function structuredData(p: TemplatePage): string {
  const crumbs: { name: string; item: string }[] = [
    { name: "Docs", item: "https://liaison.sh/docs/" },
  ]
  if (p.section) crumbs.push({ name: p.section.title, item: p.section.abs })
  if (!p.isLanding) crumbs.push({ name: p.title, item: p.canonical })
  const article: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: p.title,
    description: p.description,
    url: p.canonical,
    inLanguage: "en",
    isPartOf: { "@type": "WebSite", name: "Liaison", url: "https://liaison.sh/" },
    publisher: { "@type": "Organization", name: "Liaison", url: "https://liaison.sh/" },
  }
  if (p.screenshot) article.image = p.screenshot.abs
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: c.item,
    })),
  }
  return `${jsonLd(article)}\n${jsonLd(breadcrumbs)}`
}

export function renderLayout(p: TemplatePage): string {
  const fullTitle = p.isLanding ? "Liaison docs" : `${p.title} · Liaison docs`
  const og = [
    ["og:type", "article"],
    ["og:site_name", "Liaison"],
    ["og:title", p.title],
    ["og:description", p.description],
    ["og:url", p.canonical],
    ...(p.screenshot ? [["og:image", p.screenshot.abs]] : []),
  ]
    .map(([k, v]) => `<meta property="${k}" content="${escapeAttr(v ?? "")}">`)
    .join("\n")

  const crumbs = p.isLanding
    ? ""
    : `<nav class="crumbs" aria-label="Breadcrumb"><a href="${escapeAttr(p.root)}">Docs</a><span aria-hidden="true">›</span>${
        p.section
          ? `<a href="${escapeAttr(p.section.href)}">${escapeHtml(p.section.title)}</a><span aria-hidden="true">›</span>`
          : ""
      }<span aria-current="page">${escapeHtml(p.title)}</span></nav>`

  const toc =
    !p.isLanding && p.toc.length >= 2
      ? `<details class="toc-inline"><summary>On this page</summary><ol>${p.toc
          .map(
            (h) =>
              `<li class="toc-h${h.depth}"><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`,
          )
          .join("")}</ol></details>`
      : ""

  const shot = p.screenshot
    ? `<figure class="shot"><img src="${escapeAttr(p.screenshot.src)}" alt="${escapeAttr(p.screenshot.alt)}" loading="lazy" decoding="async"></figure>`
    : ""

  const pager =
    p.prev || p.next
      ? `<nav class="next" aria-label="Previous and next">${
          p.prev
            ? `<a rel="prev" href="${escapeAttr(p.prev.href)}"><small>Previous</small>${escapeHtml(p.prev.title)}</a>`
            : ""
        }${
          p.next
            ? `<a rel="next" href="${escapeAttr(p.next.href)}"><small>Next</small>${escapeHtml(p.next.title)}</a>`
            : ""
        }</nav>`
      : ""

  const lede =
    p.isLanding || p.stub || !p.showLede ? "" : `<p class="lede">${escapeHtml(p.description)}</p>`

  return `<!doctype html>
<html lang="en" data-root="${escapeAttr(p.root)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeAttr(p.description)}">
<link rel="canonical" href="${escapeAttr(p.canonical)}">
${og}
<meta name="twitter:card" content="${p.screenshot ? "summary_large_image" : "summary"}">
${p.stub ? '<meta name="robots" content="noindex">\n' : ""}<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${escapeAttr(p.root)}docs.css">
<script>document.documentElement.classList.add("js")</script>
<script src="${escapeAttr(p.root)}docs.js" defer></script>
${structuredData(p)}
</head>
<body${p.isLanding ? ' class="landing"' : ""}>
<a class="skip" href="#main">Skip to content</a>
<header class="hd">
<a class="brand" href="/">${MARK}Liaison</a><a class="brand-docs" href="${escapeAttr(p.root)}">Docs</a>
${searchBox("hd-search")}
<nav class="hd-links" aria-label="Site"><a href="https://demo.liaison.sh" rel="noopener">Demo</a><a href="/customers/">Customers</a><a href="https://github.com/liaison-sh/liaison" rel="noopener">GitHub</a></nav>
<button class="menu-btn" type="button" aria-controls="side" aria-expanded="false">Menu</button>
<a class="btn" href="https://demo.liaison.sh" rel="noopener">Try the demo</a>
</header>
<div class="body">
${sidebar(p)}
<main class="main" id="main">
${crumbs}
<article class="page">
<h1>${escapeHtml(p.title)}</h1>
${lede}
${shot}
${toc}
${p.bodyHtml}
</article>
${pager}
<div class="edit"><a href="${escapeAttr(p.editUrl)}" rel="noopener">Edit this page on GitHub</a></div>
</main>
</div>
</body>
</html>
`
}
