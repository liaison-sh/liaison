// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit-test HMAC helper, bound to the monitoring secret key. Pure node:crypto
// path (@liaison/test-helpers/webhook-hmac) imported only from tests, so the
// `node:crypto` import never reaches the sandbox bundle.
import { hmacBase64, makeHmacTestBridge } from "@liaison/test-helpers/webhook-hmac"
import type { WebhookBridge } from "./hmac"
import { WEBHOOK_SECRET_KEY } from "./hmac"

export { hmacBase64 }

/** A bridge stub that mirrors the host `crypto_*` + `config_get` surface.
 *  `extraConfig` lets tests set e.g. `monitoringAlertTtlSeconds`. */
export function makeTestBridge(
  secret: string | null,
  extraConfig: Record<string, unknown> = {},
): WebhookBridge {
  return makeHmacTestBridge({ secretKey: WEBHOOK_SECRET_KEY, secret, extraConfig })
}
