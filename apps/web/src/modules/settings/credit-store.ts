// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"

const [creditVersion, setCreditVersion] = createSignal(0)

/** Bump to trigger balance refetch in all components watching creditVersion(). */
export function notifyCreditUpdate() {
  setCreditVersion((v) => v + 1)
}

export { creditVersion }
