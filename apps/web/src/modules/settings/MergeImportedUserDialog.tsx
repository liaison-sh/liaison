// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Link an imported history author to the real person it stands for (Users >
// Imported). The admin picks the person, the dialog previews what will move
// (the server's dry run: POST /admin/users/:id/merge { dryRun: true }), and
// only then offers the irreversible merge. The server enforces every rule
// (placeholder into a real member of the same org, admin scope); this dialog
// only offers real people as targets so the obvious mistake is not even shown.

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

export interface MergeCandidate {
  id: string
  name: string
  email: string
  status: string
}

interface MergeCounts {
  messagesAuthored: number
  messagesMentioning: number
  reactionsMoved: number
  filesMoved: number
  participationsMoved: number
}

interface MergeResponse {
  dryRun: boolean
  alreadyMerged: boolean
  target: { id: string; name: string }
  counts: MergeCounts
}

export const MergeImportedUserDialog: Component<{
  placeholder: MergeCandidate | null
  /** The org's real people, the only possible targets. */
  loadPeople: () => Promise<MergeCandidate[]>
  onClose: () => void
  onMerged: () => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [targetId, setTargetId] = createSignal("")
  const [merging, setMerging] = createSignal(false)

  const [people] = createResource(
    () => props.placeholder?.id,
    async () => (await props.loadPeople()).filter((p) => p.status !== "deactivated"),
  )

  // The dry run, re-asked whenever the chosen person changes.
  const [preview] = createResource(
    () => {
      const ph = props.placeholder?.id
      const target = targetId()
      return ph && target ? { ph, target } : undefined
    },
    async ({ ph, target }) =>
      api.post<MergeResponse>(`/admin/users/${ph}/merge`, { targetUserId: target, dryRun: true }),
  )

  function close() {
    setTargetId("")
    props.onClose()
  }

  async function merge() {
    const ph = props.placeholder
    const target = targetId()
    if (!ph || !target) return
    setMerging(true)
    try {
      const res = await api.post<MergeResponse>(`/admin/users/${ph.id}/merge`, {
        targetUserId: target,
      })
      addToast({
        message: i18n.t("kernel.settingsUi.mergeImportedDone", {
          placeholder: ph.name,
          name: res?.target?.name ?? "",
        }),
        type: "success",
      })
      close()
      props.onMerged()
    } catch {
      addToast({ message: i18n.t("kernel.settingsUi.mergeImportedFailed"), type: "error" })
    } finally {
      setMerging(false)
    }
  }

  return (
    <Dialog
      open={props.placeholder !== null}
      onOpenChange={(v) => {
        if (!v) close()
      }}
    >
      <Dialog.Content>
        <Dialog.Title>
          {i18n.t("kernel.settingsUi.mergeImportedTitle", { name: props.placeholder?.name ?? "" })}
        </Dialog.Title>
        <Dialog.Description>
          {i18n.t("kernel.settingsUi.mergeImportedDescription")}
        </Dialog.Description>
        <div class="mt-4 flex flex-col gap-3">
          <label class="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            {i18n.t("kernel.settingsUi.mergeImportedPickPerson")}
            <select
              class="rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-border-strong"
              value={targetId()}
              onChange={(e) => setTargetId(e.currentTarget.value)}
              data-testid="merge-imported-target"
            >
              <option value="">{i18n.t("kernel.settingsUi.mergeImportedChoose")}</option>
              <For each={people() ?? []}>
                {(p) => (
                  <option value={p.id}>
                    {p.name} ({p.email})
                  </option>
                )}
              </For>
            </select>
          </label>
          <Show when={targetId()}>
            <p class="text-sm text-text-secondary" data-testid="merge-imported-preview">
              <Show
                when={preview()}
                fallback={i18n.t("kernel.settingsUi.mergeImportedLoading")}
                keyed
              >
                {(p) =>
                  i18n.t("kernel.settingsUi.mergeImportedPreview", {
                    messages: String(p.counts.messagesAuthored),
                    mentions: String(p.counts.messagesMentioning),
                    reactions: String(p.counts.reactionsMoved),
                    files: String(p.counts.filesMoved),
                    threads: String(p.counts.participationsMoved),
                    name: p.target.name,
                  })
                }
              </Show>
            </p>
          </Show>
          <div class="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              variant="danger"
              data-testid="merge-imported-confirm"
              disabled={!preview() || preview.loading || merging()}
              loading={merging()}
              onClick={() => void merge()}
            >
              {i18n.t("kernel.settingsUi.mergeImportedConfirm")}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
