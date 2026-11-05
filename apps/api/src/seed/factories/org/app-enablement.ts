// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One rule of the app factory, in a module of its own so its test loads no
// service.

/**
 * Whether a seeded app should be added to the org's enabled list.
 *
 * Never advertise a catalog app whose install failed. `enableApp` only appends
 * the name to `settings.enabledApps`, so it succeeds happily for an app that has
 * no schema and no manifest registered, and the org then opens a tab whose every
 * read hits a relation that does not exist. A demo missing an app reads as a
 * smaller demo; a demo with seven broken tabs reads as a broken product.
 *
 * Kernel native apps (mail, tickets, knowledge, projects, calendar, contacts)
 * carry no catalog entry and are never installed, so they always enable.
 */
export function shouldEnableApp(input: { isCatalogApp: boolean; installed: boolean }): boolean {
  return !input.isCatalogApp || input.installed
}
