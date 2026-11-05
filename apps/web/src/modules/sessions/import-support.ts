// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether this server has the import route (D42 pattern): the Import
// sessions entry hides once a listing answered that it has none.

import { createSignal } from "solid-js"

const [importSupported, setImportSupported] = createSignal(true)

export { importSupported, setImportSupported }

/** Tests: forget a previous server's answer. */
export function resetImportSupport(): void {
  setImportSupported(true)
}
