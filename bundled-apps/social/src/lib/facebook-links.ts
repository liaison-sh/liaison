// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Facebook web links built from Graph ids, for when Graph omits `permalink_url`
// (it does on some comment objects, and then on their post too). Graph ids are
// numeric parts joined by "_": a Page post is `<pageId>_<postId>`, a comment
// `<postId>_<commentId>`. Anything else returns null rather than a guess, so a
// built link is always a well-formed https URL made of digits only.

const FB_WEB = "https://www.facebook.com"
const NUMERIC = /^\d+$/

function parts(id: string | null | undefined): string[] | null {
  if (typeof id !== "string" || id === "") return null
  const p = id.split("_")
  return p.every((s) => NUMERIC.test(s)) ? p : null
}

/** The web URL of a Page post (`<pageId>_<postId>`, or a bare post id). */
export function facebookPostUrl(postId: string | null | undefined): string | null {
  const p = parts(postId)
  if (!p) return null
  if (p.length === 1) return `${FB_WEB}/${p[0]}`
  if (p.length === 2) return `${FB_WEB}/${p[0]}/posts/${p[1]}`
  return null
}

/**
 * The web URL of a comment: its post's URL with `comment_id`. The post comes
 * from `postId` when given, else from the comment id's own post part.
 */
export function facebookCommentUrl(
  commentId: string | null | undefined,
  postId?: string | null,
): string | null {
  const c = parts(commentId)
  if (!c || c.length > 2) return null
  const comment = c[c.length - 1]
  const post = facebookPostUrl(postId) ?? (c.length === 2 ? facebookPostUrl(c[0]) : null)
  return post ? `${post}?comment_id=${comment}` : null
}
