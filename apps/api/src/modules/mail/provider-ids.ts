// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The mail provider ids an org can switch on or off (Settings > Mail >
 * Providers, `config apply` `apps[].providers`). Kept free of DB/env imports so
 * input schemas (the provisioning config) can validate against the same list
 * `provider-settings.ts` defines its providers from.
 */
export const MAIL_PROVIDER_IDS = ["gmail"] as const

export type MailProviderId = (typeof MAIL_PROVIDER_IDS)[number]
