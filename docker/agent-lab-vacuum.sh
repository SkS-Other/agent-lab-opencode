#!/bin/sh
# agent-lab vacuum entrypoint: deny-by-default egress with an allowlist, then exec opencode serve.
# Requires NET_ADMIN. AGENT_LAB_ALLOW is a comma-separated host list (resolved to IPs at startup).
set -eu

ALLOW="${AGENT_LAB_ALLOW:-}"

# Allow loopback and already-established connections; allow DNS so we can resolve the allowlist.
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Resolve each allowlisted host to its IPs and permit egress to them.
# Note: default IFS (space/tab/newline) so getent's multi-line IP output splits correctly.
for host in $(echo "$ALLOW" | tr ',' ' '); do
  [ -z "$host" ] && continue
  for ip in $(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u); do
    iptables -A OUTPUT -d "$ip" -j ACCEPT
    echo "[agent-lab-vacuum] allow $host -> $ip" >&2
  done
done

echo "[agent-lab-vacuum] egress locked to allowlist; starting opencode serve" >&2
exec opencode serve --hostname 0.0.0.0 --port 4096
