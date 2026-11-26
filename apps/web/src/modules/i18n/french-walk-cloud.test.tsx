// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A French walk of the Cloud surfaces (2026-11-26) still read English on Home's
// approvals (a contact merge's lines, a skill rewrite, a Shopify discount), in
// the app store and routine template rows, on the search filter chips, and
// "Agent de Amina" where French elides. These pin the French.

import { render } from "@solidjs/testing-library"
import { describe, expect, test } from "vitest"
import { entityTypeChipLabel } from "~/lib/app-label"
import { templateDescription, templateTitle } from "~/modules/agent/RoutinesList"
import { approvalActionLabel, localizeApprovalText } from "~/modules/approvals/approval-copy"
import { storeItemSummary } from "~/modules/settings/app-store/AppStorePage"
import type { StoreItem } from "~/modules/settings/app-store/store-model"
import { fillTemplate, I18nProvider, translatorFor } from "./i18n-context"

const fr = translatorFor("fr")
const en = translatorFor("en")
const frCtx = { t: fr, locale: "fr" }
const enCtx = { t: en, locale: "en" }

describe("approval words", () => {
  test("a Shopify action badge reads in French", () => {
    expect(approvalActionLabel("shopify:discounts_create", "Shopify: create discount", frCtx)).toBe(
      "Shopify : créer une remise",
    )
    expect(approvalActionLabel("shopify:discounts_create", "Shopify: create discount", enCtx)).toBe(
      "Shopify: create discount",
    )
  })

  test("a contact merge's lines read in French", () => {
    expect(localizeApprovalText("Survivor (kept): Helena Ritter <h@x.example>", frCtx)).toBe(
      "Conservé : Helena Ritter <h@x.example>",
    )
    expect(localizeApprovalText("Deleted (merged away): H. Ritter", frCtx)).toBe(
      "Supprimé (fusionné) : H. Ritter",
    )
    expect(
      localizeApprovalText(
        "This is IRREVERSIBLE: the deleted record is permanently removed and all of its mail conversations are reassigned to the survivor.",
        frCtx,
      ),
    ).toMatch(/^C'est IRRÉVERSIBLE/)
  })

  test("a skill rewrite's title and lines read in French", () => {
    expect(localizeApprovalText("Update skill: shipment-exception", frCtx)).toBe(
      "Modifier la compétence : shipment-exception",
    )
    expect(localizeApprovalText("Skill created: 2026-11-26", frCtx)).toBe(
      "Compétence créée le 2026-11-26",
    )
    expect(localizeApprovalText("body (2925 chars)", frCtx)).toBe("contenu (2925 caractères)")
    expect(localizeApprovalText("Domain: general (none set)", frCtx)).toBe(
      "Domaine : général (aucun)",
    )
  })

  test("a discount's lines read in French", () => {
    expect(localizeApprovalText("Create discount code: EDU15", frCtx)).toBe(
      "Créer le code de remise : EDU15",
    )
    expect(localizeApprovalText("Discount: 15% off", frCtx)).toBe("Remise : 15 %")
    expect(localizeApprovalText("Combines with: no other discounts", frCtx)).toBe(
      "Cumulable avec : aucune autre remise",
    )
  })
})

/** Stored copy follows the mounted provider's locale, as it does on screen. */
function inFrench(): void {
  render(() => (
    <I18nProvider initialLocale="fr">
      <span />
    </I18nProvider>
  ))
}

describe("app store and routine templates", () => {
  const shopify = {
    name: "shopify",
    listing: { summary: "Shopify orders, customers, products, refunds, fulfilments and returns." },
  } as unknown as StoreItem

  test("a listing summary reads in French while it says the catalog's English", () => {
    inFrench()
    expect(storeItemSummary(shopify, fr)).toBe(
      "Commandes, clients, produits, remboursements, expéditions et retours Shopify.",
    )
  })

  test("a listing summary the catalog does not know stays as written", () => {
    const own = { name: "acme", listing: { summary: "Our own app." } } as unknown as StoreItem
    expect(storeItemSummary(own, fr)).toBe("Our own app.")
  })

  test("a routine template reads its title and description in French", () => {
    inFrench()
    const tpl = {
      appName: "invoicing",
      templateKey: "month-end-check",
      description:
        "When a month-end run is drafted, say what other records show about its customers.",
    }
    expect(templateTitle(fr, tpl)).toBe("Contrôle de fin de mois")
    expect(templateDescription(fr, tpl)).toMatch(/^Quand une facturation de fin de mois/)
  })

  test("an unknown template's key reads in words, never as a slug", () => {
    expect(templateTitle(fr, { appName: "acme", templateKey: "weekly-sync" })).toBe("Weekly sync")
  })
})

describe("search filter chips", () => {
  test("a result type reads as a capitalised plural", () => {
    expect(entityTypeChipLabel("task", fr)).toBe("Tâches")
    expect(entityTypeChipLabel("document", en)).toBe("Documents")
    expect(entityTypeChipLabel("finding", fr)).toBe("Mentions sociales")
    expect(entityTypeChipLabel("widget_part", en)).toBe("Widget part")
  })
})

describe("French elision", () => {
  test("de and que elide before a vowel or an h", () => {
    expect(fr("kernel.agents.ownersAgent", { name: "Amina" })).toBe("Agent d'Amina")
    expect(fr("kernel.agents.ownersAgent", { name: "Hélène" })).toBe("Agent d'Hélène")
    expect(fr("kernel.agents.ownersAgent", { name: "Lucas" })).toBe("Agent de Lucas")
  })

  test("English and other words are untouched", () => {
    expect(en("kernel.agents.ownersAgent", { name: "Amina" })).toBe("Amina's agent")
    expect(fillTemplate("fr", "Mode {{x}}", { x: "avion" })).toBe("Mode avion")
  })
})
