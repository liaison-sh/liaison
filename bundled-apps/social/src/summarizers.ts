// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated-tool approval summarizers. Pure: params plus the `meta.context` the
// kernel hydrates from the manifest's `summarizerContext` read (findings_get /
// dm_get), which may be null; every summary degrades to the params alone.
// Re-exported from handlers.ts so the bundle exposes them by name.

import { facebookCommentUrl, facebookPostUrl } from "./lib/facebook-links"

interface SummarizerMeta {
  connectionIdentifier: string | null
  context: unknown
}

interface SummaryLink {
  label: string
  url: string
}

interface SummaryShape {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
  links?: SummaryLink[]
}

const PLATFORM: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  x: "X",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

function clip(s: string, n = 180): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function platformName(v: unknown): string | null {
  const p = str(v)
  return p ? (PLATFORM[p.toLowerCase()] ?? p) : null
}

function record(v: unknown, key: string): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null
  const inner = (v as Record<string, unknown>)[key]
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null
}

function handle(v: unknown): string | null {
  const h = str(v)
  return h ? (h.startsWith("@") ? h : `@${h}`) : null
}

/**
 * Outside text quoted in a summary line, fenced as untrusted. The lines go back
 * to the agent in the gated call's result and to MCP clients, so a third
 * party's words stay inside the same `<external-content>` fence findings_get
 * puts them in (reads.ts `wrapExternalContent`); the approval card shows the
 * inner text as a quote, without the tags. Text that arrives fenced is clipped
 * inside its fence; text that arrives bare is fenced here, any fence tag in it
 * escaped so it cannot close the fence.
 */
function fencedQuote(v: unknown, n = 180): string | null {
  const s = str(v)
  if (!s) return null
  const m = /^<external-content source="untrusted">\n([\s\S]*)\n<\/external-content>$/.exec(s)
  const inner = str(m ? m[1] : s)
  if (!inner) return null
  const safe = inner.replace(/<(\s*\/?\s*external-content)/gi, "&lt;$1")
  return `<external-content source="untrusted">\n${clip(safe, n)}\n</external-content>`
}

/**
 * The hosts the adapters link to (Facebook, Instagram, YouTube web, their
 * mobile hosts). A permalink elsewhere is dropped: the card links a reviewer
 * only to the platform the finding came from.
 */
const LINK_HOSTS = new Set(
  ["facebook.com", "instagram.com", "youtube.com"].flatMap((h) => [h, `www.${h}`, `m.${h}`]),
)

/** An external link the approval summary accepts: https, a platform host, at most 500 chars. */
function httpsUrl(v: unknown): string | null {
  const u = str(v)
  if (!u || u.length > 500 || /\s/.test(u)) return null
  // The authority is a bare host name: no user info, no port (parsed by hand,
  // the sandbox the bundle runs in may lack `URL`).
  const host = /^https:\/\/([a-z0-9.-]+)(?:[/?#]|$)/i.exec(u)?.[1]
  return host && LINK_HOSTS.has(host.toLowerCase()) ? u : null
}

/**
 * Where the finding lives at its source: the comment's own permalink, else its
 * post's, else (Facebook, when Graph omitted both) a link built from the ids.
 */
function findingLink(
  finding: Record<string, unknown> | null,
  platform: string | null,
): SummaryLink | null {
  if (!finding) return null
  const where = platform ?? "the source"
  const own = httpsUrl(finding.permalink)
  if (own) return { label: `Open on ${where}`, url: own }
  const post = httpsUrl(record(finding, "metadata")?.postPermalink)
  if (post) return { label: `Open the post on ${where}`, url: post }
  if (str(finding.platform)?.toLowerCase() === "facebook") {
    const id = str(finding.external_id)
    const parent = str(finding.parent_external_id)
    const built = httpsUrl(
      finding.relation === "comment_on_our_content" || parent
        ? facebookCommentUrl(id, parent)
        : facebookPostUrl(id),
    )
    if (built) return { label: "Open on Facebook", url: built }
  }
  return null
}

/** social:reply_to_finding: a public reply under someone's post or comment. */
export function summarizeReplyToFinding(
  params: { finding_id?: string; reply_text?: string },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<SummaryShape> {
  const finding = record(meta?.context, "finding")
  const author = handle(finding?.author_handle)
  const platform = platformName(finding?.platform)
  const reply = str(params.reply_text)
  const comment = fencedQuote(finding?.content_text)
  const postExcerpt = fencedQuote(record(finding, "metadata")?.postExcerpt, 120)
  const link = findingLink(finding, platform)
  return Promise.resolve({
    kind: "social.reply_to_finding",
    title: author ? `Reply publicly to ${author}` : "Reply publicly to a social post",
    ...(platform ? { subtitle: `On ${platform}` } : {}),
    lines: [
      ...(comment ? [`${author ? `${author} wrote` : "They wrote"}: ${comment}`] : []),
      ...(postExcerpt ? [`Under the post: ${postExcerpt}`] : []),
      ...(reply ? [`Reply: ${clip(reply)}`] : []),
      "Posted publicly under their post or comment.",
    ],
    ...(link ? { links: [link] } : {}),
  })
}

/** social:send_dm: a direct message in an existing conversation. */
export function summarizeSendDm(
  params: { conversation_id?: string; body?: string },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<SummaryShape> {
  const conversation = record(meta?.context, "conversation")
  const who =
    str(conversation?.participant_display_name) ?? handle(conversation?.participant_handle)
  const platform = platformName(conversation?.platform)
  const body = str(params.body)
  return Promise.resolve({
    kind: "social.send_dm",
    title: who ? `Send a direct message to ${who}` : "Send a direct message",
    ...(platform ? { subtitle: `On ${platform}` } : {}),
    lines: body ? [`Message: ${clip(body)}`] : [],
  })
}

/** social:like_item: a like on someone's post or comment, from the brand account. */
export function summarizeLikeItem(
  _params: { finding_id?: string },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<SummaryShape> {
  const finding = record(meta?.context, "finding")
  const author = handle(finding?.author_handle)
  const platform = platformName(finding?.platform)
  return Promise.resolve({
    kind: "social.like_item",
    title: author ? `Like ${author}'s post` : "Like a social post",
    ...(platform ? { subtitle: `On ${platform}` } : {}),
    lines: ["Liked publicly from the connected brand account."],
  })
}
