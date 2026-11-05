// SPDX-License-Identifier: FSL-1.1-ALv2
import { teardownOidc } from "./global-setup"

export default async function globalTeardown() {
  teardownOidc()
}
