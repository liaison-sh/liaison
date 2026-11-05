// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One document template's page, /settings/admin/documents/<id>: its details
// (name, record type, on/off, archive) and tabs, never modals: Content (a
// rich text template's blocks), Fields & mapping (a PDF form's fields), Preview
// and Rules (which records need this template).

import { useLocation, useNavigate } from "@solidjs/router"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Switch } from "~/ui/Switch"
import { AgentHint, DOCUMENTS_ADMIN_SCOPE, DOCUMENTS_HREF } from "./DocumentsSettings"
import {
  archiveTemplate,
  type DocumentTemplate,
  getTemplate,
  type InlineError,
  inlineError,
  listRecordTypes,
  updateTemplate,
} from "./documents-api"
import { FieldMapping } from "./FieldMapping"
import { RichTextEditor } from "./RichTextEditor"
import { RulesTab } from "./RulesTab"
import { TemplatePreview } from "./TemplatePreview"

type TabId = "content" | "mapping" | "preview" | "rules"

const INPUT =
  "w-full rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text focus-visible:outline-2 focus-visible:outline-accent"

const DocumentTemplateDetail: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const navigate = useNavigate()
  const location = useLocation()
  const templateId = createMemo(() => {
    const m = location.pathname.match(/\/settings\/admin\/documents\/([^/?#]+)/)
    return m?.[1] ?? ""
  })
  const isAdmin = () => canAccessScope(DOCUMENTS_ADMIN_SCOPE)

  const [template, { mutate }] = createResource(
    () => (isAdmin() && templateId() ? templateId() : null),
    (id) => getTemplate(api, id),
  )
  const [recordTypes] = createResource(isAdmin, () => listRecordTypes(api).catch(() => []))
  const recordType = createMemo(() => {
    const rt = template()?.recordType
    return rt ? recordTypes()?.find((r) => r.recordType === rt) : undefined
  })

  const [tab, setTab] = createSignal<TabId | null>(null)
  const activeTab = (): TabId => tab() ?? (template()?.kind === "pdf_form" ? "mapping" : "content")
  const tabs = createMemo((): Array<{ id: TabId; label: string }> => {
    const t = template()
    if (!t) return []
    return [
      t.kind === "rich_text"
        ? { id: "content", label: i18n.t("kernel.documentsUi.tabContent") }
        : { id: "mapping", label: i18n.t("kernel.documentsUi.tabMapping") },
      { id: "preview", label: i18n.t("kernel.documentsUi.tabPreview") },
      { id: "rules", label: i18n.t("kernel.documentsUi.tabRules") },
    ]
  })

  // Details (name, record type, on/off): saved on their own.
  const [name, setName] = createSignal<string | null>(null)
  const [detailsError, setDetailsError] = createSignal<InlineError | null>(null)
  const [confirmArchive, setConfirmArchive] = createSignal(false)

  async function patchDetails(patch: Parameters<typeof updateTemplate>[2]) {
    setDetailsError(null)
    try {
      mutate(await updateTemplate(api, templateId(), patch))
      setName(null)
    } catch (err) {
      setDetailsError(inlineError(err, i18n.t("kernel.documentsUi.saveFailed")))
    }
  }

  async function archive() {
    setDetailsError(null)
    try {
      await archiveTemplate(api, templateId())
      navigate(DOCUMENTS_HREF)
    } catch (err) {
      setDetailsError(inlineError(err, i18n.t("kernel.documentsUi.saveFailed")))
    }
  }

  const onSaved = (t: DocumentTemplate) => mutate(t)

  return (
    <Show when={isAdmin()}>
      <div data-testid="document-template-detail">
        <a
          href={DOCUMENTS_HREF}
          class="mb-3 inline-block text-[12.5px] text-text-secondary underline-offset-2 hover:underline"
          data-testid="document-template-back"
        >
          {i18n.t("kernel.documentsUi.back")}
        </a>
        <Show when={template.error}>
          <p class="text-sm text-error" data-testid="document-template-load-error">
            {inlineError(template.error, i18n.t("kernel.documentsUi.loadFailed")).message}
          </p>
        </Show>
        <Show when={template()}>
          {(t) => (
            <>
              <AgentHint />
              <section class="mb-4 space-y-3" data-testid="document-template-details">
                <div class="flex flex-wrap items-end gap-3">
                  <label class="min-w-[220px] flex-1 text-[12.5px] text-text-secondary">
                    {i18n.t("kernel.documentsUi.name")}
                    <input
                      class={INPUT}
                      value={name() ?? t().name}
                      onInput={(e) => setName(e.currentTarget.value)}
                      data-testid="document-template-name"
                    />
                  </label>
                  <Show when={name() !== null && name() !== t().name}>
                    <Button
                      size="sm"
                      onClick={() => void patchDetails({ name: (name() ?? "").trim() })}
                      data-testid="document-template-name-save"
                    >
                      {i18n.t("kernel.documentsUi.save")}
                    </Button>
                  </Show>
                  <label class="min-w-[200px] text-[12.5px] text-text-secondary">
                    {i18n.t("kernel.documentsUi.recordType")}
                    <select
                      class={INPUT}
                      value={t().recordType ?? ""}
                      onChange={(e) =>
                        void patchDetails({ recordType: e.currentTarget.value || null })
                      }
                      data-testid="document-template-record-type"
                    >
                      <option value="">{i18n.t("kernel.documentsUi.noRecordType")}</option>
                      <For each={recordTypes() ?? []}>
                        {(rt) => <option value={rt.recordType}>{rt.label}</option>}
                      </For>
                    </select>
                  </label>
                  <div class="flex items-center gap-2 pb-1 text-[12.5px] text-text-secondary">
                    <Switch
                      checked={t().enabled}
                      label={i18n.t("kernel.documentsUi.enabled")}
                      onChange={(next) => void patchDetails({ enabled: next })}
                      data-testid="document-template-enabled"
                    />
                    {t().enabled
                      ? i18n.t("kernel.documentsUi.on")
                      : i18n.t("kernel.documentsUi.off")}
                  </div>
                </div>
                <div class="flex items-center gap-2 text-[12.5px]">
                  <Show
                    when={confirmArchive()}
                    fallback={
                      <button
                        type="button"
                        class="text-text-secondary underline-offset-2 hover:underline"
                        onClick={() => setConfirmArchive(true)}
                        data-testid="document-template-archive"
                      >
                        {i18n.t("kernel.documentsUi.archive")}
                      </button>
                    }
                  >
                    <span class="text-text-secondary">
                      {i18n.t("kernel.documentsUi.archiveConfirm")}
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void archive()}
                      data-testid="document-template-archive-confirm"
                    >
                      {i18n.t("kernel.documentsUi.archive")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(false)}>
                      {i18n.t("kernel.documentsUi.cancel")}
                    </Button>
                  </Show>
                </div>
                <Show when={detailsError()}>
                  {(e) => (
                    <p
                      class="text-[12.5px] text-error"
                      role="alert"
                      data-testid="document-template-details-error"
                    >
                      {e().message}
                    </p>
                  )}
                </Show>
              </section>

              <div
                class="mb-3 flex gap-1 border-b border-border-subtle"
                role="tablist"
                data-testid="document-template-tabs"
              >
                <For each={tabs()}>
                  {(entry) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab() === entry.id}
                      data-active={activeTab() === entry.id ? "true" : "false"}
                      data-testid={`document-template-tab-${entry.id}`}
                      class={cn(
                        "-mb-px border-b-2 px-3 py-1.5 text-[13px]",
                        activeTab() === entry.id
                          ? "border-accent font-medium text-text"
                          : "border-transparent text-text-secondary hover:text-text",
                      )}
                      onClick={() => setTab(entry.id)}
                    >
                      {entry.label}
                    </button>
                  )}
                </For>
              </div>

              <Show when={activeTab() === "content" && t().kind === "rich_text"}>
                <RichTextEditor template={t()} recordType={recordType()} onSaved={onSaved} />
              </Show>
              <Show when={activeTab() === "mapping" && t().kind === "pdf_form"}>
                <FieldMapping template={t()} recordType={recordType()} onSaved={onSaved} />
              </Show>
              <Show when={activeTab() === "preview"}>
                <TemplatePreview template={t()} />
              </Show>
              <Show when={activeTab() === "rules"}>
                <RulesTab template={t()} />
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}

export default DocumentTemplateDetail
