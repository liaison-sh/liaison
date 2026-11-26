// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every string the first launch screen shows. It is the mobile twin of
// apps/desktop/src/session/desktop-copy.ts and apps/desktop/src/onboarding/
// onboarding-copy.ts, and the wording is deliberately the same: the two shells
// answer the same question, and a user who has seen one should recognise the
// other.
//
// This file is inside the no-dash copy lint's scope (scripts/lint-copy-dashes.ts).

/** NORMATIVE. First launch, the question. */
export const FIRST_LAUNCH_PROMPT = "Enter your Liaison org URL:"
/** NORMATIVE. First launch, helper line. */
export const FIRST_LAUNCH_HELPER = "You can also open a connect link from the web app."
/** NORMATIVE. First launch, the action. */
export const FIRST_LAUNCH_CONNECT_ACTION = "Connect"
/** NORMATIVE. First launch, refusal. */
export const FIRST_LAUNCH_INVALID_ADDRESS = "That is not a valid Liaison URL."
/**
 * Shown above a prefilled address that arrived as a `liaison://connect` link.
 * The link comes from the operating system, which means any page the user
 * visits can send one, so the address is shown and confirmed, never applied.
 */
export const DEEP_LINK_CONFIRM_PROMPT = "Connect to this Liaison org?"

/**
 * NORMATIVE. The in app notice for a push whose payload carries no text. A
 * scope tagged message is delivered with no title and no body by design
 * (apps/api/src/modules/push/redact.ts), so this is what the user reads.
 */
export const PUSH_NOTICE_FALLBACK = "New message"
/**
 * NORMATIVE. The address was valid and the server behind it did not answer.
 * Shown on the prompt, which is rendered AGAIN: nothing is stored until the
 * branding fetch has proved the address reaches a Liaison.
 */
export const FIRST_LAUNCH_UNREACHABLE = "Cannot reach this Liaison. Check the URL and try again."

/**
 * EVERY STRING OF THE FIRST LAUNCH, in English and French: the Cloud screen
 * (a workspace name under the build's cloud domain) and the address screen
 * above, which a French phone now also reads in French. The wording follows
 * the desktop's catalogue (`kernel.desktopUi.cloud` in packages/shared's
 * locales), so the two apps say the same thing.
 *
 * NO SIGNUP, PRICING OR PLAN WORDING HERE. The phone app creates no account
 * (App Review guideline 3.1.1); the desktop alone links to signup, and
 * `server-address.test.ts` asserts this screen never does.
 */
export interface FirstLaunchCopy {
  addressPrompt: string
  addressHelper: string
  addressInvalid: string
  addressUnreachable: string
  connectAction: string
  deepLinkConfirm: string
  cloudPrompt: string
  cloudWorkspaceLabel: string
  cloudPlaceholder: string
  cloudAction: string
  cloudInvalid: string
  cloudNotFound: string
  cloudDeepLinkConfirm: string
  cloudForgot: string
  cloudSelfHosted: string
  useCloud: string
}

const FIRST_LAUNCH_EN: FirstLaunchCopy = {
  addressPrompt: FIRST_LAUNCH_PROMPT,
  addressHelper: FIRST_LAUNCH_HELPER,
  addressInvalid: FIRST_LAUNCH_INVALID_ADDRESS,
  addressUnreachable: FIRST_LAUNCH_UNREACHABLE,
  connectAction: FIRST_LAUNCH_CONNECT_ACTION,
  deepLinkConfirm: DEEP_LINK_CONFIRM_PROMPT,
  cloudPrompt: "Sign in to your Liaison Cloud workspace.",
  cloudWorkspaceLabel: "Your workspace",
  cloudPlaceholder: "yourcompany",
  cloudAction: "Continue",
  cloudInvalid: "That is not a valid workspace name.",
  cloudNotFound:
    "That workspace was not found. Check the name and your connection, then try again.",
  cloudDeepLinkConfirm: "Connect to this Liaison Cloud workspace?",
  cloudForgot: "Forgot it? Email me my workspaces",
  cloudSelfHosted: "Use a self-hosted server",
  useCloud: "Use Liaison Cloud",
}

const FIRST_LAUNCH_FR: FirstLaunchCopy = {
  addressPrompt: "Saisissez l'URL de votre organisation Liaison :",
  addressHelper:
    "Vous pouvez aussi ouvrir un lien de connexion depuis Liaison dans votre navigateur.",
  addressInvalid: "Cette URL Liaison n'est pas valide.",
  addressUnreachable:
    "Impossible de joindre cette organisation Liaison. Vérifiez l'URL et réessayez.",
  connectAction: "Se connecter",
  deepLinkConfirm: "Se connecter à cette organisation Liaison ?",
  cloudPrompt: "Connectez-vous à votre espace de travail Liaison Cloud.",
  cloudWorkspaceLabel: "Votre espace de travail",
  cloudPlaceholder: "votreentreprise",
  cloudAction: "Continuer",
  cloudInvalid: "Ce nom d'espace de travail n'est pas valide.",
  cloudNotFound:
    "Cet espace de travail est introuvable. Vérifiez le nom et votre connexion, puis réessayez.",
  cloudDeepLinkConfirm: "Se connecter à cet espace de travail Liaison Cloud ?",
  cloudForgot: "Vous l'avez oublié ? Recevoir mes espaces de travail par e-mail",
  cloudSelfHosted: "Utiliser un serveur auto-hébergé",
  useCloud: "Utiliser Liaison Cloud",
}

/** The first launch's strings for a BCP 47 language tag: French, else English. */
export function firstLaunchCopy(language: string | undefined): FirstLaunchCopy {
  return language?.toLowerCase().startsWith("fr") ? FIRST_LAUNCH_FR : FIRST_LAUNCH_EN
}
