// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Fictional web pages the services world's agents can fetch, answered in
// process before any network (`world/web-fetch-fixture.ts` consults this map):
// the guide the chat scenario's question points to, and the prospect's site in
// the sales scenario. Hosts are reserved `.example` names the demo invented,
// and every page says so.

const PAGE = (site: string, title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><header><h1>${site}</h1><p>A fictional site, made for this demo.</p></header>` +
  `<main>${body}</main></body></html>`

/** The chat scenario's source. */
export const STUDIO_DATA_CONTRACTS_HOST = "data-contracts-guide.example"
export const STUDIO_DATA_CONTRACTS_URL = `https://${STUDIO_DATA_CONTRACTS_HOST}/warehouse-suppliers`

/** The sales scenario's prospect. */
const STUDIO_PROSPECT_SITE_HOST = "corail-paysages.example"

const GUIDE_SITE = "Data Contracts Guide (fictional)"
const PROSPECT_SITE = "Corail Paysages"

/** Fixed pages by host, then path. */
export const STUDIO_FIXTURE_PAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [STUDIO_DATA_CONTRACTS_HOST]: {
    "/warehouse-suppliers": PAGE(
      GUIDE_SITE,
      "Data contracts between a warehouse and its suppliers",
      "<h2>What a data contract holds</h2>" +
        "<ul><li>The fields each file carries, their types and their units.</li>" +
        "<li>When the file arrives, and what happens when it is late.</li>" +
        "<li>Who owns each field, and who is told when it changes.</li>" +
        "<li>The checks a file must pass before anyone uses it.</li></ul>" +
        "<h2>What goes wrong without one</h2>" +
        "<p>A supplier renames a column and the stock feed fills with blanks; nobody notices " +
        "until orders go out short. A written contract and an automatic check on each file " +
        "catch it the same night.</p>",
    ),
    "/": PAGE(GUIDE_SITE, "Data Contracts Guide", "<p>Short guides on sharing data.</p>"),
  },
  [STUDIO_PROSPECT_SITE_HOST]: {
    "/": PAGE(
      PROSPECT_SITE,
      PROSPECT_SITE,
      "<h2>Landscape architects in Lyon</h2>" +
        "<p>Corail Paysages designs gardens, parks and courtyards for towns, housing " +
        "associations and private clients: about forty projects a year, 14 people.</p>" +
        "<h2>News</h2><p>This winter: a new studio for public parks, and a client extranet " +
        "planned before the spring season.</p>",
    ),
    "/about": PAGE(
      PROSPECT_SITE,
      "About Corail Paysages",
      "<p>Founded in 2011. Margaux Roussel runs the studio's projects and its clients.</p>",
    ),
  },
}
