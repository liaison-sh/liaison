// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SC10: a fresh browser profile, holding no local state at all, opens the
// mailbox with nothing but the mailbox password.
//
// This is the property that decides whether "clear site data" is an
// inconvenience or a permanent loss. The identity private halves are what
// actually open mail; the mailbox password only recovers the Account Key, and an
// Account Key opens nothing on its own. So if the wrapped private halves live
// only in the enrolling browser, the password is worthless the moment that
// browser is gone, and every sealed message is unreadable forever.
//
// The durable copy therefore has to be server side, and it concedes nothing:
// the four columns are AES-GCM ciphertext under the Account Key with a bound
// AAD, and the Account Key never leaves the browser. The server holds bytes it
// has no way to open, which is the same bargain the rest of this design makes.
//
// The test simulates the two devices honestly. Device A enrolls and is then
// DISCARDED: nothing it computed is carried into the second half except the
// mailbox password, which is the one thing the human remembers. Device B
// starts from the password and the two owner-only REST reads, and has to reach
// the plaintext of a message the SERVER sealed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import {
  generateAccountKey,
  generateIdentityKey,
  type KeyringEntry,
  openField,
  unsealContentKey,
  unwrapIdentityKey,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from "@liaison/mailbox-crypto/src/client"
import { signKeyringAttestation } from "@liaison/mailbox-crypto/src/keyring-attestation"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { errorHandler } from "~/middleware/error-handler"
import { sealForUser } from "~/modules/mailbox-crypto/seal-service"
import { mailboxKeysRoutes } from "~/modules/mailbox-keys/routes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const KEY_ID = 7
const SECRET = "The pangolin numbers are bad and the board already knows."
const MAILBOX_PASSWORD = "copper lantern orbit meadow 1987"

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

/** Decoded into a fresh, non-shared buffer, which is what `Bytes` requires. */
function bytes(base64: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(base64, "base64")
  const out = new Uint8Array(decoded.byteLength)
  out.set(decoded)
  return out
}

/** The seal service hands back plain `Uint8Array`s; the open path wants the
 *  narrower `Bytes`, and copying is the honest way to get there. */
function asBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.byteLength)
  out.set(value)
  return out
}

function appFor(user: minimal.Person): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", user.id)
    c.set("orgId", user.orgId)
    c.set("scopes", ["mail:*"] as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/mailbox-keys", mailboxKeysRoutes)
  app.onError(errorHandler)
  return app
}

interface ServerIdentity {
  keyId: number
  status: string
  ecdhPublicKey: string
  signPublicKey: string
  wrappedEcdhPrivate?: string | null
  wrappedSignPrivate?: string | null
  ecdhWrapIv?: string | null
  signWrapIv?: string | null
}

interface ServerWrap {
  id: string
  type: string
}

