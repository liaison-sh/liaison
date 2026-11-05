// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * The largest attachment the owner's browser opens for the agent in one answer, decoded: the
 * client's cap (`ATTACHMENT_OPEN_MAX_BYTES`, apps/web attachment-opener.ts) and the server's
 * check on what it receives (mail-attachment-read.ts) are the same number.
 */
export const MAILBOX_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/**
 * The largest body a browser may post as its answer to a mailbox request
 * (POST /api/agent/mailbox-plaintext/:id and /mailbox-search/:id). An answer
 * carries the decrypted subject, text, HTML and quoted bodies of up to 25
 * messages, or the bytes of an attachment, base64. The generic 1 MiB API body
 * cap refused a ten-message read with full bodies (413, before the route ran),
 * and the agent was told the mailbox was locked. It fits the larger of a full
 * 25-message read (26 MiB, the make-transparent upload's ceiling) and one
 * attachment at its cap once base64 encoded, plus room for the envelope.
 */
export const MAILBOX_ANSWER_BODY_MAX_BYTES = Math.max(
  26 * 1024 * 1024,
  Math.ceil(MAILBOX_ATTACHMENT_MAX_BYTES / 3) * 4 + 1024 * 1024,
)
