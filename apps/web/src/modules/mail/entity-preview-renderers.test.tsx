// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail conversation hover preview. A sealed conversation's subject is
// ciphertext the preview cannot open, so it must read "Locked", never
// "(No subject)", which would be a false statement about the mail.
import { fireEvent, render } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it } from "vitest"
import { registerEntityPreviews } from "~/modules/mail/entity-preview-renderers"
import { createMailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealConversationFixture,
  TEST_USER_ID,
} from "~/modules/mailbox/mailbox-fixtures"
import { resetMailboxStore, setMailboxCryptoClient } from "~/modules/mailbox/mailbox-store"
import {
  entityPreviewRegistry,
  getEntityPreviewRenderer,
} from "~/modules/shell/entity-preview/registry"

beforeEach(() => {
  entityPreviewRegistry.clear()
  registerEntityPreviews()
  resetMailboxStore()
})

const PASSWORD = "correct horse battery staple 42"
const SEALED_ID = "66666666-6666-4666-8666-666666666666"

function inProcessClient() {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  return createMailboxCryptoClient({ post: (request) => handleWorkerRequest(session, request) })
}

/** `/mail/conversations/:id?messageLimit=0` as the API projects a sealed conversation. */
async function sealedDetail() {
  const enrollment = await buildEnrollment({ passphrase: PASSWORD })
  const sealed = await sealConversationFixture(enrollment, {
    id: SEALED_ID,
    subject: "Contract renewal",
    snippet: "Signed copy attached",
  })
  const conversation = { ...sealed, subject: null, snippet: null, messageCount: 1 }
  const api = {
    getEnvelope: async () => ({ data: { conversation, messages: [] } }),
  } as never
  return { enrollment, api }
}

describe("mail conversation preview", () => {
  it("shows Locked for a sealed conversation and (No subject) only for a real empty one", () => {
    const renderer = getEntityPreviewRenderer("mail", "conversation")
    if (!renderer) throw new Error("the mail preview is not registered")
    const sealed = render(() =>
      renderer.render({ subject: null, snippet: null, messageCount: 2, encVersion: 1 } as never),
    )
    expect(sealed.container.textContent).toContain("Locked")
    expect(sealed.container.textContent).not.toMatch(/no subject/i)
    sealed.unmount()

    const plain = render(() =>
      renderer.render({ subject: null, snippet: null, messageCount: 1, encVersion: 0 } as never),
    )
    expect(plain.container.textContent).toMatch(/no subject/i)
  })

  it("opens a sealed conversation through the mailbox when it is unlocked", async () => {
    const renderer = getEntityPreviewRenderer("mail", "conversation")
    if (!renderer) throw new Error("the mail preview is not registered")
    const { enrollment, api } = await sealedDetail()
    const client = inProcessClient()
    await client.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: PASSWORD,
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    setMailboxCryptoClient(client)

    const data = await renderer.fetch(SEALED_ID, api)
    const view = render(() => renderer.render(data))
    expect(view.container.textContent).toContain("Contract renewal")
    expect(view.container.textContent).toContain("Signed copy attached")
    expect(view.container.textContent).not.toMatch(/locked/i)
  })

  it("a sealed conversation on a locked mailbox says how to unlock", async () => {
    const renderer = getEntityPreviewRenderer("mail", "conversation")
    if (!renderer) throw new Error("the mail preview is not registered")
    const { api } = await sealedDetail()
    setMailboxCryptoClient(inProcessClient())

    const data = await renderer.fetch(SEALED_ID, api)
    const view = render(() => renderer.render(data))
    expect(view.container.textContent).toContain("Locked")
    const requests: unknown[] = []
    const listener = (event: Event) => requests.push((event as CustomEvent).detail)
    window.addEventListener("mailbox:unlock-requested", listener)
    try {
      fireEvent.click(view.getByTestId("mail-preview-unlock"))
    } finally {
      window.removeEventListener("mailbox:unlock-requested", listener)
    }
    expect(requests).toEqual([{ view: "unlock" }])
  })
})
