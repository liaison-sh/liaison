// SPDX-License-Identifier: FSL-1.1-ALv2
/** Validate a returnTo URL to prevent open redirect attacks.
 * Only allows relative paths starting with "/" (not "//" or "/\").
 */
export function safeReturnTo(value: string | undefined): string {
  if (!value?.startsWith("/")) return "/"
  if (/^\/[/\\]/.test(value)) return "/"
  if (value.includes("://")) return "/"
  return value
}
