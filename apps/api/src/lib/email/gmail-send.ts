// SPDX-License-Identifier: FSL-1.1-ALv2
export type GmailSendCtx = {
  connections_getToken(connectionName: string, identifier?: string): Promise<string>
  fetch?: typeof fetch
}

export type GmailSendOptions = {
  onDispatch?: () => void
}

export type GmailSendResult = {
  providerId?: string
  messageId?: string
  threadId?: string
  /**
   * The RFC822 `Message-ID` Gmail actually stamped on the delivered mail.
   *
   * This is NOT `messageId`/`providerId`: those are Gmail's INTERNAL message id
   * (`body.id`), which never appears in any mail header and so can never match a
   * synced copy. Gmail rewrites the `Message-ID` we set at render time, so the
   * only way to learn the delivered value is to read it back.
   *
   * Why it matters: the ticket mailbox sync lists the WHOLE mailbox (no
   * `in:inbox` filter, by design) and therefore re-ingests our own Sent copy as
   * an `outbound` message. Its only dedupe key is an exact `external_message_id`
   * match, so persisting our synthetic `<tkt-…@example.com>` guaranteed a miss
   * and every outbound reply was stored twice (prod, org-wide, from 2026-07-27).
   *
   * Best-effort: a failure here degrades to the synthetic id, it never fails a
   * send that already succeeded. The ingest-side body-hash dedupe is the second
   * layer that covers that degraded case and the SMTP path.
   */
  rfc822MessageId?: string
}

export class GmailSendError extends Error {
  readonly code: string
  readonly status: number
  readonly providerRejected: boolean
  readonly deliveryState?: "rejected" | "unknown"
  readonly body: unknown

  constructor(opts: {
    code?: string
    message: string
    status: number
    body?: unknown
    providerRejected?: boolean
    deliveryState?: "rejected" | "unknown"
  }) {
    super(opts.message)
    this.code = opts.code ?? "GMAIL_SEND_FAILED"
    this.status = opts.status
    this.body = opts.body ?? null
    this.providerRejected = opts.providerRejected ?? (opts.status >= 400 && opts.status < 500)
    this.deliveryState = opts.deliveryState
  }
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

export async function sendViaGmail(
  ctx: GmailSendCtx,
  accountEmail: string,
  rfc2822: string,
  threadId?: string,
  opts?: GmailSendOptions,
): Promise<GmailSendResult> {
  const token = await ctx.connections_getToken("gmail", accountEmail)
  const raw = encodeBase64Url(rfc2822)
  opts?.onDispatch?.()

  const httpFetch = ctx.fetch ?? fetch
  const configuredBase =
    process.env.TICKETS_E2E_GMAIL_API_BASE_URL ?? "https://gmail.googleapis.com"
  const baseUrl = configuredBase.replace(/\/gmail\/v1\/?$/, "")
  const response = await httpFetch(`${baseUrl}/gmail/v1/users/me/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Test-Account": accountEmail,
    },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  })
  const text = await response.text()
  if (!response.ok) {
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text || null
    }
    const status = response.status
    const providerRejected = status >= 400 && status < 500
    throw new GmailSendError({
      message: `Gmail send failed with status ${status}`,
      status,
      body,
      providerRejected,
      deliveryState: providerRejected ? "rejected" : undefined,
    })
  }
  let body: { id?: string; threadId?: string } = {}
  try {
    body = text ? (JSON.parse(text) as { id?: string; threadId?: string }) : {}
  } catch {
    body = {}
  }
  const rfc822MessageId = body.id
    ? await readDeliveredMessageId(httpFetch, baseUrl, token, accountEmail, body.id)
    : undefined
  return {
    providerId: body.id,
    messageId: body.id,
    threadId: body.threadId,
    rfc822MessageId,
  }
}

/**
 * Read back the `Message-ID` header Gmail stamped on a message we just sent.
 * See {@link GmailSendResult.rfc822MessageId} for why this round-trip exists.
 *
 * Deliberately total: ANY failure (network, permission, unexpected shape) returns
 * undefined so the caller falls back to the synthetic id. The send has already
 * succeeded at this point and must never be reported as failed because a
 * best-effort metadata read did not come back.
 */
async function readDeliveredMessageId(
  httpFetch: typeof fetch,
  baseUrl: string,
  token: string,
  accountEmail: string,
  gmailMessageId: string,
): Promise<string | undefined> {
  try {
    const url = `${baseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(
      gmailMessageId,
    )}?format=metadata&metadataHeaders=Message-ID`
    const res = await httpFetch(url, {
      headers: { Authorization: `Bearer ${token}`, "X-Test-Account": accountEmail },
    })
    if (!res.ok) return undefined
    const parsed = (await res.json()) as {
      payload?: { headers?: Array<{ name?: string; value?: string }> }
    }
    const header = parsed.payload?.headers?.find((h) => h.name?.toLowerCase() === "message-id")
    const value = header?.value?.trim()
    return value && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}
