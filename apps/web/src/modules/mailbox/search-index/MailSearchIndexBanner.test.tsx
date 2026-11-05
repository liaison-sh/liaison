// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The visible half of T-WEB-5. The rule the spec states and this file pins:
// degradation is never silent. Every state in which the index cannot answer a
// question in full has a sentence, and none of those sentences is "no matches".

import { render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it } from "vitest"
import { MailSearchIndexBanner } from "~/modules/mailbox/search-index/MailSearchIndexBanner"
import {
  reportIndexBuildProgress,
  reportIndexDegraded,
  reportIndexLocked,
  reportIndexReady,
  reportIndexRebuilding,
  resetSearchIndexStore,
  searchIndexBanner,
  searchIndexStore,
} from "~/modules/mailbox/search-index/search-index-store"

const DASH_PUNCTUATION = ["—", "–", "--"]

describe("MailSearchIndexBanner", () => {
  beforeEach(() => {
    resetSearchIndexStore()
  })

  it("says nothing when the index is complete", () => {
    reportIndexReady()
    expect(searchIndexBanner()).toBeNull()
    render(() => <MailSearchIndexBanner />)
    expect(screen.queryByTestId("mail-search-index-banner")).toBeNull()
  })

  it("shows progress while the first build runs", () => {
    reportIndexBuildProgress({ indexed: 400, total: 1000, phase: "building" })
    render(() => <MailSearchIndexBanner />)
    const banner = screen.getByTestId("mail-search-index-banner")
    expect(banner.getAttribute("data-status")).toBe("building")
    expect(banner.textContent).toContain("400")
    expect(banner.textContent).toContain("1000")
  })

  it("says it is rebuilding rather than reporting no matches", () => {
    reportIndexRebuilding()
    render(() => <MailSearchIndexBanner />)
    const banner = screen.getByTestId("mail-search-index-banner")
    expect(banner.getAttribute("data-status")).toBe("rebuilding")
    expect(banner.textContent?.toLowerCase()).toContain("rebuilding")
    expect(banner.textContent?.toLowerCase()).not.toContain("no matches")
  })

  it("names the metadata-only degradation and what still works", () => {
    reportIndexDegraded({ mode: "metadata-only", reason: "quota" })
    render(() => <MailSearchIndexBanner />)
    const banner = screen.getByTestId("mail-search-index-banner")
    expect(banner.getAttribute("data-status")).toBe("metadata-only")
    expect(searchIndexStore.mode).toBe("metadata-only")
    const text = banner.textContent ?? ""
    for (const still of ["senders", "dates", "labels", "attachment"]) {
      expect(text.toLowerCase()).toContain(still)
    }
  })

  it("names the reduced window when only part of the mailbox fits", () => {
    reportIndexDegraded({ mode: "reduced-window", reason: "quota", windowMonths: 12 })
    render(() => <MailSearchIndexBanner />)
    const banner = screen.getByTestId("mail-search-index-banner")
    expect(banner.getAttribute("data-status")).toBe("reduced-window")
    expect(banner.textContent).toContain("12 months")
  })

  it("asks for an unlock rather than answering an empty search", () => {
    reportIndexLocked()
    render(() => <MailSearchIndexBanner />)
    const banner = screen.getByTestId("mail-search-index-banner")
    expect(banner.getAttribute("data-status")).toBe("locked")
    expect(banner.textContent?.toLowerCase()).toContain("unlock")
  })

  it("uses no dash punctuation in any state", () => {
    const states: (() => void)[] = [
      () => reportIndexBuildProgress({ indexed: 1, total: 2, phase: "building" }),
      () => reportIndexRebuilding(),
      () => reportIndexDegraded({ mode: "metadata-only", reason: "quota" }),
      () => reportIndexDegraded({ mode: "reduced-window", reason: "quota", windowMonths: 12 }),
      () => reportIndexLocked(),
    ]
    for (const apply of states) {
      resetSearchIndexStore()
      apply()
      const banner = searchIndexBanner()
      expect(banner).not.toBeNull()
      for (const dash of DASH_PUNCTUATION) expect(banner?.text ?? "").not.toContain(dash)
    }
  })

  it("reports whether search may claim to be complete", () => {
    reportIndexReady()
    expect(searchIndexStore.complete).toBe(true)
    reportIndexBuildProgress({ indexed: 1, total: 10, phase: "building" })
    expect(searchIndexStore.complete).toBe(false)
    reportIndexDegraded({ mode: "metadata-only", reason: "quota" })
    expect(searchIndexStore.complete).toBe(false)
  })
})
