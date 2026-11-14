// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The in-app copy of the user docs that the Help tab reads (written by
 * scripts/docs/build-app-bundle.ts into the web app's `/help-docs/`).
 *
 *   /help-docs/index.json             HelpDocsIndex: the nav and the search entries
 *   /help-docs/pages/<url>.json       HelpDocsPage, one per nav page (`index.json` for the landing)
 *   /help-docs/assets/*               the pages' images
 *
 * In a page's HTML a link to another page is `/help/<url>[#fragment]`, an image
 * `/help-docs/assets/...`, a same-page anchor `#id`; anything else is an outside link.
 */

/** URL path prefix of the Help tab, and of every page link in the bundle. */
export const HELP_ROUTE = "/help"
/** URL path prefix of the bundle's files. */
export const HELP_DOCS_BASE = "/help-docs/"
/** The published docs site, for "Open in browser". Same page URLs under it. */
export const HELP_DOCS_SITE = "https://liaison.sh/docs/"

export interface HelpDocsHeading {
  depth: number
  text: string
  id: string
}

export interface HelpDocsNavSection {
  title: string
  pages: { url: string; title: string }[]
}

export interface HelpDocsEntry {
  url: string
  title: string
  section: string
  description: string
  headings: HelpDocsHeading[]
  /** The page's whole text, for search. */
  text: string
}

export interface HelpDocsIndex {
  landing: { url: string; title: string }
  sections: HelpDocsNavSection[]
  entries: HelpDocsEntry[]
}

export interface HelpDocsPage {
  url: string
  title: string
  description: string
  /** Shown under the title when the page wrote its own (not a first-paragraph fallback). */
  showLede: boolean
  section: string
  html: string
  headings: HelpDocsHeading[]
}

/** The bundle file of the page at `url` ("" is the landing page). */
export function helpDocsPageFile(url: string): string {
  return `${HELP_DOCS_BASE}pages/${url === "" ? "index" : url}.json`
}
