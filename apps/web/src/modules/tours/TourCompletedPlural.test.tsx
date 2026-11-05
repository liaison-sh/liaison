// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The completion card counts skipped steps with the language's plural forms:
// "1 passée" / "2 passées" in French, "1 skipped" in English.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { TourCompleted } from "./TourPanel"

const tour = defineTour({
  id: "kernel.demo",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "a",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
    },
  ],
})

function completed(skipped: number): TourProgress {
  const beatStates: TourProgress["beatStates"] = {}
  for (let i = 0; i < skipped; i++) beatStates[`b${i}`] = "skipped"
  return {
    tourId: tour.id,
    status: "completed",
    beatId: null,
    beatIndex: 1,
    beatCount: 3,
    beatStates,
    source: "help",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
  }
}

afterEach(cleanup)

describe("completion card plurals", () => {
  for (const [locale, n, text] of [
    ["fr", 1, "1 passée"],
    ["fr", 2, "2 passées"],
    ["en", 1, "1 skipped"],
    ["en", 3, "3 skipped"],
  ] as const) {
    it(`${locale}: ${n} skipped reads "${text}"`, () => {
      render(() => (
        <I18nProvider initialLocale={locale}>
          <TourCompleted tour={tour} progress={completed(n)} phone={false} />
        </I18nProvider>
      ))
      expect(screen.getByTestId("tour-completed-skipped").textContent).toBe(text)
    })
  }
})
