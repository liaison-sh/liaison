// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import { hostInWhitelist } from "~/modules/agent/media/media-analysis-shared"

/**
 * Pure URL scanner for the inbound transfer-link auto-downloader. Extracts URLs
 * from a message body whose host is on the whitelist, dedups them, and hashes
 * each so the enqueue jobId is stable per (messageId, urlHash).
 */

export interface ScannedLink {
  url: string
  urlHash: string
}

// Match http(s) URLs; stop at whitespace, quotes, or angle brackets.
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

export function extractWhitelistedTransferLinks(body: string, whitelist: string[]): ScannedLink[] {
  if (!body) return []
  const seen = new Set<string>()
  const out: ScannedLink[] = []
  const matches = body.match(URL_RE) ?? []
  for (const raw of matches) {
    // Strip trailing punctuation that commonly clings to URLs in prose.
    const url = raw.replace(/[.,;:]+$/, "")
    const host = hostOf(url)
    if (!host || !hostInWhitelist(host, whitelist)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ url, urlHash: createHash("sha256").update(url).digest("hex").slice(0, 16) })
  }
  return out
}
