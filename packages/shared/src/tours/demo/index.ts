// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The demo scenarios: one guided tour per need a demo visitor can pick
 * (`DEMO_NEED_SPECS[need].scenarioTourId`), each `demoOnly`, so a regular
 * org's "Show me how" never lists them and their routes answer 404 there.
 */
import { scenarioChatTour } from "./chat"
import { scenarioCommerceTour } from "./commerce"
import { scenarioDevTour } from "./dev"
import { scenarioKnowledgeTour } from "./knowledge"
import { scenarioProjectsTour } from "./projects"
import { scenarioSalesTour } from "./sales"
import { scenarioSupportTour } from "./support"
import { scenarioSaasChatTour } from "./worlds/saas/chat"
import { scenarioSaasDevTour } from "./worlds/saas/dev"
import { scenarioSaasKnowledgeTour } from "./worlds/saas/knowledge"
import { scenarioSaasMoneyTour } from "./worlds/saas/money"
import { scenarioSaasProjectsTour } from "./worlds/saas/projects"
import { scenarioSaasSalesTour } from "./worlds/saas/sales"
import { scenarioSaasSupportTour } from "./worlds/saas/support"
import { STUDIO_CHAT_CFG, scenarioStudioChatTour } from "./worlds/studio/chat"
import { STUDIO_CLIENT_CFG, scenarioStudioClientTour } from "./worlds/studio/client"
import { STUDIO_DEV_CFG, scenarioStudioDevTour } from "./worlds/studio/dev"
import { STUDIO_KNOWLEDGE_CFG, scenarioStudioKnowledgeTour } from "./worlds/studio/knowledge"
import { STUDIO_PROJECTS_CFG, scenarioStudioProjectsTour } from "./worlds/studio/projects"
import { STUDIO_SALES_CFG, scenarioStudioSalesTour } from "./worlds/studio/sales"
import { STUDIO_SUPPORT_CFG, scenarioStudioSupportTour } from "./worlds/studio/support"

/** In `DEMO_NEEDS` order (support, projects, chat, sales, commerce, dev, knowledge). */
export const SCENARIO_TOURS = [
  scenarioSupportTour,
  scenarioProjectsTour,
  scenarioChatTour,
  scenarioSalesTour,
  scenarioCommerceTour,
  scenarioDevTour,
  scenarioKnowledgeTour,
] as const

/**
 * The scenarios of the other demo worlds (`kernel.scenario-<world>-<need>`),
 * each offered only in a workspace of its own world.
 */
export const WORLD_SCENARIO_TOURS = [
  scenarioSaasSupportTour,
  scenarioSaasProjectsTour,
  scenarioSaasChatTour,
  scenarioSaasSalesTour,
  scenarioSaasMoneyTour,
  scenarioSaasDevTour,
  scenarioSaasKnowledgeTour,
  scenarioStudioSupportTour,
  scenarioStudioProjectsTour,
  scenarioStudioChatTour,
  scenarioStudioSalesTour,
  scenarioStudioClientTour,
  scenarioStudioDevTour,
  scenarioStudioKnowledgeTour,
] as const

/**
 * About how long each services-world scenario takes, in minutes, from its
 * configuration: what the door's tile for that need says in that world.
 */
export const STUDIO_SCENARIO_MINUTES = {
  support: STUDIO_SUPPORT_CFG.minutes,
  projects: STUDIO_PROJECTS_CFG.minutes,
  chat: STUDIO_CHAT_CFG.minutes,
  sales: STUDIO_SALES_CFG.minutes,
  client: STUDIO_CLIENT_CFG.minutes,
  dev: STUDIO_DEV_CFG.minutes,
  knowledge: STUDIO_KNOWLEDGE_CFG.minutes,
} as const

/** Every demo scenario, of every world. */
export const DEMO_SCENARIO_TOURS = [...SCENARIO_TOURS, ...WORLD_SCENARIO_TOURS] as const

