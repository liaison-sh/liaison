// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A new agreement, in a tab: its kind, its title, the client company it is for, a template to
// start from (or none), and its language. The company stamps it, so it reaches that client's
// portal and its signers count as that company's. The draft opens in the editor; no price is set here, a person sets it there.
import { Button } from "@liaison/app-ui/kit"
import { type Component, createResource, createSignal, For } from "solid-js"
import { call, go, loadCompanyNames, paths } from "./host"
import { tr } from "./i18n"
import { KIND_GROUPS } from "./model"
import { SigningOff } from "./signing"

const INPUT =
  "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-text outline-none focus:border-accent-border"

interface TemplateRow {
  template_id: string
  name: string
  kind: string
  language?: string | null
}

export const AgreementNew: Component = () => {
  const [kind, setKind] = createSignal("sow")
  const [title, setTitle] = createSignal("")
  const [templateId, setTemplateId] = createSignal("")
  const [companyId, setCompanyId] = createSignal("")
  const [companies] = createResource(async () =>
    [...(await loadCompanyNames()).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )
  const [language, setLanguage] = createSignal<"en" | "fr">("en")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [templates] = createResource(async () => {
    const out = await call<{ items?: TemplateRow[] }>("templates_list", {})
    return out.ok ? (out.data.items ?? []) : []
  })
  const forKind = () => (templates() ?? []).filter((t) => t.kind === kind())

  const create = async () => {
    if (title().trim() === "") return
    setBusy(true)
    setError(null)
    const out = await call<{ agreement?: { id?: string } }>("agreement_create", {
      kind: kind(),
      title: title().trim(),
      language: language(),
      ...(companyId() ? { company_id: companyId() } : {}),
      ...(templateId() ? { template_id: templateId() } : {}),
    })
    setBusy(false)
    const newId = out.ok ? out.data.agreement?.id : undefined
    if (!newId) return setError((!out.ok && out.message) || tr("The draft could not be created."))
    go(paths.editor(newId))
  }

  return (
    <div data-testid="agreement-new" class="flex h-full min-h-0 flex-col bg-bg">
      <header class="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3">
        <h1 class="text-[14px] font-semibold text-text">{tr("New agreement")}</h1>
        <Button
          variant="primary"
          testid="agreement-new-create"
          disabled={busy() || title().trim() === ""}
          onClick={() => void create()}
        >
          {tr("Create the draft")}
        </Button>
      </header>
      <SigningOff />
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 pb-dock-runway">
        <div class="flex max-w-lg flex-col gap-4">
          <p class="text-[12.5px] text-text-secondary">
            {tr("Or give the agent a brief: it drafts the text here, and you read it.")}
          </p>
          <label class="flex flex-col gap-1">
            <span class="text-[12px] font-medium text-text">{tr("Kind")}</span>
            <select
              class={INPUT}
              data-testid="agreement-new-kind"
              value={kind()}
              onChange={(e) => {
                setKind(e.currentTarget.value)
                setTemplateId("")
              }}
            >
              <For each={KIND_GROUPS}>{(g) => <option value={g.slug}>{tr(g.label)}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[12px] font-medium text-text">{tr("Title")}</span>
            <input
              class={INPUT}
              data-testid="agreement-new-title"
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[12px] font-medium text-text">{tr("Client company")}</span>
            <select
              class={INPUT}
              data-testid="agreement-new-company"
              value={companyId()}
              onChange={(e) => setCompanyId(e.currentTarget.value)}
            >
              <option value="">{tr("No company")}</option>
              <For each={companies() ?? []}>{(c) => <option value={c.id}>{c.name}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[12px] font-medium text-text">{tr("Start from")}</span>
            <select
              class={INPUT}
              data-testid="agreement-new-template"
              value={templateId()}
              onChange={(e) => setTemplateId(e.currentTarget.value)}
            >
              <option value="">{tr("A blank document")}</option>
              <For each={forKind()}>{(t) => <option value={t.template_id}>{t.name}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[12px] font-medium text-text">{tr("Language")}</span>
            <select
              class={INPUT}
              data-testid="agreement-new-language"
              value={language()}
              onChange={(e) => setLanguage(e.currentTarget.value === "fr" ? "fr" : "en")}
            >
              <option value="en">{tr("English")}</option>
              <option value="fr">{tr("French")}</option>
            </select>
          </label>
          <p data-testid="agreement-new-error" role="alert" class="text-[12.5px] text-error">
            {error() ?? ""}
          </p>
        </div>
      </div>
    </div>
  )
}
