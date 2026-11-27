// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { localizeAgentName } from "./agent-name"

// A French sidebar listed "Personal agent" under "MESSAGES DIRECTS", beside
// "Agent personnel" elsewhere: the default name is stored in English.
describe("localizeAgentName", () => {
  it("translates only the product's default name", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <span />
      </I18nProvider>
    ))
    expect(localizeAgentName("Personal agent")).toBe("Agent personnel")
    expect(localizeAgentName("Support")).toBe("Support")
  })

  it("says whose agent a personal agent's post is in the reader's language", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <span />
      </I18nProvider>
    ))
    expect(localizeAgentName("Tobias's agent")).toBe("Agent de Tobias")
  })

  // An erased member's messages were signed "deleted-user-<uuid>" (iOS re-walk,
  // 2026-11): the row now carries the neutral name, read in the reader's language.
  it("names an erased person in the reader's language", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <span />
      </I18nProvider>
    ))
    expect(localizeAgentName("Deleted user")).toBe("Utilisateur supprimé")
  })

  it("names a DM with an erased person by the whole label, not its first word", async () => {
    const { threadDisplayName } = await import("./thread-store")
    render(() => (
      <I18nProvider initialLocale="fr">
        <span />
      </I18nProvider>
    ))
    const participants = [
      { id: "me", name: "Ana Diaz" },
      { id: "gone", name: "Deleted user" },
    ]
    expect(threadDisplayName({ title: null, participants }, "me")).toBe("Utilisateur supprimé")
  })
})

// The Chats list named the personal agent DM "Personal agent" under a French UI
// (second walk, 2026-09-23): the DM name came from the seat, untranslated.
describe("an agent DM's row name", () => {
  it("is the localized default name for the personal agent", async () => {
    const { conversationDisplayName } = await import("./conversation-display")
    render(() => (
      <I18nProvider initialLocale="fr">
        <span />
      </I18nProvider>
    ))
    const dm = {
      title: null,
      type: "dm",
      participants: [
        { id: "u1", name: "Avery", avatarUrl: null, participantType: "user" as const },
        {
          id: "a1",
          name: "Personal agent",
          avatarUrl: null,
          participantType: "agent" as const,
          agentId: "a1",
        },
      ],
    }
    expect(conversationDisplayName(dm, "u1")).toBe("Agent personnel")
  })
})
