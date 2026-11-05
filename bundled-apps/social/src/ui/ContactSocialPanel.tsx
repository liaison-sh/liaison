// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ContactSocialPanel — slot contribution for the kernel's contact_detail page
// (§5/§6/§12). Renders a contact's social history: their brand-relevant
// findings (mentions/comments) and DM conversations, joined by `contact_id`.
//
// Slot wiring. Declared in app.manifest.json under
// `slots.contact_detail.panels[]` with visibility_scope
// "social:findings:read"; the kernel filters out the contribution when the
// viewer lacks the scope and renders its "Panel unavailable" placeholder on a
// bundle-load failure. This component is the happy path. The kernel slot host
// mounts every panel with the contact id in the `entityId` prop.

import { app, navigate } from "@liaison/host"
import { createResource, For, Show, type Component } from "solid-js"
import { stripExternalFence } from "./kit"

export interface ContactSocialPanelProps {
  /** Kernel slot host mounts the panel with the contact id as `entityId`. */
  entityId?: string
  /** Direct/unit usage may pass the contact id as `contactId` instead. */
  contactId?: string
}

interface FindingRow {
  id: string
  platform: string
  relation: string
  content_text?: string | null
  occurred_at?: string | null
  status: string
}

interface ConversationRow {
  id: string
  platform: string
  participant_handle?: string | null
  last_message_snippet?: string | null
  last_message_at?: string | null
}

/**
 * Load the contact's social history. Exported for the cross-boundary
 * regression test that drives this loader against a real-DB-backed host.
 */
export async function loadContactSocial(contactId: string): Promise<{
  findings: FindingRow[]
  conversations: ConversationRow[]
}> {
  const [findingsRes, dmRes] = await Promise.all([
    app
      .invokeTool<{ findings: FindingRow[] }>("findings_list", { contact_id: contactId, limit: 100 })
      .catch(() => ({ findings: [] as FindingRow[] })),
    app
      .invokeTool<{ conversations: ConversationRow[] }>("dm_list", { contact_id: contactId, limit: 100 })
      .catch(() => ({ conversations: [] as ConversationRow[] })),
  ])
  return {
    findings: Array.isArray(findingsRes?.findings) ? findingsRes.findings : [],
    conversations: Array.isArray(dmRes?.conversations) ? dmRes.conversations : [],
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-"
  return iso.slice(0, 10)
}

export const ContactSocialPanel: Component<ContactSocialPanelProps> = (props) => {
  const cid = (): string => props.entityId ?? props.contactId ?? ""
  const [data] = createResource(() => cid() || undefined, loadContactSocial)

  return (
    <section data-testid="contact-social-panel" class="flex flex-col gap-4 px-4 py-3 text-[12.5px]">
      {/* Mentions / findings */}
      <div class="flex flex-col gap-1">
        <span class="text-text-tertiary">Mentions &amp; comments</span>
        <Show
          when={(data()?.findings.length ?? 0) > 0}
          fallback={
            <div data-testid="contact-social-panel-findings-empty" class="text-text-tertiary">
              No social activity for this contact yet.
            </div>
          }
        >
          <For each={data()?.findings ?? []}>
            {(row) => (
              <button
                type="button"
                data-testid={`contact-social-panel-finding-${row.id}`}
                class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2 py-1 text-left hover:bg-surface-hover"
                onClick={() => navigate(`/social/findings?finding=${encodeURIComponent(row.id)}`)}
              >
                <span class="font-mono text-text-tertiary">{fmtDate(row.occurred_at)}</span>
                <span class="text-text-secondary">{row.platform}</span>
                <span class="truncate text-text">{stripExternalFence(row.content_text) || row.relation}</span>
              </button>
            )}
          </For>
        </Show>
      </div>

      {/* DM history */}
      <Show when={(data()?.conversations.length ?? 0) > 0}>
        <div class="flex flex-col gap-1">
          <span class="text-text-tertiary">Direct messages</span>
          <For each={data()?.conversations ?? []}>
            {(c) => (
              <button
                type="button"
                data-testid={`contact-social-panel-dm-${c.id}`}
                class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2 py-1 text-left hover:bg-surface-hover"
                onClick={() => navigate(`/social/messages?conversation=${encodeURIComponent(c.id)}`)}
              >
                <span class="font-mono text-text-tertiary">{fmtDate(c.last_message_at)}</span>
                <span class="text-text-secondary">{c.participant_handle ?? c.platform}</span>
                <span class="truncate text-text">{stripExternalFence(c.last_message_snippet)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
