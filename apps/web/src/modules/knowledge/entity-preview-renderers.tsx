// SPDX-License-Identifier: FSL-1.1-ALv2
// Hover/pin previews for `#`-mentioned Knowledge entities. Without these a
// `@[Spec](knowledge:document:<id>)` in a task description rendered as a dumb
// "document: <id>" pill.

import { Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { registerEntityPreview } from "~/modules/shell/entity-preview/registry"

interface DocumentPreviewData {
  id?: string
  title?: string
  summary?: string | null
  body?: string | null
}

interface SourceLinkPreviewData {
  id?: string
  title?: string
  source?: string
  url?: string | null
  summary?: string | null
}

const EXCERPT = 280

function excerpt(text: string | null | undefined): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat
}

export function registerEntityPreviews(): void {
  registerEntityPreview<DocumentPreviewData>({
    app: "knowledge",
    entityType: "document",
    fetch: async (id, api) => {
      const env = await api.getEnvelope<DocumentPreviewData>(`/knowledge/documents/${id}`)
      return env.data ?? { id }
    },
    render: (d) => (
      <div data-testid={`knowledge-document-preview-${d.id ?? ""}`}>
        <div class="font-medium text-text">{d.title ?? "(untitled)"}</div>
        <Show when={excerpt(d.summary || d.body)}>
          {(text) => <div class="text-[12px] text-text-secondary">{text()}</div>}
        </Show>
      </div>
    ),
  })

  registerEntityPreview<SourceLinkPreviewData>({
    app: "knowledge",
    entityType: "source_link",
    fetch: async (id, api) => {
      const env = await api.getEnvelope<SourceLinkPreviewData>(`/knowledge/source-links/${id}`)
      return env.data ?? { id }
    },
    render: (l) => (
      <div data-testid={`knowledge-source-link-preview-${l.id ?? ""}`}>
        <div class="font-medium text-text">
          {l.title ?? useI18n().t("knowledge.untitledParens")}
        </div>
        <div class="text-[11px] text-text-tertiary">
          {l.source ?? useI18n().t("knowledge.remoteDocument")}
        </div>
        <Show when={excerpt(l.summary)}>
          {(text) => <div class="text-[12px] text-text-secondary">{text()}</div>}
        </Show>
      </div>
    ),
  })
}
