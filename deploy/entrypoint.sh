#!/bin/sh
set -eu
SOCK=/var/run/tailscale/tailscaled.sock
mkdir -p /var/lib/tailscale /var/run/tailscale "${REX_MCP_STATE_DIR:-/data}"
tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale --socket="$SOCK" --socks5-server=127.0.0.1:1055 >/var/log/tailscaled.log 2>&1 &
TSD=$!
i=0
until [ -S "$SOCK" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ] || ! kill -0 "$TSD" 2>/dev/null; then
    echo "tailscaled did not start:" >&2
    cat /var/log/tailscaled.log >&2
    exit 1
  fi
  sleep 0.1
done
# Without TS_AUTHKEY and without saved state, "tailscale up" prints a login URL and waits, so it runs in the background and the HTTP server starts at once.
(
  if [ -n "${TS_AUTHKEY:-}" ]; then
    tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --accept-dns=false
  else
    tailscale up --hostname="$TS_HOSTNAME" --accept-dns=false
  fi && tailscale status --self --peers=false
) &
exec node /app/dist/main.js serve
