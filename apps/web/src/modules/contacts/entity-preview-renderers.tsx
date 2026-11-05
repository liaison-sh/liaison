// SPDX-License-Identifier: FSL-1.1-ALv2
import { Show } from "solid-js"
import { registerEntityPreview } from "~/modules/shell/entity-preview/registry"

interface ContactPreviewData {
  name?: string | null
  email?: string | null
  phone?: string | null
  company?: string | null
}

export function registerEntityPreviews(): void {
  registerEntityPreview<ContactPreviewData>({
    app: "kernel",
    entityType: "contact",
    fetch: async (id, api) => {
      const res = await api.getEnvelope<ContactPreviewData>(`/contacts/${id}`)
      return res.data
    },
    render: (contact) => (
      <div>
        <div class="font-medium text-text">{contact.name ?? contact.email}</div>
        <div class="text-text-secondary text-[12px]">{contact.email}</div>
        <Show when={contact.phone}>
          <div class="text-text-tertiary text-[11px]">{contact.phone}</div>
        </Show>
        <Show when={contact.company}>
          <div class="text-text-tertiary text-[11px]">{contact.company}</div>
        </Show>
      </div>
    ),
  })
}
