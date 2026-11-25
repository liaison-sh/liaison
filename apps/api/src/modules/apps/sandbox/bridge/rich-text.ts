// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `rich_text_render(params)`: the host lays out and renders a filled rich-text
 * source (modules/documents/rich-text.ts, host code a bundled app may not
 * import) and answers the PDF bytes (base64), their SHA-256, the page count,
 * the fields still blank, and the source's text beside the text the layout
 * drew with whether they agree. Read-only: no database, no file is stored; the
 * caller stores the bytes it froze. Refuses a run that holds no scope of the
 * calling app (the app's own scopes are its door to its own documents).
 */
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"

function refuse(code: string, message: string): string {
  return JSON.stringify({ status: "error", error: { code, message } })
}

export function createRichTextMethods(ctx: BridgeContext): Record<string, any> {
  const { appName, callerScopes } = ctx
  return {
    rich_text_render: async (paramsJson: string): Promise<string> => {
      const scopes = callerScopes ?? []
      if (!scopes.some((s) => s === "*" || s === `${appName}:*` || s.startsWith(`${appName}:`)))
        return refuse(
          "SCOPE_REQUIRED",
          `rich_text_render needs a scope of ${appName} on this run. Nothing was rendered.`,
        )
      const p = JSON.parse(paramsJson || "{}") as {
        body?: unknown
        data?: unknown
        title?: string
        labels?: Record<string, string>
      }
      const { RichTextError, freezeTextMatches, renderRichTextForFreeze } = await import(
        "~/modules/documents/rich-text"
      )
      const record =
        p.data && typeof p.data === "object" && !Array.isArray(p.data)
          ? (p.data as Record<string, unknown>)
          : {}
      const labels = p.labels ?? {}
      try {
        const out = await renderRichTextForFreeze({
          body: p.body,
          record,
          labelOf: (path) => labels[path] ?? path,
          ...(typeof p.title === "string" ? { title: p.title } : {}),
        })
        return JSON.stringify({
          status: "ok",
          bytesBase64: Buffer.from(out.bytes).toString("base64"),
          sha256: out.sha256,
          byteSize: out.bytes.byteLength,
          pageCount: out.pageCount,
          blanks: out.blanks,
          sourceText: out.sourceText,
          layoutText: out.layoutText,
          textMatches: freezeTextMatches(out.sourceText, out.layoutText) && out.tocMatches,
        })
      } catch (err) {
        if (err instanceof RichTextError) return refuse(err.code.toUpperCase(), err.message)
        throw err
      }
    },
  }
}
