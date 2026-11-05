// SPDX-License-Identifier: FSL-1.1-ALv2
// The chat scenario says what the visitor is looking at: the question by name
// (the EU battery passport), a live web search with its sources, what an agent
// in Liaison is (its own memory and its own tools, on the closing step), and,
// on "With its sources", that the sources are the web pages the agent cites,
// linked under its answer, which that step waits for.
import { describe, expect, it } from "bun:test"
import en from "../../i18n/locales/en/tours.json"
import fr from "../../i18n/locales/fr/tours.json"
import { scenarioChatTour } from "./chat"

const chat = { en: en.scenarios.chat, fr: fr.scenarios.chat }

describe("chat scenario copy", () => {
  it("asking the agent names the question and the live, sourced web search", () => {
    expect(chat.en.askAgent.body).toMatch(/battery passport/)
    expect(chat.en.askAgent.body).toMatch(/searches the web live/)
    expect(chat.en.askAgent.body).toMatch(/sources/)
    expect(chat.fr.askAgent.body).toMatch(/passeport batterie/)
    expect(chat.fr.askAgent.body).toMatch(/sur le web en direct/)
    expect(chat.fr.askAgent.body).toMatch(/sources/)
  })

  // The sources step rings the links under the answer (MessageCitations reads
  // them from its text): the request asks for them, as a person would.
  it("the request asks the agent to look it up on the web, with links to its sources", () => {
    expect(chat.en.askAgent.text).toMatch(/battery passport/)
    expect(chat.en.askAgent.text).toMatch(/on the web/)
    expect(chat.en.askAgent.text).toMatch(/links to your sources/)
    expect(chat.fr.askAgent.text).toMatch(/passeport batterie/)
    expect(chat.fr.askAgent.text).toMatch(/sur le web/)
    expect(chat.fr.askAgent.text).toMatch(/liens vers vos sources/)
  })

  // Owner: a request reads as a person would write it, never as instructions
  // to the agent on how to work (how many searches, what not to open or save,
  // whether to ask first). An agent that needs them has a product bug.
  it("the requests carry no instructions on how the agent works", () => {
    const asks = [
      chat.en.askAgent.text,
      chat.en.followUp.text,
      chat.fr.askAgent.text,
      chat.fr.followUp.text,
    ]
    for (const text of asks) {
      expect(text).not.toMatch(
        /one web search|search again|new search|memory|open the pages|check with me|Commencez par|nouvelle recherche|mémoire|N'ouvrez pas|confirmation|https:\/\//i,
      )
    }
  })

  // The task goes in the seeded launch project, named as a person would name it.
  it("the follow-up asks for a task in the seeded launch project", () => {
    expect(chat.en.followUp.text).toMatch(/a task for Tobias/)
    expect(chat.en.followUp.text).toMatch(/"Kestrel Field Preamp launch"/)
    expect(chat.fr.followUp.text).toMatch(/une tâche pour Tobias/)
    expect(chat.fr.followUp.text).toMatch(/« Kestrel Field Preamp launch »/)
  })

  it("a task write held for approval completes the task step, and the next step approves that request", () => {
    const task = scenarioChatTour.beats.find((b) => b.id === "task")
    expect(task?.event?.heldAs).toEqual(["projects:create", "projects:createProject"])
    const approve = scenarioChatTour.beats.find((b) => b.id === "approve-task")
    expect(approve?.whenHeld).toBe("task")
    expect(approve?.event?.sameEntityAs).toBe("task")
    expect(approve?.anchor).toBe("approval-card[data-request-id={task}]")
    expect(approve?.autoplay?.[0]).toEqual({ openRunConversation: true })
    expect(approve?.optional).toEqual({ whenApp: "projects" })
  })

  it("the closing step says agents are like people, with their own memory and tools", () => {
    expect(chat.en.done.body).toMatch(/like (people|a person)/i)
    expect(chat.fr.done.body).toMatch(/comme (des personnes|une personne)/i)
    for (const body of [chat.en.done.body, chat.fr.done.body]) {
      expect(body).toMatch(/mémoire|memory/)
      expect(body).toMatch(/compaction/)
      expect(body).toMatch(/outils|tools/)
      expect(body).toMatch(/expert/)
    }
  })

  it("'With its sources' says the sources are the cited web pages, linked under the answer", () => {
    expect(`${chat.en.sources.title} ${chat.en.sources.body}`).toMatch(/web pages/)
    expect(chat.en.sources.body).toMatch(/battery passport/)
    expect(chat.en.sources.body).toMatch(/links under its answer/)
    expect(`${chat.fr.sources.title} ${chat.fr.sources.body}`).toMatch(/pages web/)
    expect(chat.fr.sources.body).toMatch(/passeport batterie/)
    expect(chat.fr.sources.body).toMatch(/sous sa réponse/)
  })

  it("'With its sources' spotlights the citations and waits for the answer", () => {
    const sources = scenarioChatTour.beats.find((b) => b.id === "sources")
    // This run's answer, not an earlier turn's in the same conversation.
    expect(sources?.anchor).toBe("message-citations[data-turn-id={ask-agent}]")
    expect(sources?.waitsOn).toBe("agent")
  })
})
