// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Workspace > Documents: the organisation's document templates.
// A list, an inline "New template" form (a rich text template, or a PDF form
// uploaded and checked by the server), and a hint that an agent can design a
// template from an example (agents do most of the authoring; this page is for
// reviewing and light editing). One template's page is
// /settings/admin/documents/<id> (DocumentTemplateDetail).

import { useNavigate } from "@solidjs/router"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import {
  createPdfFormTemplate,
  createRichTextTemplate,
  type InlineError,
  inlineError,
  listRecordTypes,
  listTemplates,
  type TemplateKind,
} from "./documents-api"

export const DOCUMENTS_ADMIN_SCOPE = "kernel:org:admin"
export const DOCUMENTS_HREF = "/settings/admin/documents"

const INPUT =
  "w-full rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text focus-visible:outline-2 focus-visible:outline-accent"

/** The hint's suggested prompt; the person pastes it in a chat with their agent. */
export function agentPromptText(t: (key: string) => string): string {
  return t("kernel.documentsUi.agentPrompt")
}

export const AgentHint: Component = () => {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(agentPromptText(i18n.t))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div
      class="mb-4 rounded-md border border-border-subtle bg-surface/40 px-3 py-2 text-[12.5px]"
      data-testid="documents-agent-hint"
    >
      <p class="font-medium text-text">{i18n.t("kernel.documentsUi.agentHintTitle")}</p>
      <p class="mt-0.5 text-text-secondary">{i18n.t("kernel.documentsUi.agentHintBody")}</p>
      <p class="mt-1.5 italic text-text-secondary" data-testid="documents-agent-hint-prompt">
        “{agentPromptText(i18n.t)}”
      </p>
      <button
        type="button"
        class="mt-1 text-accent underline-offset-2 hover:underline"
        data-testid="documents-agent-hint-copy"
        onClick={() => void copy()}
      >
        {copied()
          ? i18n.t("kernel.documentsUi.promptCopied")
          : i18n.t("kernel.documentsUi.copyPrompt")}
      </button>
    </div>
  )
}

const DocumentsSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const navigate = useNavigate()
  const isAdmin = () => canAccessScope(DOCUMENTS_ADMIN_SCOPE)

  const [templates] = createResource(isAdmin, () => listTemplates(api))
  const [recordTypes] = createResource(isAdmin, () => listRecordTypes(api).catch(() => []))
  const recordTypeLabel = (rt: string | null) => {
    if (!rt) return i18n.t("kernel.documentsUi.noRecordType")
    return recordTypes()?.find((r) => r.recordType === rt)?.label ?? rt
  }

  const [creating, setCreating] = createSignal(false)
  const [kind, setKind] = createSignal<TemplateKind>("rich_text")
  const [name, setName] = createSignal("")
  const [recordType, setRecordType] = createSignal("")
  const [file, setFile] = createSignal<File | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<InlineError | null>(null)

  function resetForm() {
    setCreating(false)
    setKind("rich_text")
    setName("")
    setRecordType("")
    setFile(null)
    setError(null)
  }

  async function create() {
    setError(null)
    const trimmed = name().trim()
    if (!trimmed) {
      setError({ message: i18n.t("kernel.documentsUi.nameRequired") })
      return
    }
    const rt = recordType() || null
    setBusy(true)
    try {
      let created: { id: string }
      if (kind() === "pdf_form") {
        const picked = file()
        if (!picked) {
          setError({ message: i18n.t("kernel.documentsUi.pdfRequired") })
          return
        }
        created = await createPdfFormTemplate(api, { name: trimmed, recordType: rt, file: picked })
      } else {
        created = await createRichTextTemplate(api, {
          name: trimmed,
          recordType: rt,
          body: { page: { size: "A4" }, blocks: [] },
        })
      }
      resetForm()
      navigate(`${DOCUMENTS_HREF}/${created.id}`)
    } catch (err) {
      setError(inlineError(err, i18n.t("kernel.documentsUi.createFailed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={isAdmin()}>
      <div data-testid="documents-settings">
        <AgentHint />

        <div class="mb-3 flex items-center justify-between gap-3">
          <p class="text-[13px] text-text-secondary">{i18n.t("kernel.documentsUi.intro")}</p>
          <Show when={!creating()}>
            <Button size="sm" onClick={() => setCreating(true)} data-testid="documents-new">
              {i18n.t("kernel.documentsUi.newTemplate")}
            </Button>
          </Show>
        </div>

        <Show when={creating()}>
          <div
            class="mb-4 space-y-3 rounded-md border border-border-subtle p-3"
            data-testid="documents-new-form"
          >
            <fieldset class="flex flex-wrap gap-4 text-[13px]">
              <label class="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="documents-new-kind"
                  checked={kind() === "rich_text"}
                  onChange={() => setKind("rich_text")}
                  data-testid="documents-new-kind-rich_text"
                />
                {i18n.t("kernel.documentsUi.kindRichText")}
              </label>
              <label class="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="documents-new-kind"
                  checked={kind() === "pdf_form"}
                  onChange={() => setKind("pdf_form")}
                  data-testid="documents-new-kind-pdf_form"
                />
                {i18n.t("kernel.documentsUi.kindPdfFormUpload")}
              </label>
            </fieldset>
            <label class="block text-[12.5px] text-text-secondary">
              {i18n.t("kernel.documentsUi.name")}
              <input
                class={INPUT}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                data-testid="documents-new-name"
              />
            </label>
            <label class="block text-[12.5px] text-text-secondary">
              {i18n.t("kernel.documentsUi.recordType")}
              <select
                class={INPUT}
                value={recordType()}
                onChange={(e) => setRecordType(e.currentTarget.value)}
                data-testid="documents-new-record-type"
              >
                <option value="">{i18n.t("kernel.documentsUi.noRecordType")}</option>
                <For each={recordTypes() ?? []}>
                  {(rt) => <option value={rt.recordType}>{rt.label}</option>}
                </For>
              </select>
            </label>
            <Show when={kind() === "pdf_form"}>
              <label class="block text-[12.5px] text-text-secondary">
                {i18n.t("kernel.documentsUi.pdfFile")}
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  class="mt-1 block text-[13px]"
                  onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
                  data-testid="documents-new-file"
                />
                <span class="mt-1 block">{i18n.t("kernel.documentsUi.pdfFileHint")}</span>
              </label>
            </Show>
            <Show when={error()}>
              {(e) => (
                <p class="text-[12.5px] text-error" role="alert" data-testid="documents-new-error">
                  {e().message}
                </p>
              )}
            </Show>
            <div class="flex gap-2">
              <Button
                size="sm"
                loading={busy()}
                disabled={busy()}
                onClick={() => void create()}
                data-testid="documents-new-create"
              >
                {i18n.t("kernel.documentsUi.create")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={resetForm}
                data-testid="documents-new-cancel"
              >
                {i18n.t("kernel.documentsUi.cancel")}
              </Button>
            </div>
          </div>
        </Show>

        <Show when={templates.error}>
          <p class="text-sm text-error" data-testid="documents-list-error">
            {inlineError(templates.error, i18n.t("kernel.documentsUi.loadFailed")).message}
          </p>
        </Show>
        <Show
          when={(templates() ?? []).length > 0}
          fallback={
            <Show when={!templates.error}>
              <p class="text-sm text-text-secondary" data-testid="documents-empty">
                {templates.loading
                  ? i18n.t("kernel.common.loading2")
                  : i18n.t("kernel.documentsUi.empty")}
              </p>
            </Show>
          }
        >
          <table class="w-full text-sm" data-testid="documents-table">
            <thead>
              <tr class="border-b border-border-subtle text-left text-text-secondary">
                <th class="py-2">{i18n.t("kernel.documentsUi.name")}</th>
                <th class="py-2">{i18n.t("kernel.documentsUi.kind")}</th>
                <th class="py-2">{i18n.t("kernel.documentsUi.recordType")}</th>
                <th class="py-2">{i18n.t("kernel.documentsUi.status")}</th>
                <th class="whitespace-nowrap py-2 pl-4 text-right">
                  {i18n.t("kernel.documentsUi.updated")}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={templates()}>
                {(t) => (
                  <tr
                    class="cursor-pointer border-b border-border-subtle hover:bg-surface-hover"
                    data-testid={`documents-row-${t.id}`}
                    onClick={() => navigate(`${DOCUMENTS_HREF}/${t.id}`)}
                  >
                    <td class="py-2 font-medium text-text">{t.name}</td>
                    <td class="py-2 text-text-secondary">
                      {t.kind === "pdf_form"
                        ? i18n.t("kernel.documentsUi.kindPdfForm")
                        : i18n.t("kernel.documentsUi.kindRichText")}
                    </td>
                    <td class="py-2 text-text-secondary">{recordTypeLabel(t.recordType)}</td>
                    <td
                      class="py-2 text-text-secondary"
                      data-testid={`documents-row-status-${t.id}`}
                    >
                      {t.enabled
                        ? i18n.t("kernel.documentsUi.on")
                        : i18n.t("kernel.documentsUi.off")}
                    </td>
                    <td class="whitespace-nowrap py-2 pl-4 text-right text-text-secondary">
                      {i18n.fmtDate(new Date(t.updatedAt), { dateStyle: "medium" })}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </Show>
  )
}

export default DocumentsSettings
