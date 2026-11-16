// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The twelve pages of a link that cannot be used, from the server's own answer
// bodies (the allowlisted keys only): each answer maps to its frame, each frame
// says what happened and offers a next step, and none shows a document, a price
// or a name beyond the sender. `notfound` and `down` name nobody.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { FRAME_ACTIONS, FRAMES, type FrameFacts, type FrameId, frameOfAnswer } from "./frames"
import type { PublicAnswer } from "./public-api"
import { TokenFrame } from "./TokenFrame"

const SENDER = { name: "Léa Roux", org: "Maison Alpha" }
const dead = (state: string): PublicAnswer => ({
  status: 200,
  body: { state, sender: SENDER, next: "ask_sender" },
})

/** What the server answers in each state (the page's `wrong` is the holder's own choice). */
const ANSWERS: Record<Exclude<FrameId, "wrong">, PublicAnswer> = {
  expired: dead("expired"),
  used: dead("used"),
  revoked: dead("revoked"),
  declined: dead("declined"),
  signed: dead("signed"),
  attempts: { status: 423, body: { error: { code: "paused", retry_at: "2030-01-01" } } },
  locked: { status: 410, body: { state: "attempts", sender: SENDER, next: "ask_sender" } },
  replaced: dead("replaced"),
  ended: dead("ended"),
  notfound: { status: 404, body: { error: { code: "not_found" } } },
  down: { status: 503, body: { state: "down" } },
}

function facts(id: FrameId): FrameFacts {
  if (id === "wrong") return { frame: "wrong", sender: SENDER }
  const f = frameOfAnswer(ANSWERS[id], SENDER)
  if (!f) throw new Error(`no frame for ${id}`)
  return f
}

afterEach(() => cleanup())

describe("the twelve token states", () => {
  it("every server answer maps to its own frame, and an unreachable server to down", () => {
    for (const id of FRAMES) expect({ id, frame: facts(id).frame }).toEqual({ id, frame: id })
    expect(frameOfAnswer({ status: 0, body: null })?.frame).toBe("down")
    expect(
      frameOfAnswer({ status: 403, body: { error: { code: "NO_MAIL_ON_DEMO" } } })?.frame,
    ).toBe("down")
    expect(frameOfAnswer({ status: 200, body: { state: "open" } })).toBeNull()
  })

  it("each frame says what happened, offers a next step, and names the sender only when known", () => {
    const texts: Record<string, string> = {}
    for (const id of FRAMES) {
      render(() => (
        <I18nProvider initialLocale="en">
          <TokenFrame
            facts={facts(id)}
            invitedEmail="j•••@client.example"
            onAction={async () => {}}
          />
        </I18nProvider>
      ))
      const frame = screen.getByTestId(`token-frame-${id}`)
      const text = frame.textContent ?? ""
      texts[id] = text
      expect({ id, title: screen.getByTestId("token-frame-title").textContent }).not.toEqual({
        id,
        title: "",
      })
      expect({ id, actions: screen.getAllByRole("button").length }).toEqual({
        id,
        actions: FRAME_ACTIONS[id].length,
      })
      const nameless = id === "notfound" || id === "down"
      expect({ id, sender: screen.queryByTestId("token-frame-sender") === null }).toEqual({
        id,
        sender: nameless,
      })
      expect({ id, leaks: /Léa Roux|Statement|EUR|€/.test(nameless ? text : "") }).toEqual({
        id,
        leaks: false,
      })
      cleanup()
    }
    expect(texts).toMatchSnapshot()
  })

  it("the French pages exist for every frame", () => {
    for (const id of FRAMES) {
      render(() => (
        <I18nProvider initialLocale="fr">
          <TokenFrame facts={facts(id)} onAction={async () => {}} />
        </I18nProvider>
      ))
      expect({ id, title: screen.getByTestId("token-frame-title").textContent }).not.toEqual({
        id,
        title: `client-action.page.frame.${id}.title`,
      })
      cleanup()
    }
  })
})