describe("SC10 -- a fresh browser profile restores the keyring from the server", () => {
  let user: minimal.Person
  let app: Hono<AppEnv>
  /** The ONLY thing that crosses from device A to device B. */
  let mailboxPassword: string
  let sealedBatch: Awaited<ReturnType<typeof sealForUser>>
  let shardId: string

  beforeAll(async () => {
    user = await minimal.person((await createTestOrg()).id)
    app = appFor(user)

    // ── Device A: enrol, then vanish ────────────────────────────────────────
    const accountKey = generateAccountKey()
    mailboxPassword = MAILBOX_PASSWORD
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const wrap = await wrapWithPassphrase({
      accountKey,
      passphrase: mailboxPassword,
      salt,
      userId: user.id,
    })
    const { entry, privateKeys } = await generateIdentityKey({
      accountKey,
      userId: user.id,
      keyId: KEY_ID,
    })
    // The enrolment self-attests, as the client does: the new identity's own
    // signing key signs the one-entry keyring.
    const attestation = await signKeyringAttestation({
      signPrivateKey: privateKeys.signPrivate,
      userId: user.id,
      identities: [
        { keyId: KEY_ID, status: "active", ecdhSpki: entry.ecdhSpki, signSpki: entry.signSpki },
      ],
    })

    const res = await app.request("/api/mailbox-keys/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ecdhPublicKey: b64(entry.ecdhSpki),
        signPublicKey: b64(entry.signSpki),
        keyId: KEY_ID,
        attestation: b64(attestation),
        wrappedEcdhPrivate: b64(entry.wrappedEcdhPrivate),
        wrappedSignPrivate: b64(entry.wrappedSignPrivate),
        ecdhWrapIv: b64(entry.ecdhWrapIv),
        signWrapIv: b64(entry.signWrapIv),
        wraps: [
          {
            wrapType: "passphrase",
            label: "Mailbox password",
            wrappedAccountKey: b64(wrap.wrappedAccountKey),
            // The row names its KDF: the server stores and serves this object
            // as it is, and device B's unlock reads the KDF back from it.
            kdfParams: {
              salt: b64(salt),
              kdf: wrap.kdfParams.kdf,
              iterations: wrap.kdfParams.iterations,
            },
          },
        ],
      }),
    })
    expect(res.status).toBe(201)

    // The server seals a message for this user, exactly as inbound mail does.
    shardId = `fresh-profile:${user.id}`
    sealedBatch = await sealForUser(user.id, user.orgId, [
      { context: { kind: "index", entityId: shardId, shardId }, plaintext: SECRET },
    ])

    // Device A is now gone: `accountKey`, `entry` and `wrap` leave this scope
    // and nothing below reads them. `mailboxPassword` is what the human knows.
  }, 120_000)

  test("the server returns the wrapped private halves it was given at enrolment", async () => {
    const res = await app.request("/api/mailbox-keys/me")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { identities: ServerIdentity[] } }
    const identity = body.data.identities.find((i) => i.keyId === KEY_ID)
    expect(identity).toBeDefined()
    // Without these four the mailbox password cannot rebuild anything, so an
    // absent field here IS the permanent data loss, not a cosmetic omission.
    expect(identity?.wrappedEcdhPrivate).toBeTruthy()
    expect(identity?.wrappedSignPrivate).toBeTruthy()
    expect(identity?.ecdhWrapIv).toBeTruthy()
    expect(identity?.signWrapIv).toBeTruthy()
    // They are ciphertext, not the public halves under another name.
    expect(identity?.wrappedEcdhPrivate).not.toBe(identity?.ecdhPublicKey)
    expect(identity?.wrappedSignPrivate).not.toBe(identity?.signPublicKey)
  })

  test("a device with no local state opens sealed mail using only the mailbox password", async () => {
    // Everything this test uses comes from the two owner-only REST reads plus
    // the password. There is deliberately no reference to device A's variables.
    const meRes = await app.request("/api/mailbox-keys/me")
    const me = (await meRes.json()) as {
      data: { identities: ServerIdentity[]; wraps: ServerWrap[] }
    }
    const identity = me.data.identities.find((i) => i.keyId === KEY_ID)
    if (!identity) throw new Error("the server returned no identity for this key id")
    const wrapRow = me.data.wraps.find((w) => w.type === "passphrase")
    if (!wrapRow) throw new Error("the server returned no mailbox password wrap")

    const blobRes = await app.request(`/api/mailbox-keys/wraps/${wrapRow.id}/blob`)
    expect(blobRes.status).toBe(200)
    const blob = (await blobRes.json()) as {
      data: {
        wrappedAccountKey: string
        kdfParams: { salt: string; kdf?: "pbkdf2-sha256"; iterations?: number }
      }
    }
    expect(blob.data.kdfParams.kdf).toBe("pbkdf2-sha256")
    expect(blob.data.kdfParams.iterations).toBe(600_000)

    const accountKey = await unwrapWithPassphrase({
      wrap: {
        wrapType: "passphrase",
        wrappedAccountKey: bytes(blob.data.wrappedAccountKey),
        kdfParams: {
          salt: bytes(blob.data.kdfParams.salt),
          kdf: blob.data.kdfParams.kdf,
          iterations: blob.data.kdfParams.iterations,
        },
      },
      passphrase: mailboxPassword,
      userId: user.id,
    })

    const rebuilt: KeyringEntry = {
      keyId: identity.keyId,
      status: identity.status as "active",
      ecdhSpki: bytes(identity.ecdhPublicKey),
      signSpki: bytes(identity.signPublicKey),
      wrappedEcdhPrivate: bytes(identity.wrappedEcdhPrivate as string),
      wrappedSignPrivate: bytes(identity.wrappedSignPrivate as string),
      ecdhWrapIv: bytes(identity.ecdhWrapIv as string),
      signWrapIv: bytes(identity.signWrapIv as string),
    }
    const privateKeys = await unwrapIdentityKey({ accountKey, userId: user.id, entry: rebuilt })

    const contentKey = await unsealContentKey({
      privateKey: privateKeys.ecdhPrivate,
      recipientEcdhSpki: rebuilt.ecdhSpki,
      userId: user.id,
      keyId: KEY_ID,
      wrapped: asBytes(sealedBatch.contentKeyWrapped),
      epkSpki: asBytes(sealedBatch.contentKeyEpk),
    })
    const opened = await openField({
      contentKey,
      context: mailboxAad.index(user.id, shardId),
      blob: asBytes(sealedBatch.items[0]?.ciphertext as Uint8Array),
    })
    expect(new TextDecoder().decode(opened)).toBe(SECRET)
  }, 120_000)
})
