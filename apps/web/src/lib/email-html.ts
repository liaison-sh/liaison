// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * Email HTML shown inside the app (a ticket message, an approval card's
 * preview): lists, links and quotes read as such, a line apart from the text
 * around them. The app's reset strips all of it. A ticket message keeps the
 * email's inline styles (the API's agent sanitizer allows them), but the
 * preview goes through the mail sanitizer, which strips every `;` from an
 * inline style: one of several declarations runs together and is ignored.
 */
export const EMAIL_HTML_CLASS =
  "[&_a]:text-accent [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"

/**
 * Flattens nested quote indentation: only the first blockquote level keeps
 * its rail and indent. A long chain otherwise nests one rail per earlier email
 * and squeezes the oldest text into a sliver at the right edge.
 */
export const FLAT_QUOTES_CLASS =
  "[&_blockquote_blockquote]:my-0 [&_blockquote_blockquote]:ml-0 [&_blockquote_blockquote]:border-l-0 [&_blockquote_blockquote]:pl-0"
