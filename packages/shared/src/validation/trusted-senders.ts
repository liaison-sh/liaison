// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Trusted senders: an address, or a whole domain, that staff marked as trusted for their org.
// A trusted sender whose mail arrives without a provider verdict counts as verified for the
// inbound rules (acknowledgement, desk routing, adding participants), and a trusted address or
// domain counts as a known guest for calendar invitations. A public mail provider's domain is
// shared with the whole world, so it is never trusted at domain level: only single addresses
// there.
import { z } from "zod"

/** Public mailbox providers: anyone can hold an address on these domains. */
export const PUBLIC_EMAIL_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.fr",
  "live.com",
  "live.fr",
  "msn.com",
  "yahoo.com",
  "yahoo.fr",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "web.de",
  "mail.com",
  "fastmail.com",
  "hey.com",
  "yandex.com",
  "qq.com",
  "163.com",
  "orange.fr",
  "free.fr",
  "wanadoo.fr",
  "sfr.fr",
  "laposte.net",
])

export function isPublicEmailProvider(domain: string | null | undefined): boolean {
  return !!domain && PUBLIC_EMAIL_PROVIDERS.has(domain.trim().toLowerCase())
}

/** The domain of an address, lower-cased, or null. */
export function emailDomainOf(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf("@") ?? -1
  if (!email || at < 0) return null
  const d = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return d || null
}

export type TrustedSenderKind = "address" | "domain"

const ADDRESS = /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

/** Body of `POST /api/contacts/trusted-senders`. */
export const trustedSenderCreateSchema = z
  .strictObject({
    kind: z.enum(["address", "domain"]),
    value: z
      .string()
      .trim()
      .toLowerCase()
      .transform((v) => v.replace(/^@/, "")),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "address" && !ADDRESS.test(v.value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "an email address" })
    }
    if (v.kind === "domain") {
      if (!DOMAIN.test(v.value)) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "a domain such as example.com" })
      } else if (isPublicEmailProvider(v.value)) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "a public mail provider's domain cannot be trusted; trust single addresses",
        })
      }
    }
  })

export type TrustedSenderCreate = z.infer<typeof trustedSenderCreateSchema>

export interface TrustedSender {
  id: string
  kind: TrustedSenderKind
  value: string
  createdBy: string | null
  createdAt: string
}
