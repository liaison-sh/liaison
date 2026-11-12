// SPDX-License-Identifier: FSL-1.1-ALv2
// The e-invoicing fields of the declarative settings page read through
// `einvoicing_settings_values`, whose answer is exactly what
// `einvoicing_settings_set` takes back (the page hands the set tool the object
// the get tool returned, one path changed), and list the platform choices
// through `einvoicing_provider_options`.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { appSettingsSchema } from "@liaison/app-sdk"
import type { TaxTreatment } from "../tax"
import { einvoicingProviderOptions, einvoicingSettingsValues } from "./transmission-read"

type Ctx = Parameters<typeof einvoicingProviderOptions>[0]

function ctxWith(row: Record<string, unknown> | null, providers: string[] = ["pennylane"]): Ctx {
  return {
    db: { findMany: async () => (row ? [row] : []) },
    contracts: {
      providers: async () => providers,
      call: async () => ({ status: "completed", result: {} }),
    },
  } as unknown as Ctx
}

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8"),
) as {
  tools: Record<string, { params: { properties: Record<string, unknown> } }>
  settings: unknown
}

describe("einvoicing_settings_values", () => {
  it("answers the four page fields, defaults when nothing is stored", async () => {
    expect(await einvoicingSettingsValues(ctxWith(null))).toEqual({
      provider_app: null,
      cutover_date: null,
      send_enabled: false,
      book_enabled: false,
    })
  })

  it("reads the stored settings", async () => {
    const values = await einvoicingSettingsValues(
      ctxWith({
        id: "s1",
        provider_app: "pennylane",
        cutover_date: "2026-11-01",
        send_enabled: true,
        book_enabled: false,
      }),
    )
    expect(values).toEqual({
      provider_app: "pennylane",
      cutover_date: "2026-11-01",
      send_enabled: true,
      book_enabled: false,
    })
  })

  it("answers only parameters einvoicing_settings_set declares", async () => {
    const accepted = Object.keys(manifest.tools.einvoicing_settings_set?.params.properties ?? {})
    for (const key of Object.keys(await einvoicingSettingsValues(ctxWith(null)))) {
      expect(accepted).toContain(key)
    }
  })
})

describe("einvoicing_provider_options", () => {
  it("lists the installed e-invoicing platforms as options", async () => {
    expect(await einvoicingProviderOptions(ctxWith(null, ["pennylane", "other-pa"]))).toEqual({
      options: [
        { value: "pennylane", label: "pennylane" },
        { value: "other-pa", label: "other-pa" },
      ],
    })
  })

  it("lists none when provider contracts are not available", async () => {
    expect(
      await einvoicingProviderOptions({ db: { findMany: async () => [] } } as unknown as Ctx),
    ).toEqual({ options: [] })
  })
})

describe("settings page lists read human values", () => {
  const settings = appSettingsSchema.parse(manifest.settings)
  const columnsOf = (sectionId: string) => {
    const block = settings.sections
      .find((s) => s.id === sectionId)
      ?.blocks.find((b) => b.block === "list")
    if (block?.block !== "list") throw new Error(`no list block in ${sectionId}`)
    return block.columns
  }

  it("tax regimes: the treatment reads as its label, the rate as a percentage", () => {
    const cols = columnsOf("tax-regimes")
    const treatment = cols.find((c) => c.key === "treatment")
    expect(treatment?.format).toBe("enum")
    const treatments: TaxTreatment[] = [
      "eu_domestic",
      "eu_reverse_charge",
      "eu_b2c_oss",
      "eu_export_non_eu",
      "uk_domestic",
      "uk_export_eu",
      "uk_export_non_eu",
      "us_domestic",
      "us_export",
      "ambiguous",
      "unconfigured",
    ]
    expect((treatment?.options ?? []).map((o) => o.value).sort()).toEqual([...treatments].sort())
    for (const o of treatment?.options ?? []) expect(o.labelKey).toBeTruthy()
    expect(cols.find((c) => c.key === "default_rate_bp")?.format).toBe("basisPoints")
  })

  it("HS code library: the last use reads as a time, never a raw timestamp", () => {
    expect(columnsOf("hs-codes").find((c) => c.key === "last_used_at")?.format).toBe("datetime")
  })
})
