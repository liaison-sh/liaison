// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The platform share sheet, behind the bridge.
//
// It carries a LINK and a label, never a file and never anything the app
// holds in memory: what the web app asks to share is a deep link to a ticket
// or a thread, and the recipient's access is decided by the server when they
// open it. Nothing about the sheet is a grant.
//
// A DISMISSED SHEET REJECTS, and that rejection is passed through rather than
// swallowed. The web side needs to tell "the user changed their mind" from
// "there is no sheet here", because the second one falls back to the clipboard
// and the first one must not (apps/web/src/lib/share.ts).

export interface SharePayload {
  title?: string
  text?: string
  url?: string
}

/** Just enough of @capacitor/share to be testable without a device. */
export interface SharePlugin {
  share: (options: SharePayload) => Promise<unknown>
  canShare?: () => Promise<{ value: boolean }>
}

/**
 * The bridge's `share`. Resolves when the sheet was presented, rejects with
 * the platform's own error otherwise, `AbortError` on a dismissal included.
 */
export function createShare(plugin: SharePlugin): (payload: SharePayload) => Promise<void> {
  return async (payload: SharePayload): Promise<void> => {
    // Empty fields are DROPPED rather than sent as "". iOS builds the sheet's
    // preview from what it is given and an empty title renders as a blank
    // line above the link.
    const options: SharePayload = {}
    if (payload.title) options.title = payload.title
    if (payload.text) options.text = payload.text
    if (payload.url) options.url = payload.url
    await plugin.share(options)
  }
}
