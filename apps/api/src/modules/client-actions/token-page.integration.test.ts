// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the token page needs from the public routes, through the real app: the end
// of the document in view is recorded once, only after the document was shown,
// with the server's own count of page pictures served, and the record an app
// reads carries that time; the consent words come in the page's language; the
// open answer names the words a sender asked the signer to type.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { readClientActionRecord } from "~/modules/client-actions/mint"
import {
  call,
  codeFor,
  eventsOf,
  k,
  mintTo,
  nextIp,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"

const kit = useClientActionWorld("tokenpage")

describe("the token page's server half", () => {
  it("the end of the document is recorded once, only after the document was shown, with the pages served", async () => {
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    await call("open", { t: token }, { "x-bun-socket-ip": ip })
    const early = await call("seen", { t: token, reached_end: true }, { "x-bun-socket-ip": ip })
    expect(early.status).toBe(204)
    expect((await eventsOf(id)).filter((e) => e.event === "reached_end")).toHaveLength(0)

    await call("document", { t: token, format: "blocks" }, { "x-bun-socket-ip": ip })
    for (let i = 0; i < 2; i++) {
      const res = await call("seen", { t: token, reached_end: true }, { "x-bun-socket-ip": ip })
      expect(res.status).toBe(204)
    }
    const ends = (await eventsOf(id)).filter((e) => e.event === "reached_end")
    expect(ends).toHaveLength(1)
    const meta = ends[0]?.meta as { reached_end_at?: string; pages_served?: number }
    expect(typeof meta.reached_end_at).toBe("string")
    expect(meta.pages_served).toBe(0)

    const record = await readClientActionRecord(kit.w.orgId, kit.targetApp, id)
    expect(record?.reachedEndAt?.toISOString()).toBe(meta.reached_end_at)
  })

  it("a plain seen without the flag records no end", async () => {
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    await call("document", { t: token, format: "blocks" }, { "x-bun-socket-ip": ip })
    await call("seen", { t: token }, { "x-bun-socket-ip": ip })
    const events = (await eventsOf(id)).map((e) => e.event)
    expect(events).toContain("opened")
    expect(events).not.toContain("reached_end")
  })

  it("the consent words come and are stored in the language the page is shown in", async () => {
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    const code = await codeFor(kit, token, ip, kit.w.clientA.email)
    const res = await call(
      "verify",
      { t: token, code, name: kit.w.clientA.name, lang: "fr" },
      { "x-bun-socket-ip": ip },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { words: string }
    expect(body.words).toContain("signature électronique simple")
    const [row] = await sql`
      SELECT words_shown, words_lang FROM ${k("client_actions")} WHERE id = ${id}`
    expect(row?.words_lang).toBe("fr")
    expect(row?.words_shown).toBe(body.words)
  })

  it("a typed name the signature page cannot draw is refused at the name step, before the code is spent", async () => {
    const { id, token } = await mintTo(kit)
    const ip = nextIp()
    const code = await codeFor(kit, token, ip, kit.w.clientA.email)
    const refused = await call(
      "verify",
      { t: token, code, name: "\u{1F600}\u{1F600}" },
      { "x-bun-socket-ip": ip },
    )
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: { code: "name_not_drawable" } })
    const [row] = await sql`
      SELECT code_wrong_total, code_verified_at FROM ${k("client_actions")} WHERE id = ${id}`
    expect(row?.code_wrong_total).toBe(0)
    expect(row?.code_verified_at).toBeNull()
    expect((await eventsOf(id)).map((e) => e.event)).not.toContain("code_ok")
    // The same code still works once the name is typed in Latin letters.
    const ok = await call(
      "verify",
      { t: token, code, name: "Jean Tessier" },
      { "x-bun-socket-ip": ip },
    )
    expect(ok.status).toBe(200)
  })

  it("the open answer names the words the sender asked for, and null when none", async () => {
    const plain = await mintTo(kit)
    const open1 = await call("open", { t: plain.token }, { "x-bun-socket-ip": nextIp() })
    expect(((await open1.json()) as { phrase: unknown }).phrase).toBeNull()
    const asked = await mintTo(kit)
    await sql`UPDATE ${k("client_actions")} SET required_phrase = 'Bon pour accord' WHERE id = ${asked.id}`
    const open2 = await call("open", { t: asked.token }, { "x-bun-socket-ip": nextIp() })
    expect(((await open2.json()) as { phrase: unknown }).phrase).toBe("Bon pour accord")
  })
})
