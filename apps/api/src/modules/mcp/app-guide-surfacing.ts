// SPDX-License-Identifier: FSL-1.1-ALv2
//
// APP GUIDES OVER MCP. An in-app turn carries each app's `agentInstructions`
// (its core, plus the sections about the tools it loaded) in its system prompt
// (context.ts, app-guide.ts). An MCP client has no per-turn prompt of ours and
// the `initialize` instructions are cut at 2048 characters, so the guide rides
// on the first result of a call to that app, exactly as an anchored skill does
// (tool-call.ts): the core once per app, each section once, the first time one
// of its tools is called. Delivered parts are remembered in the connection's
// surfaced set under `app-guide:` keys, beside the skill names.
import {
  guideCoversLoaded,
  normalizeAppGuide,
  renderAppGuideBlock,
  selectAppGuideParts,
} from "~/modules/agent/context/app-guide"
import { agentInstructionsRegistry } from "~/modules/apps/app-registries"

export const APP_GUIDE_KEY_PREFIX = "app-guide:"

/** The surfaced-set key of a guide's core (`app`) or one section (`app#i`). */
export function appGuideSurfacedKey(part: string): string {
  return `${APP_GUIDE_KEY_PREFIX}${part}`
}

/**
 * The guide text to push on the result of a call to `canonical` (`app:tool`),
 * and the keys it delivers; null when everything that applies already went out.
 */
export function selectAppGuideToSurface(
  orgId: string,
  canonical: string,
  surfaced: ReadonlySet<string>,
): { keys: string[]; text: string } | null {
  const sep = canonical.indexOf(":")
  if (sep <= 0) return null
  const app = canonical.slice(0, sep)
  const sdkName = `${app}__${canonical.slice(sep + 1)}`
  const keys: string[] = []
  const blocks: string[] = []

  const own = agentInstructionsRegistry.get([orgId, app])
  if (own !== undefined) {
    const parts = selectAppGuideParts(app, normalizeAppGuide(own), new Set([sdkName]))
    const coreKey = appGuideSurfacedKey(app)
    const core = surfaced.has(coreKey) ? undefined : parts.core
    const sections = parts.sections.filter((s) => !surfaced.has(appGuideSurfacedKey(s.key)))
    if (core || sections.length > 0) {
      if (core) keys.push(coreKey)
      for (const s of sections) keys.push(appGuideSurfacedKey(s.key))
      blocks.push(renderAppGuideBlock(app, { core, sections }))
    }
  }

  // A kernel guide registered under its own key (`kernel-config`, ...) covers
  // the tools it names: the whole guide, once, like the in-app assembler.
  for (const [key, guide] of agentInstructionsRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId || key[1] === app) continue
    if (!guideCoversLoaded(guide, [sdkName])) continue
    const coreKey = appGuideSurfacedKey(key[1])
    if (surfaced.has(coreKey)) continue
    keys.push(coreKey)
    blocks.push(
      renderAppGuideBlock(key[1], selectAppGuideParts(key[1], normalizeAppGuide(guide), "all")),
    )
  }

  if (blocks.length === 0) return null
  return {
    keys,
    text:
      "Liaison's working guide for the app you just called: the same rules Liaison's own " +
      "agents follow when they use it. It is included here because an MCP client has no " +
      `other channel to receive it. Follow it.\n\n${blocks.join("\n\n")}`,
  }
}
