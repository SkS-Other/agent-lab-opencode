#!/bin/sh
# agent-lab vacuum entrypoint: deny-by-default egress with an allowlist, then exec opencode serve.
# Requires NET_ADMIN. AGENT_LAB_ALLOW is a comma-separated host list (resolved to IPs at startup).
#
# Hardening (Phase-4 review):
#  - IPv6 fails CLOSED (ip6tables OUTPUT DROP) so v6 cannot bypass the v4 allowlist.
#  - DNS egress is restricted to the container's configured resolvers, not the whole internet.
#  - Only IPv4 literals are added to the v4 table (getent returns AAAA too).
set -eu

ALLOW="${AGENT_LAB_ALLOW:-}"

# Resolvers from /etc/resolv.conf (Docker's embedded DNS is 127.0.0.11, reached via lo).
RESOLVERS=$(awk '/^nameserver/{print $2}' /etc/resolv.conf 2>/dev/null || true)

# --- IPv4: deny by default, allow lo + established + DNS-to-resolvers + allowlist IPs ---
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
for ns in $RESOLVERS; do
  case "$ns" in
    *:*) : ;; # IPv6 resolver, handled below
    *)
      iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
      iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
      ;;
  esac
done

# Resolve each allowlisted host to its IPv4 addresses and permit egress to them.
for host in $(echo "$ALLOW" | tr ',' ' '); do
  [ -z "$host" ] && continue
  for ip in $(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u); do
    iptables -A OUTPUT -d "$ip" -j ACCEPT
    echo "[agent-lab-vacuum] allow $host -> $ip" >&2
  done
done

# --- IPv6: fail closed (drop all egress except lo + established + DNS to v6 resolvers) ---
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -P OUTPUT DROP 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
  for ns in $RESOLVERS; do
    case "$ns" in
      *:*)
        ip6tables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT 2>/dev/null || true
        ip6tables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
        ;;
    esac
  done
fi

echo "[agent-lab-vacuum] egress locked to allowlist; starting opencode serve" >&2
exec opencode serve --hostname 0.0.0.0 --port 4096
