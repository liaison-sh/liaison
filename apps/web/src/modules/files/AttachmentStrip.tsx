// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, For, Show } from "solid-js"
import { AttachmentCard, type AttachmentFile } from "~/modules/files/AttachmentCard"
import { fileIsImage } from "~/modules/files/file-icons"
import { ImageAttachment } from "~/modules/files/ImageAttachment"

interface Props {
  files: AttachmentFile[]
  onDownload?: (file: AttachmentFile) => void
}

/**
 * Renders message-level attachments. Images display as Slack-style inline
 * previews (the picture itself, click to expand); every other file renders as
 * a compact card in a horizontal strip below them. Returns nothing for empty
 * arrays so it doesn't add blank chrome under text-only messages.
 *
 * Images that are CID-embedded — `disposition: "inline"` AND a `contentId`,
 * i.e. actually referenced by the rendered body — keep the compact card
 * (download affordance without duplicating the picture the body already
 * shows). A `contentId` alone does NOT demote: Gmail stamps a Content-ID on
 * ordinary attachments too, and ingestion marks those `attachment` because
 * nothing in the body references them.
 */
export const AttachmentStrip: Component<Props> = (props) => {
  const bodyEmbedded = (f: AttachmentFile) => f.disposition === "inline" && Boolean(f.contentId)
  const showsAsImage = (f: AttachmentFile) => fileIsImage(f.mimeType) && !bodyEmbedded(f)
  const images = () => props.files.filter(showsAsImage)
  const others = () => props.files.filter((f) => !showsAsImage(f))
  return (
    <Show when={props.files.length > 0}>
      <div data-testid="attachment-strip" class="mt-2 flex flex-col gap-2">
        <Show when={images().length > 0}>
          <div class="flex flex-wrap items-start gap-2">
            <For each={images()}>
              {(file) => (
                <ImageAttachment file={file} onDownload={() => props.onDownload?.(file)} />
              )}
            </For>
          </div>
        </Show>
        <Show when={others().length > 0}>
          <div class="flex flex-wrap gap-2">
            <For each={others()}>
              {(file) => <AttachmentCard file={file} onDownload={() => props.onDownload?.(file)} />}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
