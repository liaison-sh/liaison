// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Each open builder tab's title (`resolveLabel`), and how a draft is opened.
import { createStore, reconcile } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { openTab } from "~/modules/shell/tab-store"

export const BUILDER_TAB_TYPE = "kernel:app-builder"

const [titles, setTitles] = createStore<Record<string, string>>({})

export function draftTitle(id: string): string | undefined {
  return titles[id]
}

export function rememberDraftTitle(id: string, title: string): void {
  setTitles(id, title)
}

export function openDraft(d: { id: string; title: string }): void {
  rememberDraftTitle(d.id, d.title)
  openTab({ type: BUILDER_TAB_TYPE, entityId: d.id, label: d.title })
}

/** Forget every remembered title (sign-out, a switch of account; tests). */
export function resetBuilderStore(): void {
  setTitles(reconcile({}))
}

// Draft titles are the signed-in member's: none survives into the next session.
onSessionTeardown(resetBuilderStore)
