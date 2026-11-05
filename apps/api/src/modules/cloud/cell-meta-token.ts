// SPDX-License-Identifier: FSL-1.1-ALv2
// The server-level Meta callback (managed edition): its path and the verify token
// Meta's hub.challenge handshake presents. The token is derived from the instance
// Meta app secret, so the server holds no second secret and every process agrees.
import { createHmac } from "node:crypto"

export const CELL_GMAIL_PUSH_PATH = "/webhooks/_cell/gmail-push"
export const CELL_META_PATH = "/webhooks/_cell/meta"

/** The handshake token for the server's Meta callback (hex, safe to reflect in a URL). */
export function cellMetaVerifyToken(metaAppSecret: string): string {
  return createHmac("sha256", metaAppSecret).update("liaison:cell-meta-verify-token").digest("hex")
}
