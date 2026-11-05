// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-decided taint facts about particular tools. These answers are the host's, never a
// manifest's: an app cannot declare itself out of them.

/**
 * Tools that are not static taint sources but taint the turn for SOME results (a knowledge read
 * taints when the document was synced from outside, or is a remote source item). A caller that
 * provisions the conversation lazily (the MCP gateway) must provide one before such a call, or
 * the mark has nowhere to land.
 */
const HOST_DYNAMIC_TAINT_TOOLS: ReadonlySet<string> = new Set(["knowledge:get", "knowledge:search"])

export function hostMayTaint(toolName: string): boolean {
  return HOST_DYNAMIC_TAINT_TOOLS.has(toolName)
}
