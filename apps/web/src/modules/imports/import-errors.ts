// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An import refusal as a sentence in the person's language: the server's
// error code (or, without one, its HTTP status) picks the key; the server's
// own English text is never shown.

import { ApiError } from "~/lib/api-error"
import type { Translate } from "~/modules/i18n/i18n-context"
import { ImportUploadInterruptedError } from "./upload-client"

const CODES = new Set([
  "forbidden",
  "locked",
  "not_final",
  "already_undone",
  "not_found",
  "unknown_kind",
  "invalid_request",
  "invalid_source",
  "file_not_found",
  "transform_not_found",
  "invalid_transform",
  "invalid_transform_source",
  "transform_version_mismatch",
  "too_many_refused",
])

const BY_STATUS: Record<number, string> = {
  403: "forbidden",
  404: "not_found",
  409: "locked",
  429: "rate_limited",
}

/** The translated reason, or `fallbackKey` for anything unrecognised. */
export function importErrorText(t: Translate, err: unknown, fallbackKey: string): string {
  if (err instanceof ImportUploadInterruptedError)
    return t("kernel.imports.errors.upload_interrupted")
  if (err instanceof ApiError) {
    const code = err.code && CODES.has(err.code) ? err.code : BY_STATUS[err.status]
    if (code) return t(`kernel.imports.errors.${code}`)
  }
  return t(fallbackKey)
}
