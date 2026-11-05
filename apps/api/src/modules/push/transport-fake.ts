// SPDX-License-Identifier: FSL-1.1-ALv2
import type { PushHttpRequest, PushHttpResponse, PushTransport } from "~/modules/push/types"

/**
 * A transport that answers from a queue instead of the network.
 *
 * It lives in `src` rather than in a test file because more than one test file
 * needs it (the sender's and the fanout consumer's), and because the point of
 * the seam is that the production sender is exercised unchanged: the fake
 * replaces the socket, never the request builder or the classifier.
 */
export class FakePushTransport implements PushTransport {
  readonly requests: PushHttpRequest[] = []
  private readonly responses: PushHttpResponse[] = []

  enqueue(response: PushHttpResponse): void {
    this.responses.push(response)
  }

  async request(req: PushHttpRequest): Promise<PushHttpResponse> {
    this.requests.push(req)
    const response = this.responses.shift()
    if (!response) throw new Error(`FakePushTransport has no queued response for ${req.url}`)
    return response
  }
}
