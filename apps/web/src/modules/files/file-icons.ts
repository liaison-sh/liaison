// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ShippedLocale } from "@liaison/shared"
import {
  FileArchive,
  FileAudio,
  FileCode,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Presentation,
} from "lucide-solid"
import type { Component } from "solid-js"
import { currentLocale, translatorFor } from "~/modules/i18n/i18n-context"

/**
 * Shared filetype-icon resolution. Used by both `FileList` (entity-level shelf)
 * and the message-level `AttachmentCard`. Kept here so both surfaces render
 * identical iconography and tone for the same file.
 */

export interface FileIconChoice {
  kind: string
  icon: Component<{ size?: number; class?: string }>
}

export function fileIsImage(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/")
}

export function fileExtension(filename: string): string {
  const parts = filename.toLowerCase().split(".")
  return parts.length > 1 ? (parts.at(-1) ?? "") : ""
}

export function iconFor(filename: string, mimeType: string): FileIconChoice {
  const mime = mimeType.toLowerCase()
  const ext = fileExtension(filename)
  if (mime.startsWith("image/")) return { kind: "image", icon: FileImage }
  if (mime.startsWith("video/")) return { kind: "video", icon: FileVideo }
  if (mime.startsWith("audio/")) return { kind: "audio", icon: FileAudio }
  if (mime === "application/pdf" || ext === "pdf") return { kind: "pdf", icon: FileText }
  if (
    mime.includes("wordprocessingml") ||
    mime === "application/msword" ||
    ["doc", "docx", "rtf"].includes(ext)
  ) {
    return { kind: "document", icon: FileText }
  }
  if (
    mime.includes("spreadsheetml") ||
    mime.includes("excel") ||
    mime === "text/csv" ||
    ["csv", "xls", "xlsx"].includes(ext)
  ) {
    return { kind: "spreadsheet", icon: FileSpreadsheet }
  }
  if (mime.includes("presentationml") || ["ppt", "pptx", "key"].includes(ext)) {
    return { kind: "presentation", icon: Presentation }
  }
  if (
    mime.includes("zip") ||
    mime.includes("tar") ||
    mime.includes("gzip") ||
    ["7z", "gz", "rar", "tar", "tgz", "zip"].includes(ext)
  ) {
    return { kind: "archive", icon: FileArchive }
  }
  if (
    mime.includes("json") ||
    mime.includes("xml") ||
    ["css", "html", "js", "json", "md", "tsx", "ts", "xml", "yaml", "yml"].includes(ext)
  ) {
    return { kind: "code", icon: FileCode }
  }
  if (mime.startsWith("text/")) return { kind: "text", icon: FileType }
  return { kind: "file", icon: FileIcon }
}

export function iconTone(kind: string): string {
  switch (kind) {
    case "image":
      return "text-sky-300"
    case "video":
      return "text-violet-300"
    case "audio":
      return "text-fuchsia-300"
    case "pdf":
      return "text-red-300"
    case "document":
      return "text-blue-300"
    case "spreadsheet":
      return "text-emerald-300"
    case "presentation":
      return "text-orange-300"
    case "archive":
      return "text-amber-300"
    case "code":
      return "text-teal-300"
    default:
      return "text-text-tertiary"
  }
}

// Catalog keys of the units (kernel.bytes.*): "KB" in English, "Ko" in French.
const UNIT_KEYS = ["b", "kb", "mb", "gb", "tb"] as const

/**
 * A byte count in the reader's language: unit from the catalog, number with
 * the locale's decimal mark. `locale` defaults to the active UI locale, so a
 * component re-renders on a language switch.
 */
export function formatBytes(n: number, locale: ShippedLocale = currentLocale()): string {
  const t = translatorFor(locale)
  if (!Number.isFinite(n) || n <= 0) return t("kernel.bytes.b", { n: 0 })
  const exp = Math.min(UNIT_KEYS.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** exp
  const r = v >= 100 || exp === 0 ? Math.round(v) : Math.round(v * 10) / 10
  const shown = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    useGrouping: false,
  }).format(r)
  return t(`kernel.bytes.${UNIT_KEYS[exp]}`, { n: shown })
}
