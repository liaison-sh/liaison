// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dock under a FRENCH provider. Its copy used to be English literals in
// `dock-copy.ts`, so a French reader got an English dock; these renders are
// what a literal cannot pass. Every assertion is on the French wording, which
// only resolves if the string went through `kernel.dock.*` in both locales.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import { ChatDock } from "./ChatDock"
import { ChatsTab } from "./ChatsTab"
import ConversationTab from "./ConversationTab"
import { openConversation, resetDockStore, setVisibleCapacity } from "./dock-store"

function renderFr(node: () => unknown) {
  return render(() => <I18nProvider initialLocale="fr">{node() as never}</I18nProvider>)
}

describe("the chat dock speaks French when the locale is French", () => {
  beforeEach(() => {
    resetDockStore()
    resetThreadStore()
  })
  afterEach(() => {
    cleanup()
    resetThreadStore()
  })

  it("the Chats pill is labelled Discussions, not Chats", () => {
    renderFr(() => <ChatsTab />)

    expect(screen.getByText("Discussions")).toBeInTheDocument()
    expect(screen.queryByText("Chats")).toBeNull()
  })

  it("the overflow item is labelled in French", () => {
    openConversation("t1")
    openConversation("t2")
    openConversation("t3")
    setVisibleCapacity(2)

    renderFr(() => <ChatDock />)

    expect(screen.getByText("+1")).toBeInTheDocument()
    expect(screen.getByLabelText("Plus de discussions")).toBeInTheDocument()
    expect(screen.queryByLabelText("More conversations")).toBeNull()
  })

  it("a conversation with no thread loaded is named in French", () => {
    openConversation("unknown-thread")

    renderFr(() => <ChatDock />)

    expect(screen.getByText("Discussion")).toBeInTheDocument()
  })

  it("a named thread keeps its own name rather than a translated one", () => {
    addThread({
      id: "t9",
      title: "Expedition",
      participants: [],
      unreadCount: 0,
    } as never)
    openConversation("t9")

    renderFr(() => <ChatDock />)

    expect(screen.getByText("Expedition")).toBeInTheDocument()
  })

  it("a conversation item's close control is named in French", () => {
    addThread({
      id: "t10",
      title: "Expedition",
      participants: [],
      unreadCount: 0,
    } as never)
    openConversation("t10", { expand: false })

    renderFr(() => <ChatDock renderTab={(tab) => <ConversationTab tab={tab} />} />)

    expect(screen.getByLabelText("Fermer Expedition")).toBeInTheDocument()
    expect(screen.queryByLabelText("Close Expedition")).toBeNull()
  })
})
