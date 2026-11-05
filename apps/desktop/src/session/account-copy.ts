// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell's native questions' words, straight from the catalogue apps/web
// reads, so the shell and the page can never say two different things. Only the `servers`
// block is imported: the bundler keeps a JSON module's named exports apart, and
// the rest of the catalogue stays out of the injected script.

import { servers as en } from "@liaison/shared/i18n/locales/en/kernel.json"
import { servers as fr } from "@liaison/shared/i18n/locales/fr/kernel.json"

export { en, fr }
