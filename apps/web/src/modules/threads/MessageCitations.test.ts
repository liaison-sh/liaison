// SPDX-License-Identifier: FSL-1.1-ALv2
// The sources an agent's answer cites, whatever way it writes them: a markdown
// link, a full https link, or a bare address with a path
// (`eur-lex.europa.eu/eli/reg/2023/1542/oj/eng`), which models often write in
// a "Sources:" list. Without the bare form, an answer whose sources are all
// bare addresses listed none, and a step waiting on them waited for good.
import { describe, expect, it } from "vitest"
import { citationsOf } from "./MessageCitations"

describe("citationsOf", () => {
  it("lists markdown and full links by host", () => {
    expect(
      citationsOf("See [the FAQ](https://www.example.org/faq) and https://eur-lex.europa.eu/x."),
    ).toEqual([
      { url: "https://www.example.org/faq", host: "example.org" },
      { url: "https://eur-lex.europa.eu/x", host: "eur-lex.europa.eu" },
    ])
  })

  it("lists a bare address with a path as an https source", () => {
    const answer = [
      "**Sources (web-sourced, unverified):**",
      "- Commission DPP FAQ for batteries: single-market-economy.ec.europa.eu/single-market/digital-product-passport/eu-digital-product-passport-faq-batteries_en",
      "- Regulation (EU) 2023/1542: eur-lex.europa.eu/eli/reg/2023/1542/oj/eng",
    ].join("\n")
    expect(citationsOf(answer)).toEqual([
      {
        url: "https://single-market-economy.ec.europa.eu/single-market/digital-product-passport/eu-digital-product-passport-faq-batteries_en",
        host: "single-market-economy.ec.europa.eu",
      },
      { url: "https://eur-lex.europa.eu/eli/reg/2023/1542/oj/eng", host: "eur-lex.europa.eu" },
    ])
  })

  it("lists a bare www address, without its trailing punctuation", () => {
    expect(citationsOf("Read www.example.com, then reply.")).toEqual([
      { url: "https://www.example.com/", host: "example.com" },
    ])
  })

  it("does not take file names, versions, abbreviations or emails for sources", () => {
    expect(
      citationsOf(
        "Edit seed-demo.ts and Node.js 22.1, e.g. config.yaml; write to ops@example.com or a/b.c",
      ),
    ).toEqual([])
  })

  it("does not list the host of a full link twice", () => {
    expect(citationsOf("https://example.org/a/b example.org/a/b")).toEqual([
      { url: "https://example.org/a/b", host: "example.org" },
    ])
  })
})
