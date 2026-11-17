// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The twelve states of the token page, each through the real app, against an
// allowlist of the keys its JSON body may hold. A dead link returns no document,
// price or body; the not-found answer has no sender; a wrong code says only how
// many tries are left.
import { describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  call,
  codeFor,
  k,
  mintTo,
  nextIp,
  proofFor,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"

const kit = useClientActionWorld("statedocs")

/** Every key path of a JSON value, arrays read as their elements. */
function keyPaths(v: unknown, at = ""): string[] {
  if (Array.isArray(v)) return [...new Set(v.flatMap((x) => keyPaths(x, `${at}[]`)))]
  if (!v || typeof v !== "object") return []
  return Object.entries(v as Record<string, unknown>).flatMap(([key, x]) => {
    const here = at ? `${at}.${key}` : key
    return [here, ...keyPaths(x, here)]
  })
}

const DEAD_KEYS = ["next", "sender", "sender.name", "sender.org", "state"]
const ALLOWED: Record<string, string[]> = {
  open: [
    "invited_email_masked",
    "kind",
    "phrase",
    "ref",
    "sender",
    "sender.name",
    "sender.org",
    "state",
    "steps",
    "summary",
    "summary[].k",
    "summary[].v",
    "title",
    "valid_until",
  ],
  expired: DEAD_KEYS,
  used: DEAD_KEYS,
  revoked: DEAD_KEYS,
  declined: DEAD_KEYS,
  // A signer's last page also says where their own copy stands, and the masked address.
  signed: [...DEAD_KEYS, "copy", "copy_to"],
  attempts: DEAD_KEYS,
  replaced: DEAD_KEYS,
  edited: DEAD_KEYS,
  ended: DEAD_KEYS,
  notfound: ["error", "error.code"],
  down: ["state"],
  wrong: ["error", "error.code", "error.left"],
}

async function openBody(token: string) {
  const res = await call("open", { t: token }, { "x-bun-socket-ip": nextIp() })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function frames(): Promise<
  Record<string, { status: number; body: Record<string, unknown> }>
> {
  const out: Record<string, { status: number; body: Record<string, unknown> }> = {}
  const set = async (id: string, assignments: string) =>
    sql.unsafe(`UPDATE ${schemaRef("kernel")}.client_actions SET ${assignments} WHERE id = $1`, [
      id,
    ])

  const open = await mintTo(kit)
  out.open = await openBody(open.token)

  const expired = await mintTo(kit)
  await set(expired.id, "expires_at = now() - interval '1 second'")
  out.expired = await openBody(expired.token)

  const used = await mintTo(kit, kit.w.clientA, { kind: "accept" })
  await set(used.id, "decided_at = now(), decision = 'accepted'")
  out.used = await openBody(used.token)

  const revoked = await mintTo(kit)
  await set(revoked.id, "revoked_at = now(), revoke_reason = 'withdrawn'")
  out.revoked = await openBody(revoked.token)

  const declined = await mintTo(kit)
  await set(declined.id, "decided_at = now(), decision = 'declined'")
  out.declined = await openBody(declined.token)

  const signed = await mintTo(kit)
  const ip = nextIp()
  const proof = await proofFor(kit, signed.token, ip)
  const done = await call(
    "decide",
    { t: signed.token, proof, decision: "sign", typed_name: kit.w.clientA.name },
    { "x-bun-socket-ip": ip },
  )
  expect(done.status).toBe(200)
  out.signed = await openBody(signed.token)

  const attempts = await mintTo(kit)
  await set(attempts.id, "code_locked_at = now()")
  out.attempts = await openBody(attempts.token)

  // Rotated away: the old token opens only the replaced page.
  const replaced = await mintTo(kit)
  await sql`
    UPDATE ${k("client_actions")}
       SET prior_token_hashes = array_append(prior_token_hashes, token_hash), token_hash = ${"f".repeat(64)}
     WHERE id = ${replaced.id}`
  out.replaced = await openBody(replaced.token)

  // A version saved over a sent one revokes its links and mails nothing new.
  const edited = await mintTo(kit)
  await set(edited.id, "revoked_at = now(), revoke_reason = 'replaced'")
  out.edited = await openBody(edited.token)

  const ended = await mintTo(kit)
  await set(ended.id, "revoked_at = now(), revoke_reason = 'access_ended'")
  out.ended = await openBody(ended.token)

  out.notfound = await openBody(
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  )

  const down = await mintTo(kit)
  // The app's read tool answers nothing: the page is down and nothing changes.
  kit.viewAnswers = false
  out.down = await openBody(down.token)
  kit.viewAnswers = true

  const wrong = await mintTo(kit)
  const ip2 = nextIp()
  const code = await codeFor(kit, wrong.token, ip2, kit.w.clientA.email)
  const res = await call(
    "verify",
    { t: wrong.token, code: code === "000000" ? "111111" : "000000", name: kit.w.clientA.name },
    { "x-bun-socket-ip": ip2 },
  )
  out.wrong = { status: res.status, body: (await res.json()) as Record<string, unknown> }
  return out
}

describe("the token page's twelve states", () => {
  it("each state answers its own frame with only its allowed keys, and a dead link holds no document", async () => {
    const got = await frames()
    expect(Object.keys(got).sort()).toEqual(Object.keys(ALLOWED).sort())
    for (const [name, { status, body }] of Object.entries(got)) {
      const paths = keyPaths(body).sort()
      expect({ name, paths }).toEqual({ name, paths: [...(ALLOWED[name] ?? [])].sort() })
      if (name !== "notfound" && name !== "down" && name !== "wrong" && name !== "edited") {
        expect({ name, state: body.state }).toEqual({ name, state: name })
      }
      if (name !== "open") {
        const text = JSON.stringify(body)
        expect({ name, leaks: /Contrat|1 200|Les parties/.test(text) }).toEqual({
          name,
          leaks: false,
        })
      }
      expect({ name, status }).toEqual({
        name,
        status:
          {
            open: 200,
            notfound: 404,
            down: 503,
            wrong: 401,
          }[name] ?? 200,
      })
    }
    expect(got.signed?.body.copy).toBe("on_its_way")
    // A rotated link offers the new one again; a link of a replaced version was not followed
    // by a new link, so its page offers asking the sender, never "sent to the same address".
    expect(got.replaced?.body.next).toBe("resend_link")
    expect(got.edited?.body).toMatchObject({ state: "replaced", next: "ask_sender" })
    expect(got.notfound?.body).toEqual({ error: { code: "not_found" } })
    expect(got.wrong?.body).toMatchObject({ error: { code: "wrong_code", left: 4 } })
  }, 60_000)
})
