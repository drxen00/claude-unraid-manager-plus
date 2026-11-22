#!/bin/bash
# tests/mcp-allowlist.sh <manager-image>
#
# Starts the image's runraid MCP server over stdio exactly as the .mcp.json
# entry from unraid-mcp-config defines it, with an unreachable API URL (no
# Unraid needed), and checks:
#   - it starts with the shipped action list (runraid rejects unknown names)
#   - tools/list shows exactly the shipped read-only actions, nothing else
#   - calls to write actions are rejected, atomic and legacy form alike
# Needs Docker and jq.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${1:?usage: mcp-allowlist.sh <manager-image>}

FAIL=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAIL=1; }

expected=$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$ROOT/unraid-mcp-tools" | sed '/^$/d' | sed 's/^/unraid_/' | sort)

# The server entry as the entrypoint writes it, from inside the image.
entry=$(docker run --rm -e UNRAID_API_URL=http://127.0.0.1:9/graphql -e UNRAID_API_KEY=dummy \
  "$IMAGE" bash -c 'unraid-mcp-config /tmp/m.json >/dev/null && cat /tmp/m.json')
if printf '%s' "$entry" | jq -e '.mcpServers.unraid.command == "/usr/local/bin/runraid"' >/dev/null; then
  pass "config entry written in the image"
else
  fail "config entry: $entry"
fi
tools=$(printf '%s' "$entry" | jq -r '.mcpServers.unraid.env.UNRAID_RMCP_ENABLED_TOOLS')
if [ "$(printf '%s' "$tools" | tr ',' '\n' | sed 's/^/unraid_/' | sort)" = "$expected" ]; then
  pass "the image enables exactly the shipped action list"
else
  fail "enabled actions in the image: $tools"
fi
if printf '%s' "$entry" | grep -q dummy; then fail "API key in the MCP config"; else pass "API key not in the MCP config"; fi

requests() {
  local init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"acceptance","version":"0"}}}'
  printf '%s\n' "$init" '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 1
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"unraid_array_set_state","arguments":{"state":"STOP"}}}' \
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"unraid","arguments":{"action":"array_set_state","state":"STOP"}}}' \
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"unraid_docker_stop","arguments":{"id":"x"}}}' \
    '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"unraid","arguments":{"action":"api_keys"}}}'
  sleep 3
}

# The server as Claude Code starts it: config written as root by
# unraid-mcp-config, then runraid as Claude's user with exactly the entry's
# environment and without UNRAID_API_KEY, so the key must come from the
# root-owned .env. Same container, so the .env from the config step is there.
run_server() {
  docker run --rm -i -e UNRAID_API_URL=http://127.0.0.1:9/graphql -e UNRAID_API_KEY=dummy \
    -e WITH_ENV_FILE="$1" "$IMAGE" bash -c '
      unraid-mcp-config /tmp/m.json >/dev/null || exit 1
      [ "$WITH_ENV_FILE" = yes ] || rm -f /run/claude-unraid/.env
      mapfile -t vars < <(jq -r ".mcpServers.unraid.env | to_entries[] | \"\(.key)=\(.value)\"" /tmp/m.json)
      exec runuser -u claude -- env -u UNRAID_API_KEY -u UNRAID_API_URL HOME=/home/claude "${vars[@]}" \
        "$(jq -r .mcpServers.unraid.command /tmp/m.json)" mcp'
}
out=$(requests | run_server yes 2>/tmp/runraid.stderr)
resp() { printf '%s\n' "$out" | jq -c --argjson id "$1" 'select(.id == $id)' 2>/dev/null | head -1; }

if [ -n "$(resp 1)" ] && resp 1 | jq -e '.result' >/dev/null; then
  pass "server started with the shipped action list"
else
  fail "no initialize result; stderr: $(head -c 600 /tmp/runraid.stderr)"
fi

listed=$(resp 2 | jq -r '.result.tools[].name' 2>/dev/null | sort)
if [ -n "$listed" ] && [ "$listed" = "$expected" ]; then
  pass "tools/list is exactly the shipped read-only actions ($(printf '%s\n' "$listed" | grep -c .))"
else
  fail "tools/list differs from unraid-mcp-tools"
  diff <(printf '%s\n' "$expected") <(printf '%s\n' "$listed") | sed 's/^/    /'
fi

# Rejected = a JSON-RPC error, or a tool result flagged isError.
rejected() {
  local r
  r=$(resp "$2")
  if [ -z "$r" ]; then
    fail "$1: no response"
  elif printf '%s' "$r" | jq -e '.error or .result.isError == true' >/dev/null; then
    pass "$1 rejected"
  else
    fail "$1 was accepted: $r"
  fi
}
rejected "array stop (atomic tool)" 3
rejected "array stop (legacy tool)" 4
rejected "docker stop (atomic tool)" 5
rejected "api_keys read (not in the list)" 6

# Without the .env the server has no key and must not come up: proof that
# the run above got its key from the file, as Claude's user.
nokey=$(requests | run_server no 2>/dev/null)
if printf '%s\n' "$nokey" | jq -e 'select(.id == 1) | .result' >/dev/null 2>&1; then
  fail "server started without the key file (key came from somewhere else)"
else
  pass "no key file, no server: the key came from the root-owned .env"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "mcp allowlist: FAILED"
  exit 1
fi
echo "mcp allowlist: all passed"
