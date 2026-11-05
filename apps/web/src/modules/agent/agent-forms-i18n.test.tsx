// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The skill, routine and memory FORMS under a French provider. Their labels,
// placeholders, validation sentences and schedule presets were English
// literals inside the components; they are `kernel.agentForms.*` entries now.
// The key-parity check covers the whole block at once, so a key added on one
// side and forgotten on the other fails here rather than silently falling back
// to English in front of a French reader.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import SchedulePicker from "~/modules/agent/SchedulePicker"
import SkillFormFields from "~/modules/agent/SkillFormFields"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

function renderFr(node: () => unknown) {
  return render(() => <I18nProvider initialLocale="fr">{node() as never}</I18nProvider>)
}

describe("the agent form catalog block is complete in both locales", () => {
  it("en and fr carry exactly the same agentForms keys", () => {
    const enKeys = Object.keys((en as any).agentForms).sort()
    const frKeys = Object.keys((fr as any).agentForms).sort()
    expect(frKeys).toEqual(enKeys)
  })

  it("every entry is a non empty string on both sides", () => {
    for (const [key, value] of Object.entries((en as any).agentForms)) {
      expect({ key, ok: typeof value === "string" && value.length > 0 }).toEqual({ key, ok: true })
    }
    for (const [key, value] of Object.entries((fr as any).agentForms)) {
      expect({ key, ok: typeof value === "string" && value.length > 0 }).toEqual({ key, ok: true })
    }
  })

  it("no dash punctuation reaches a reader, in either locale", () => {
    for (const dict of [(en as any).agentForms, (fr as any).agentForms]) {
      for (const [key, text] of Object.entries(dict as Record<string, string>)) {
        expect({ key, dashes: /--|–|—/.test(text) }).toEqual({ key, dashes: false })
      }
    }
  })

  it("the destination row keeps its {{name}} placeholder in both locales", () => {
    expect((en as any).agentForms.destinationNamedUnavailable).toContain("{{name}}")
    expect((fr as any).agentForms.destinationNamedUnavailable).toContain("{{name}}")
  })
})

describe("the skill form speaks French when the locale is French", () => {
  afterEach(() => cleanup())

  it("labels, the domain hint and the description placeholder are French", () => {
    const [name, setName] = createSignal("")
    const [description, setDescription] = createSignal("")
    const [body, setBody] = createSignal("")
    const [domain, setDomain] = createSignal("")

    renderFr(() => (
      <SkillFormFields
        testidPrefix="skill-new"
        name={name}
        setName={setName}
        description={description}
        setDescription={setDescription}
        body={body}
        setBody={setBody}
        domain={domain}
        setDomain={setDomain}
      />
    ))

    const form = document.body
    expect(form.textContent).toContain("Nom")
    expect(form.textContent).toContain("Contenu (markdown)")
    expect(form.textContent).toContain("Domaine (facultatif)")
    expect(form.textContent).toContain(
      "Achemine l'approbation de cette compétence vers les relecteurs habilités pour ce domaine.",
    )
    expect(screen.getByTestId("skill-new-description").getAttribute("placeholder")).toBe(
      "Que fait cette compétence ?",
    )

    for (const english of ["Body (markdown)", "Domain (optional)"]) {
      expect(form.textContent).not.toContain(english)
    }
  })
})

describe("the schedule picker speaks French when the locale is French", () => {
  afterEach(() => cleanup())

  it("the presets and the weekday chips are French", () => {
    renderFr(() => <SchedulePicker kind="recurring" onChange={() => {}} />)

    expect(screen.getByTestId("schedule-preset-daily").textContent).toBe("Quotidienne")
    expect(screen.getByTestId("schedule-preset-weekdays").textContent).toBe("Jours ouvrés")
    expect(screen.getByTestId("schedule-preset-custom").textContent).toBe("Personnalisée")

    for (const english of ["Daily", "Weekdays", "Weekly", "Monthly", "Custom"]) {
      expect(screen.queryByText(english)).toBeNull()
    }
  })

  it("the one-shot branch explains itself in French", () => {
    renderFr(() => <SchedulePicker kind="scheduled" onChange={() => {}} />)

    expect(document.body.textContent).toContain("Exécuter une fois le")
    expect(document.body.textContent).toContain(
      "L'agent exécute cette consigne une fois, puis la routine est marquée terminée.",
    )
    expect(document.body.textContent).not.toContain("Run once at")
  })
})
