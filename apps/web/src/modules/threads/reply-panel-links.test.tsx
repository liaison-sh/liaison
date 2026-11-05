// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A17 / S6: a notification row or a search hit about a message that lives in a
// reply thread opens the channel with the reply panel on that root.

import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn(async () => {}),
  markAttentionRead: vi.fn(),
}))

import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import AttentionRow from "~/modules/shell/AttentionRow"
import { openEntity } from "~/modules/shell/entity-opener"
import { makeTabId, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import {
  getOpenReplyPanel,
  openSearchMessageHit,
  resetReplyPanels,
} from "~/modules/threads/reply-panel-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const api = {
  get: vi.fn(),
  post: vi.fn(async () => ({})),
  patch: vi.fn(),
  delete: vi.fn(),
  getEnvelope: vi.fn(),
} as any

beforeEach(() => {
  resetReplyPanels()
  resetTabStore()
  vi.mocked(openEntity).mockClear()
})

describe("links into a reply thread", () => {
  it("a thread_followup row opens its channel with the panel on the root", () => {
    const item: AttentionItem = {
      id: "kernel:thread_followup:t-1",
      app: "kernel",
      entity: "thread",
      entityId: "t-1",
      kind: "thread_followup",
      summary: "Bob: done",
      urgency: 40,
      occurredAt: "2026-09-28T10:00:00Z",
      action: { type: "open_entity", tabType: "kernel:thread", entityId: "t-1" },
      metadata: { messageId: "m-9", replyRootId: "root-1" },
    }
    const { getByTestId } = render(() => (
      <I18nProvider initialLocale="en">
        <ApiContext.Provider value={api}>
          <AttentionRow item={item} />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    fireEvent.click(getByTestId("attention-row-kernel-thread-t-1"))
    expect(getOpenReplyPanel("t-1")).toMatchObject({ rootId: "root-1", focusMessageId: "m-9" })
    expect(openEntity).toHaveBeenCalled()
  })

  it("a mention row without a reply root leaves the panel closed", () => {
    const item: AttentionItem = {
      id: "kernel:mention:t-2",
      app: "kernel",
      entity: "thread",
      entityId: "t-2",
      kind: "mention",
      summary: "Bob mentioned you",
      urgency: 60,
      occurredAt: "2026-09-28T10:00:00Z",
      action: { type: "open_entity", tabType: "kernel:thread", entityId: "t-2" },
      metadata: { messageId: "m-1" },
    }
    const { getByTestId } = render(() => (
      <I18nProvider initialLocale="en">
        <ApiContext.Provider value={api}>
          <AttentionRow item={item} />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    fireEvent.click(getByTestId("attention-row-kernel-thread-t-2"))
    expect(getOpenReplyPanel("t-2")).toBeNull()
  })

  it("a message search hit in a reply thread opens the channel and the panel", () => {
    const handled = openSearchMessageHit({
      id: "kernel:message:m-3",
      app: "kernel",
      entity_type: "message",
      entity_id: "m-3",
      thread_id: "t-3",
      replyRootId: "root-3",
      title: "the hit",
    })
    expect(handled).toBe(true)
    expect(tabStore.activeTabId).toBe(makeTabId("thread", "t-3"))
    expect(getOpenReplyPanel("t-3")).toMatchObject({ rootId: "root-3", focusMessageId: "m-3" })
  })
})
