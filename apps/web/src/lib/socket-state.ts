// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether the realtime socket is down after having been up (S26), for code
// that has no reactive owner: the API clients skip their connection toast
// while it is, since the shell's banner already says the network is gone and
// the socket's reconnect resyncs every open view.
type SocketStatus = "connecting" | "connected" | "disconnected" | "reconnecting"

let everConnected = false
let lost = false

/** The shell reports every status change of its socket here. */
export function noteSocketStatus(status: SocketStatus): void {
  if (status === "connected") {
    everConnected = true
    lost = false
    return
  }
  lost = everConnected || status === "reconnecting"
}

/** True while a socket that was connected is reconnecting (or waiting for the network). */
export function socketReconnecting(): boolean {
  return lost
}
