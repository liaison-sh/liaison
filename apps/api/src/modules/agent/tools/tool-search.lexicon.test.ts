// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How the ranker reads the way people actually type a request: wrapped in
// courtesy ("could you please ... when you get a chance"), with a French verb
// conjugated away from its infinitive ("réponds", "ouvre"), or with two letters
// of a short word swapped ("mial"). Pure: a fixture catalog, no server.
import { describe, expect, it } from "bun:test"
import { withoutCourtesy } from "./tool-lexicon"
import { type TextEmbedder, type ToolMeaning, ToolMeaningIndex } from "./tool-meaning"
import { hiddenToolAliases, rankDeferredTools, scoreDeferredTools } from "./tool-rank"

interface Row {
  sdkName: string
  toolName: string
  appName: string
  description: string
  keywords?: string[]
  aliases?: string[]
}

const row = (appName: string, toolName: string, description: string, keywords?: string[]): Row => ({
  sdkName: `${appName}__${toolName}`,
  toolName,
  appName,
  description,
  ...(keywords ? { keywords } : {}),
})

const CATALOG: Row[] = [
  row("shop", "refunds_create", "Give a customer their payment back on an order."),
  row("shop", "orders_get", "Read one order."),
  row("shop", "orders_search", "Find orders by number, customer or date."),
  row("tickets", "close", "Close a ticket once it is handled."),
  row("tickets", "get", "Read one ticket."),
  row("tickets", "reply", "Answer the customer on a ticket."),
  row("billing", "invoice_issue", "Issue a draft invoice."),
  row("billing", "documents_get", "Read one invoice or quote."),
  row("mail", "compose", "Write and send a new email."),
  row("mail", "search", "Find emails."),
  row("projects", "create", "Create a task."),
  row("projects", "move", "Move a task to another project."),
  row("knowledge", "create", "Write a new page."),
  row("knowledge", "open", "Open a page."),
]
const APPS = new Set(CATALOG.map((t) => t.appName))

const ranking = (query: string) => {
  const r = rankDeferredTools(CATALOG, query, { cap: 5, appNames: APPS })
  return { listed: r.ranked.map((s) => s.tool.sdkName), loaded: [...r.strongNames].sort() }
}
const top = (query: string) => ranking(query).listed[0]

describe("courtesy around a request", () => {
  it("a polite wrapper around a request ranks the same tools as the bare request", () => {
    const pairs: Array<[string, string]> = [
      ["could you please refund the order", "refund the order"],
      ["would you mind closing the ticket when you get a chance", "closing the ticket"],
      ["I'd like you to issue the invoice, thanks", "issue the invoice"],
      ["can you reply to the ticket if possible", "reply to the ticket"],
      ["est-ce que tu pourrais rembourser la commande s'il te plaît", "rembourser la commande"],
      ["merci de bien vouloir fermer le ticket", "fermer le ticket"],
      ["pourrais-tu émettre la facture ?", "émettre la facture"],
    ]
    for (const [polite, bare] of pairs) expect(ranking(polite), polite).toEqual(ranking(bare))
  })

  it("keeps a request's own words: only the wrapper goes", () => {
    expect(withoutCourtesy("Could you get the invoice?")).toBe("get the invoice?")
    expect(withoutCourtesy("When you get a chance, get me order 1042")).toBe(", get me order 1042")
    expect(withoutCourtesy("Est-ce que tu pourrais fermer le ticket, s'il te plaît")).toBe(
      "fermer le ticket,",
    )
    // Nothing but courtesy: the query stays whole rather than empty.
    expect(withoutCourtesy("thanks")).toBe("thanks")
  })

  it("the meaning model reads the request without its courtesy wrapper", async () => {
    const queries: string[] = []
    const unit = (i: number) => Array.from({ length: 24 }, (_, k) => (k === i ? 1 : 0))
    const embedder: TextEmbedder = {
      id: "recording",
      async embed(texts, kind) {
        if (kind === "query") queries.push(...texts)
        return texts.map((_, i) => unit(i % 24))
      },
    }
    const many = Array.from({ length: 24 }, (_, i) => row("app", `tool_${i}`, `Tool ${i}.`))
    const index = new ToolMeaningIndex(embedder)
    index.prepare(many)
    await index.ready()
    const meaning: ToolMeaning | null = await index.meaningFor(
      "Could you please refund Élodie when you get a chance?",
      many,
    )
    expect(meaning).not.toBeNull()
    expect(queries).toEqual(["refund Élodie ?"])
  })
})

describe("French verb forms", () => {
  it("a French verb form whose stem is not its infinitive's reads as that verb", () => {
    // "réponds" is "répondre", "ouvre" is "ouvrir": the lexicon holds the infinitive.
    expect(top("réponds au client sur ce ticket")).toBe("tickets__reply")
    expect(top("ouvre la page")).toBe("knowledge__open")
  })
})

