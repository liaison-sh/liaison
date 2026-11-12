#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# The host firewall step of the app sandbox service (docs/self-hosting/sandbox.md).
#
# A Docker network marked `internal` has no route out of the host, but its
# containers still reach the host itself on the bridge's gateway address (sshd,
# a database bound to 0.0.0.0, the Docker API on TCP, ...) and every port of
# every other container on the network. This script closes both for the
# sandbox service:
#
#   INPUT        packets from the sandbox service's address to the host, and any
#                new connection from the sandbox network to the host: dropped
#   DOCKER-USER  packets from it to anything but the app's bridge-only port
#                (LIAISON_APP_BRIDGE_PORT, 3100) on the sandbox subnet: dropped;
#                replies on connections the app opened (app -> sandbox:8790) pass
#
# br_netfilter is loaded and bridge-nf-call-iptables set, so traffic between
# two containers on the same bridge goes through those chains too.
#
#   sudo deploy/sandbox-firewall.sh install    rules now + a systemd unit that
#                                               re-applies them at every boot
#   sudo deploy/sandbox-firewall.sh apply      rules now (idempotent)
#   sudo deploy/sandbox-firewall.sh remove     remove the rules and the unit
#        deploy/sandbox-firewall.sh check      probe from inside the running
#                                               sandbox container: only the
#                                               bridge port answers
#
# Settings (the compose file's, same defaults): LIAISON_SANDBOX_IP
# (172.31.250.10), LIAISON_SANDBOX_SUBNET (172.31.250.0/24),
# LIAISON_SANDBOX_BRIDGE (liaison-sbx0), LIAISON_APP_BRIDGE_PORT (3100).
# Change them in the compose environment and here together.
set -eu

SANDBOX_IP="${LIAISON_SANDBOX_IP:-172.31.250.10}"
SUBNET="${LIAISON_SANDBOX_SUBNET:-172.31.250.0/24}"
BRIDGE="${LIAISON_SANDBOX_BRIDGE:-liaison-sbx0}"
BRIDGE_PORT="${LIAISON_APP_BRIDGE_PORT:-3100}"
CHAIN_FWD="LIAISON-SANDBOX-FWD"
CHAIN_IN="LIAISON-SANDBOX-IN"
UNIT="/etc/systemd/system/liaison-sandbox-firewall.service"
HERE="$(cd "$(dirname "$0")" && pwd)"

need_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "sandbox-firewall: run as root (sudo)" >&2
    exit 1
  fi
}

ipt() { iptables -w "$@"; }

# Create (or empty) a chain of ours, and make sure `parent` jumps to it first.
own_chain() {
  parent="$1"
  chain="$2"
  ipt -N "$chain" 2>/dev/null || ipt -F "$chain"
  while ipt -D "$parent" -j "$chain" 2>/dev/null; do :; done
  ipt -I "$parent" 1 -j "$chain"
}

