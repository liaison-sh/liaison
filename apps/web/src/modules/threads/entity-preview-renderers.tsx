// SPDX-License-Identifier: FSL-1.1-ALv2
import { tNow } from "~/modules/i18n/i18n-context"
import { registerEntityPreview } from "~/modules/shell/entity-preview/registry"

interface ThreadPreviewData {
  id: string
  handle?: string | null
  title?: string | null
  type?: string | null
  unreadCount?: number | null
}

export function registerEntityPreviews(): void {
  registerEntityPreview<ThreadPreviewData>({
    app: "kernel",
    entityType: "thread",
    fetch: async (id, api) => {
      const res = await api.getEnvelope<ThreadPreviewData>(`/threads/${id}`)
      return res.data
    },
    render: (thread) => (
      <div data-testid={`thread-preview-${thread.id}`}>
        {thread.handle ? <div class="text-text-tertiary text-[11px]">{thread.handle}</div> : null}
        <div class="font-medium text-text">
          {thread.title ?? tNow("kernel.threadsUi.untitledThread")}
        </div>
        {thread.unreadCount && thread.unreadCount > 0 ? (
          <div class="text-text-secondary text-[12px]">
            {tNow("kernel.threadsUi.unreadCount", { count: thread.unreadCount })}
          </div>
        ) : null}
      </div>
    ),
  })
}
