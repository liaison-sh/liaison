// SPDX-License-Identifier: FSL-1.1-ALv2
import { simpleParser } from "mailparser"
import {
  encodeAddressString,
  encodeHeaderValue,
  formatMailbox,
  sanitizeHeaderValue,
} from "./header-encoding"
import type {
  EmailAddress,
  OutboundEmailAttachment,
  ParsedAttachment,
  ParsedEmail,
  StructuredEmail,
} from "./types"

function formatAddress(addr: EmailAddress | string): string {
  if (typeof addr === "string") return encodeAddressString(addr)
  return formatMailbox(addr.name, addr.email)
}

function formatAddresses(addrs: Array<EmailAddress | string>): string {
  return addrs.map(formatAddress).join(", ")
}

function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`
  // RFC 2047 encoded values arrive already folded (CRLF + space between
  // encoded words); sanitized values never contain CRLF otherwise.
  if (line.length <= 78 || value.includes("\r\n")) return line
  // Fold at whitespace under 78 chars per RFC 5322 §2.2.3.
  const words = line.split(" ")
  const folded: string[] = []
  let cur = ""
  for (const w of words) {
    if (cur.length === 0) {
      cur = w
      continue
    }
    if (cur.length + 1 + w.length > 78) {
      folded.push(cur)
      cur = `\t${w}`
    } else {
      cur = `${cur} ${w}`
    }
  }
  if (cur.length > 0) folded.push(cur)
  return folded.join("\r\n")
}

/** Escape a MIME header parameter (filename / name) — no CR/LF, no quotes. */
function escapeMimeParam(value: string): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/["\\]/g, "_")
    .trim()
}

/** True when every character is printable US-ASCII. */
function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value)
}

/** Percent-encode a UTF-8 string per RFC 2231 §7 (extended attribute value). */
function encodeRfc2231(value: string): string {
  return Array.from(Buffer.from(value, "utf-8"))
    .map((b) => {
      const c = String.fromCharCode(b)
      return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(c)
        ? c
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")
}

/**
 * Build the `filename` parameter(s) for a `Content-Disposition` header. An
 * ASCII filename uses the plain quoted form; a non-ASCII one (common from
 * inbound mail / Drive — and attacker-controllable) additionally emits an
 * RFC 2231 `filename*=UTF-8''…` form so conformant clients render it correctly,
 * with the plain quoted form kept as an ASCII fallback. `name` is assumed to
 * have already passed `escapeMimeParam` (no CR/LF, no quotes).
 */
function filenameParams(name: string): string {
  if (isAscii(name)) return `filename="${name}"`
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, "_")
  return `filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc2231(name)}`
}

/** Fold a base64 string at RFC 2045's 76-column limit. */
function foldBase64(base64: string): string {
  return base64.replace(/(.{76})/g, "$1\r\n")
}

/**
 * Build the body MIME entity (its own `Content-Type` header + content), with no
 * trailing blank line so it can be embedded after a `multipart/mixed` boundary
 * or used standalone.
 */
function buildBodyEntity(text: string, html: string): string[] {
  if (text.length > 0 && html.length > 0) {
    const alt = `----=_Liaison_alt_${Date.now()}_${Math.floor(Math.random() * 1e9)}`
    return [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
      `--${alt}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
      `--${alt}--`,
    ]
  }
  const isHtml = html.length > 0
  return [
    `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: 8bit",
    "",
    isHtml ? html : text,
  ]
}

/** Build one base64-encoded `multipart/mixed` attachment part. */
function buildAttachmentPart(att: OutboundEmailAttachment): string[] {
  const name = escapeMimeParam(att.filename || "attachment")
  const mime = escapeMimeParam(att.mimeType || "application/octet-stream")
  // The legacy `name=` parameter on Content-Type is ASCII-only; the
  // RFC 2231-aware filename lives on Content-Disposition (`filenameParams`).
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_")
  const lines = [`Content-Type: ${mime}; name="${asciiName}"`, "Content-Transfer-Encoding: base64"]
  if (att.disposition === "inline" && att.contentId) {
    lines.push(`Content-ID: <${escapeMimeParam(att.contentId)}>`)
    lines.push(`Content-Disposition: inline; ${filenameParams(name)}`)
  } else {
    lines.push(`Content-Disposition: attachment; ${filenameParams(name)}`)
  }
  lines.push("")
  lines.push(foldBase64(att.content ?? ""))
  return lines
}

export function toRfc2822(input: StructuredEmail): string {
  const html = input.html ?? ""
  const text = input.text ?? ""
  const headers: string[] = []

  headers.push(foldHeader("From", formatAddress(input.from)))
  headers.push(foldHeader("To", formatAddresses(input.to)))
  if (input.replyTo) headers.push(foldHeader("Reply-To", formatAddress(input.replyTo)))
  if (input.cc?.length) headers.push(foldHeader("Cc", formatAddresses(input.cc)))
  if (input.bcc?.length) headers.push(foldHeader("Bcc", formatAddresses(input.bcc)))
  headers.push(foldHeader("Subject", encodeHeaderValue(input.subject)))
  headers.push(foldHeader("Date", new Date().toUTCString()))
  headers.push("MIME-Version: 1.0")

  if (input.headers?.messageId) {
    headers.push(foldHeader("Message-ID", sanitizeHeaderValue(input.headers.messageId)))
  }
  if (input.headers?.inReplyTo) {
    headers.push(foldHeader("In-Reply-To", sanitizeHeaderValue(input.headers.inReplyTo)))
  }
  if (input.headers?.references?.length) {
    const refs = input.headers.references.map(sanitizeHeaderValue).filter(Boolean).join(" ")
    if (refs) headers.push(foldHeader("References", refs))
  }
  if (input.headers?.extra) {
    for (const [name, value] of Object.entries(input.headers.extra)) {
      if (!value) continue
      headers.push(foldHeader(name, sanitizeHeaderValue(value)))
    }
  }

  const lines: string[] = [...headers]
  const attachments = input.attachments ?? []

  // No attachments — body entity directly under the message headers.
  if (attachments.length === 0) {
    lines.push(...buildBodyEntity(text, html))
    lines.push("")
    return lines.join("\r\n")
  }

  // Attachments — wrap the body + attachment parts in multipart/mixed.
  const mix = `----=_Liaison_mix_${Date.now()}_${Math.floor(Math.random() * 1e9)}`
  lines.push(`Content-Type: multipart/mixed; boundary="${mix}"`)
  lines.push("")
  lines.push(`--${mix}`)
  lines.push(...buildBodyEntity(text, html))
  for (const att of attachments) {
    lines.push(`--${mix}`)
    lines.push(...buildAttachmentPart(att))
  }
  lines.push(`--${mix}--`)
  lines.push("")
  return lines.join("\r\n")
}

type ParsedAddressItem = { address?: string; name?: string; group?: ParsedAddressItem[] }

/** mailparser keeps RFC 5322 group syntax (`Team: a@x, b@y;`) as one item whose members sit in
 *  `group`; flatten so a group-form header still yields its real addresses. */
function flattenAddresses(value: unknown): ParsedAddressItem[] {
  const items = (value as { value?: ParsedAddressItem[] } | undefined)?.value ?? []
  return items.flatMap((item) => (item.group ? item.group : [item]))
}

function toAddress(value: unknown): EmailAddress | undefined {
  if (!value) return undefined
  const item = flattenAddresses(value).find((a) => Boolean(a.address))
  if (!item?.address) return undefined
  return { email: item.address.toLowerCase(), name: item.name?.trim() || undefined }
}

function toAddressList(value: unknown): EmailAddress[] | undefined {
  if (!value) return undefined
  const arr = flattenAddresses(value)
    .filter((a) => Boolean(a.address))
    .map((a) => ({ email: (a.address ?? "").toLowerCase(), name: a.name?.trim() || undefined }))
  return arr.length > 0 ? arr : undefined
}

export async function parseRfc2822(blob: string): Promise<ParsedEmail> {
  const parsed = await simpleParser(blob)
  const headersRecord: Record<string, string | string[]> = {}
  for (const [k, v] of parsed.headers.entries()) {
    if (typeof v === "string") headersRecord[k] = v
    else if (Array.isArray(v)) headersRecord[k] = v.map((x) => String(x))
    else if (v && typeof (v as { value?: unknown }).value === "string") {
      headersRecord[k] = (v as { value: string }).value
    } else {
      try {
        headersRecord[k] = JSON.stringify(v)
      } catch {
        headersRecord[k] = String(v)
      }
    }
  }
  const refs = parsed.references
  const referencesArr = Array.isArray(refs) ? refs : refs ? [refs] : undefined
  // Map MIME attachments so real inbound attachments are carried through ingest
  // instead of being silently dropped. mailparser exposes the decoded bytes as
  // a Buffer; we base64-encode them for the downstream attachment pipeline.
  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map((att) => {
    const rawCid = att.contentId ?? (att.cid ? `<${att.cid}>` : undefined)
    const disposition: "inline" | "attachment" =
      att.contentDisposition === "inline" || (Boolean(att.cid) && !att.contentDisposition)
        ? "inline"
        : "attachment"
    return {
      filename: att.filename || "attachment",
      mimeType: att.contentType || "application/octet-stream",
      sizeBytes: typeof att.size === "number" ? att.size : undefined,
      bytesBase64: Buffer.isBuffer(att.content)
        ? att.content.toString("base64")
        : Buffer.from(att.content as unknown as Uint8Array).toString("base64"),
      disposition,
      contentId: att.cid ? att.cid.replace(/^<|>$/g, "") : undefined,
      originalContentId: rawCid,
    }
  })
  const sentAt =
    parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : undefined
  // `headerLines` keeps every header in wire order (the topmost is the one the
  // receiving server added last); the keyed map above collapses repeats.
  const headerValues = (name: string): string[] =>
    (parsed.headerLines ?? [])
      .filter((l) => l.key.toLowerCase() === name)
      .map((l) =>
        l.line
          .slice(l.line.indexOf(":") + 1)
          .replace(/\r?\n\s+/g, " ")
          .trim(),
      )
  const authenticationResults = headerValues("authentication-results")
  const deliveredTo = headerValues("delivered-to")
  return {
    messageId: parsed.messageId,
    from: toAddress(parsed.from),
    to: toAddressList(parsed.to),
    cc: toAddressList(parsed.cc),
    subject: parsed.subject,
    textBody: typeof parsed.text === "string" ? parsed.text : undefined,
    htmlBody: typeof parsed.html === "string" ? parsed.html : undefined,
    inReplyTo: parsed.inReplyTo ?? null,
    references: referencesArr,
    sentAt,
    headers: headersRecord,
    authenticationResults: authenticationResults.length > 0 ? authenticationResults : undefined,
    deliveredTo: deliveredTo.length > 0 ? deliveredTo : undefined,
    receivedVia: "imap",
    raw: blob,
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}