/** The builders a world's configuration is built on (`PRODUCTS_CFG` is the products world's). */
export { buildChatTour } from "./chat"
export {
  buildClientTour,
  CLIENT_CARD_ROW,
  CLIENT_CARD_TOOL,
  CLIENT_FIGURES_TOOL,
  type ClientScenarioCfg,
} from "./client"
export { buildCommerceTour } from "./commerce"
export { buildDevTour, type DevScenarioCfg, PRODUCTS_DEV_CFG } from "./dev"
export {
  buildKnowledgeTour,
  type KnowledgeScenarioCfg,
  PRODUCTS_KNOWLEDGE_CFG,
} from "./knowledge"
export {
  buildMoneyTour,
  MONEY_FIGURES_TOOL,
  MONEY_REMINDER_ROW,
  type MoneyScenarioCfg,
} from "./money"
export { buildProjectsTour, PRODUCTS_PROJECT_NAME, type ProjectsScenarioCfg } from "./projects"
export { buildSalesTour, PRODUCTS_SALES_CFG, type SalesScenarioCfg } from "./sales"
export { PRODUCTS_CFG, type ScenarioCfg, type ScenarioExtraBeat } from "./shared"
export { buildSupportTour } from "./support"
export {
  SAAS_CHAT_CFG,
  SAAS_CHAT_QUESTION_INJECTOR,
  scenarioSaasChatTour,
} from "./worlds/saas/chat"
export {
  SAAS_BUGS_CHANNEL_TITLE,
  SAAS_DEV_CFG,
  SAAS_TELL_TOOL,
  scenarioSaasDevTour,
} from "./worlds/saas/dev"
export {
  SAAS_KNOWLEDGE_ASKS_INJECTOR,
  SAAS_KNOWLEDGE_CFG,
  SAAS_KNOWLEDGE_DOC_TITLE,
  scenarioSaasKnowledgeTour,
} from "./worlds/saas/knowledge"
export {
  SAAS_MONEY_CFG,
  SAAS_PAYMENT_RECOVERED_INJECTOR,
  scenarioSaasMoneyTour,
} from "./worlds/saas/money"
export {
  SAAS_PROJECT_NAME,
  SAAS_PROJECTS_CFG,
  SAAS_PROJECTS_COMMENT_INJECTOR,
  scenarioSaasProjectsTour,
} from "./worlds/saas/projects"
export {
  SAAS_COMPANY_WRITE_TOOL,
  SAAS_PROSPECT_ROUTINE_NAME,
  SAAS_SALES_CFG,
  SAAS_SALES_EMAIL_INJECTOR,
  scenarioSaasSalesTour,
} from "./worlds/saas/sales"
export {
  SAAS_SUPPORT_CFG,
  SAAS_SUPPORT_TICKET_INJECTOR,
  scenarioSaasSupportTour,
} from "./worlds/saas/support"
export {
  STUDIO_CHAT_CFG,
  STUDIO_CHAT_QUESTION_INJECTOR,
  scenarioStudioChatTour,
} from "./worlds/studio/chat"
export {
  STUDIO_CLIENT_CFG,
  STUDIO_CLIENT_PROJECT_NAME,
  STUDIO_CR_ACCEPTED_INJECTOR,
  scenarioStudioClientTour,
} from "./worlds/studio/client"
export {
  STUDIO_BUGS_CHANNEL_TITLE,
  STUDIO_DEV_CFG,
  STUDIO_TELL_TOOL,
  scenarioStudioDevTour,
} from "./worlds/studio/dev"
export {
  STUDIO_KNOWLEDGE_ASKS_INJECTOR,
  STUDIO_KNOWLEDGE_CFG,
  STUDIO_KNOWLEDGE_DOC_TITLE,
  scenarioStudioKnowledgeTour,
} from "./worlds/studio/knowledge"
export {
  STUDIO_PROJECT_NAME,
  STUDIO_PROJECTS_CFG,
  STUDIO_PROJECTS_COMMENT_INJECTOR,
  STUDIO_REPORT_HOURS_SECTION,
  STUDIO_REPORT_PROJECT_NAME,
  scenarioStudioProjectsTour,
} from "./worlds/studio/projects"
export {
  STUDIO_COMPANY_WRITE_TOOL,
  STUDIO_PRICE_SET,
  STUDIO_PROPOSAL_TOOL,
  STUDIO_PROSPECT_ROUTINE_NAME,
  STUDIO_SALES_CFG,
  STUDIO_SALES_EMAIL_INJECTOR,
  scenarioStudioSalesTour,
} from "./worlds/studio/sales"
export {
  STUDIO_SUPPORT_CFG,
  STUDIO_SUPPORT_TICKET_INJECTOR,
  scenarioStudioSupportTour,
} from "./worlds/studio/support"
