// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { detectForumNotification } from "./inbound"

describe("detectForumNotification", () => {
  it.each([
    "[New Reply] in Step sequencer",
    "[New Topic] Make updating slider position on layout",
    "[New Post] in Feature Requests",
    "[Neue Antwort] in Step sequencer",
    "[Nieuwe reactie] in Step sequencer",
    "[Nouvelle réponse] dans Séquenceur",
    "[Nueva respuesta] en Secuenciador",
    "  [New Reply] in leading whitespace tolerated",
  ])("flags forum notification subject: %s", (subject) => {
    expect(detectForumNotification({ subject } as never)).toBe(true)
  })

  it.each([
    "Re: Not working in fernwave 6",
    "Broken usb c port",
    "Tessera Sound discount?",
    "[Invoice 1950] from Fabrikam", // a bracketed subject that is NOT a forum keyword
    "Fwd: Assistante comptable en alternance",
    "",
  ])("does not flag a real customer subject: %s", (subject) => {
    expect(detectForumNotification({ subject } as never)).toBe(false)
  })

  it("tolerates a missing subject", () => {
    expect(detectForumNotification({} as never)).toBe(false)
  })
})
