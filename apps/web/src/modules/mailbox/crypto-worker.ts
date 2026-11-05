// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The crypto Web Worker entry. This file, and only this file, is what the page
// boots through the integrity check in `worker-integrity.ts`.
//
// It creates one session and pumps the protocol. All key material lives here;
// nothing it posts back is a key.

import { createIndexedDbKeyStore } from "@liaison/mailbox-crypto/src/client"
import type { WorkerRequest } from "~/modules/mailbox/crypto-protocol"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"

const session = createMailboxSession({ keyStore: createIndexedDbKeyStore() })

// The idle wipe has to happen even when the page has gone quiet, so it is a
// timer here rather than a check on the next request.
const IDLE_SWEEP_MS = 30_000
setInterval(() => {
  void session.expireIfIdle()
}, IDLE_SWEEP_MS)

self.addEventListener("message", (event: MessageEvent) => {
  const request = event.data as WorkerRequest
  void handleWorkerRequest(session, request).then((response) => {
    ;(self as unknown as { postMessage(value: unknown): void }).postMessage(response)
  })
})
