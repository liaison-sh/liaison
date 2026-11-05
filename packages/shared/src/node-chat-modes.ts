// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The permission modes a remotely driven My node chat may use (A24: never
 * bypass). One list for the API schema and the web menu (L23); the values,
 * their order and the default are frozen with the chat mode (D29).
 */
export const NODE_CHAT_PERMISSION_MODES = ["auto", "manual", "edit", "plan"] as const
export type NodeChatPermissionMode = (typeof NODE_CHAT_PERMISSION_MODES)[number]