apply() {
  need_root
  # Bridged traffic (container to container on one bridge) through iptables.
  modprobe br_netfilter 2>/dev/null || true
  if [ ! -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
    echo "sandbox-firewall: br_netfilter is not available; the bridge allowlist cannot hold" >&2
    exit 1
  fi
  sysctl -q -w net.bridge.bridge-nf-call-iptables=1
  # DOCKER-USER exists once Docker has started; create it if this runs first
  # (Docker keeps its contents).
  ipt -N DOCKER-USER 2>/dev/null || true
  if ! ipt -C FORWARD -j DOCKER-USER 2>/dev/null; then ipt -I FORWARD 1 -j DOCKER-USER; fi

  # The sandbox service -> the host (its gateway address and any other): drop.
  own_chain INPUT "$CHAIN_IN"
  ipt -A "$CHAIN_IN" -s "$SANDBOX_IP" -j DROP
  # Nothing on the sandbox network opens a connection to the host.
  ipt -A "$CHAIN_IN" -i "$BRIDGE" -m conntrack --ctstate NEW -j DROP

  # The sandbox service -> anything: the app's bridge-only port on the sandbox
  # subnet, and replies on the app's own connections to it. Nothing else.
  own_chain DOCKER-USER "$CHAIN_FWD"
  ipt -A "$CHAIN_FWD" -s "$SANDBOX_IP" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  ipt -A "$CHAIN_FWD" -s "$SANDBOX_IP" -d "$SUBNET" -p tcp --dport "$BRIDGE_PORT" -j RETURN
  ipt -A "$CHAIN_FWD" -s "$SANDBOX_IP" -j DROP

  # No IPv6 on the sandbox network (the compose file disables it); drop any anyway.
  if command -v ip6tables >/dev/null 2>&1 && [ -e "/proc/sys/net/ipv6/conf/$BRIDGE" ]; then
    sysctl -q -w "net.ipv6.conf.$BRIDGE.disable_ipv6=1" || true
  fi
  echo "sandbox-firewall: rules applied (sandbox $SANDBOX_IP on $SUBNET may reach :$BRIDGE_PORT only)"
}

install_unit() {
  need_root
  apply
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "sandbox-firewall: no systemd; re-run 'apply' at every boot, after Docker starts" >&2
    return 0
  fi
  cat >"$UNIT" <<EOF
[Unit]
Description=Liaison app sandbox firewall (deploy/sandbox-firewall.sh)
After=docker.service network-online.target
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=LIAISON_SANDBOX_IP=$SANDBOX_IP
Environment=LIAISON_SANDBOX_SUBNET=$SUBNET
Environment=LIAISON_SANDBOX_BRIDGE=$BRIDGE
Environment=LIAISON_APP_BRIDGE_PORT=$BRIDGE_PORT
ExecStart=/bin/sh $HERE/sandbox-firewall.sh apply

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable liaison-sandbox-firewall.service >/dev/null
  echo "sandbox-firewall: installed $UNIT (re-applies at boot)"
}

remove() {
  need_root
  for pair in "INPUT $CHAIN_IN" "DOCKER-USER $CHAIN_FWD"; do
    set -- $pair
    while ipt -D "$1" -j "$2" 2>/dev/null; do :; done
    ipt -F "$2" 2>/dev/null || true
    ipt -X "$2" 2>/dev/null || true
  done
  if [ -f "$UNIT" ]; then
    systemctl disable liaison-sandbox-firewall.service >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload 2>/dev/null || true
  fi
  echo "sandbox-firewall: removed"
}

# From inside the sandbox container: only the app's bridge port accepts a
# connection, and it serves a run's bridge call path only.
check() {
  gateway="$(echo "$SUBNET" | sed 's|\.0/[0-9]*$|.1|')"
  docker compose -f "$HERE/docker-compose.yml" exec -T sandbox bun --eval "
// A TCP connect: 'open' when something accepted it, else 'blocked' (dropped,
// refused or unroutable).
const tcp = (hostname, port) => new Promise((done) => {
  const timer = setTimeout(() => done('blocked (timeout)'), 3000)
  Bun.connect({ hostname, port, socket: {
    open(s) { clearTimeout(timer); s.end(); done('open') },
    data() {},
    error() { clearTimeout(timer); done('blocked') },
    connectError() { clearTimeout(timer); done('blocked') },
  } }).catch(() => { clearTimeout(timer); done('blocked') })
})
const want = [
  ['app-bridge', $BRIDGE_PORT, 'open'],
  ['app-bridge', 3000, 'blocked'],
  ['$gateway', 22, 'blocked'],
  ['$gateway', 3000, 'blocked'],
  ['169.254.169.254', 80, 'blocked'],
  ['1.1.1.1', 443, 'blocked'],
]
let bad = 0
for (const [host, port, expected] of want) {
  const got = await tcp(host, port)
  const ok = got.startsWith(expected)
  if (!ok) bad++
  console.log((ok ? 'ok    ' : 'FAIL  ') + host + ':' + port + ' -> ' + got)
}
// The bridge port answers a run's call path, and nothing else.
const r = await fetch('http://app-bridge:$BRIDGE_PORT/healthz', { signal: AbortSignal.timeout(3000) }).catch(() => null)
const health = r ? r.status : 'no answer'
if (health !== 404) bad++
console.log((health === 404 ? 'ok    ' : 'FAIL  ') + 'app-bridge:$BRIDGE_PORT/healthz -> ' + health)
process.exit(bad ? 1 : 0)
"
}

case "${1:-}" in
  apply) apply ;;
  install) install_unit ;;
  remove) remove ;;
  check) check ;;
  *)
    echo "usage: $0 install|apply|remove|check" >&2
    exit 2
    ;;
esac