describe("short misspellings", () => {
  it("a four-letter word with two neighbouring letters swapped reads as the word it misspells", () => {
    expect(top("mial Sara")).toBe("mail__compose")
    expect(top("mvoe task")).toBe("projects__move")
  })

  it("a four-letter word one letter off another is not read as it", () => {
    // "main" and "mall" are words of their own, not misspellings of "mail".
    for (const q of ["main", "mall"])
      expect(
        scoreDeferredTools(CATALOG, q).filter((s) => s.tool.appName === "mail" && s.score > 0),
        q,
      ).toEqual([])
  })

  it("a four-letter word that is a word itself is not read as the word it would misspell", () => {
    // "lits" is "lit" (a catalog word) plus "s"; "sign" is a lexicon word, not a swap of "sing".
    const catalog: Row[] = [
      ...CATALOG,
      row("lights", "list", "List the lights that are lit right now."),
      row("choir", "sing", "Play a song for the choir."),
    ]
    const strong = (q: string) =>
      [
        ...rankDeferredTools(catalog, q, {
          cap: 5,
          appNames: new Set(catalog.map((t) => t.appName)),
        }).strongNames,
      ].sort()
    expect(strong("lits")).toEqual([])
    expect(
      scoreDeferredTools(catalog, "sign").filter((s) => s.tool.toolName === "sing" && s.score > 0),
    ).toEqual([])
    // A swap that is no word at all still reads as the word it misspells.
    expect(strong("lsit")).toContain("lights__list")
  })
})

describe("French words for a company", () => {
  // Every tool here matches one query word through its keywords; only the
  // timeline is also about a company, and says so in its name alone.
  const catalog: Row[] = [
    row("kernel", "audit_search", "Search the audit log.", ["historique"]),
    row("kernel", "routine_events", "List a routine's runs.", ["historique"]),
    row("billing", "customer_history", "A customer's past documents.", ["historique"]),
    row("billing", "issuer_profile_list", "List issuer profiles.", ["société"]),
    row("billing", "issuer_profile_update", "Change an issuer profile.", ["société"]),
    row("kernel", "company_timeline", "A record's timeline, newest first.", ["historique"]),
  ]
  const apps = new Set(catalog.map((t) => t.appName))
  const first = (query: string) =>
    rankDeferredTools(catalog, query, { cap: 5, appNames: apps }).ranked[0]?.tool.sdkName

  it("société and entreprise read as the company a tool name speaks of", () => {
    expect(first("historique société")).toBe("kernel__company_timeline")
    expect(first("historique entreprise")).toBe("kernel__company_timeline")
    expect(first("historique des sociétés")).toBe("kernel__company_timeline")
  })
})

describe("a read that took over hidden reads", () => {
  // One list read answers several kinds by a parameter; the per-kind reads it
  // replaced are hidden from agents and name it as the tool to use instead.
  const hidden = [
    { appName: "code", toolName: "list_pull_requests", agentVisible: false, useInstead: "list" },
    { appName: "code", toolName: "list_releases", agentVisible: false, useInstead: "list" },
    { appName: "code", toolName: "list_drafts", agentVisible: false, useInstead: "kernel__drafts" },
    { appName: "code", toolName: "get_pull_request", useInstead: "list" },
  ]
  const catalog = (aliases?: string[]): Row[] => [
    {
      ...row("code", "list", "List a repository's items by kind."),
      ...(aliases ? { aliases } : {}),
    },
    row("code", "get_pull_request", "Read one pull request."),
    row("review", "list_merge_requests", "List merge requests."),
    row("review", "list_releases", "List releases."),
  ]
  const first = (rows: Row[], query: string) =>
    rankDeferredTools(rows, query, { cap: 5, appNames: new Set(["code", "review"]) }).ranked[0]
      ?.tool.sdkName

  it("names each visible tool by the hidden tools that send an agent to it", () => {
    const aliases = hiddenToolAliases(hidden)
    expect(aliases.get("code__list")).toEqual(["list_pull_requests", "list_releases"])
    expect(aliases.get("kernel__drafts")).toEqual(["list_drafts"])
    // A visible tool that names another is no alias of it.
    expect([...aliases.keys()].sort()).toEqual(["code__list", "kernel__drafts"])
  })

  it("the list read answers to the names of the reads it replaced", () => {
    const aliases = hiddenToolAliases(hidden).get("code__list")
    expect(first(catalog(), "code pull requests")).toBe("code__get_pull_request")
    expect(first(catalog(aliases), "code pull requests")).toBe("code__list")
    expect(first(catalog(aliases), "list code releases")).toBe("code__list")
  })

  it("another app's tool named by the query still leads its app's words", () => {
    const aliases = hiddenToolAliases(hidden).get("code__list")
    expect(first(catalog(aliases), "review releases")).toBe("review__list_releases")
  })
})
