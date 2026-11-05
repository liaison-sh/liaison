// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The refusal a keyed gated call gets when someone else's approval for the same key is already
// pending (one reply draft per ticket or mail conversation). It is the agent's cue to rewrite the
// waiting draft, so it says so first and spells out the edit call: "tell the user it is waiting"
// alone left agents stuck, unable to replace a draft they were asked to redo.

export function alreadyPendingMessage(args: {
  toolName: string
  keyParam: string
  keyValue: string
  approvalRequestId: string
  editableFields: readonly string[]
}): string {
  const editable = args.editableFields.length > 0 ? args.editableFields.join(", ") : "(none)"
  return (
    `NOT STAGED: a draft ALREADY EXISTS. A ${args.toolName} for ${args.keyParam} ` +
    `${args.keyValue} is already waiting for approval (approvalRequestId ` +
    `${args.approvalRequestId}), drafted by someone else, and there is only one per ` +
    `${args.keyParam}. Do NOT call ${args.toolName} again. UPDATE THAT DRAFT instead: call ` +
    `kernel__approval_update_payload with requestId ${args.approvalRequestId} and fields ` +
    `holding your full new content (editable fields: ${editable}). Editing a colleague's ` +
    "waiting draft is expected and keeps it one approval. Only if that update is refused, tell " +
    "the user a draft is already waiting (give its id) and show them the text you propose."
  )
}
