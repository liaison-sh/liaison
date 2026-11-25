// SPDX-License-Identifier: FSL-1.1-ALv2
/** The services world's chat scenario: a teammate's question whose answer is on a fictional page. */
import { buildChatTour } from "../../chat"
import type { ScenarioCfg } from "../../shared"

/** The injector of the scenario's world beat (`modules/demo/worlds/studio/chat-question.ts`). */
export const STUDIO_CHAT_QUESTION_INJECTOR = "studio-chat-question"

export const STUDIO_CHAT_CFG: ScenarioCfg = {
  world: "studio",
  copy: "studioChat",
  injector: STUDIO_CHAT_QUESTION_INJECTOR,
  minutes: 3,
}

export const scenarioStudioChatTour = buildChatTour(STUDIO_CHAT_CFG)
