#!/bin/bash
# tests/lockdown.sh <manager-image>
#
# Starts the image with its real entrypoint (no login, no Docker, a dummy
# Unraid API key) and checks what step 4 promises:
#   - Claude runs as uid 99 (claude), never as root, inside tmux
#   - managed settings and managed MCP config are root-owned and Claude's
#     user cannot change them or add a drop-in
#   - the Unraid API key is in neither Claude's environment nor the MCP config,
#     only in the root-owned key file
#   - home, workspace and CLAUDE.md belong to Claude's user
# Needs Docker and jq. Creates and removes the container cum-lock only.
set -uo pipefail

IMAGE=${1:?usage: lockdown.sh <manager-image>}
C=cum-lock
SECRET=dummy-secret-key-5f3a

FAIL=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAIL=1; }
cleanup() { docker rm -f "$C" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

in_c() { docker exec "$C" bash -c "$1"; }
as_claude() { docker exec --user 99:100 "$C" bash -c "$1"; }

echo "lockdown: image"
if [ "$(docker run --rm "$IMAGE" id -u claude):$(docker run --rm "$IMAGE" id -g claude)" = "99:100" ]; then
  pass "user claude is 99:100"
else
  fail "user claude ids"
fi

docker run -d --name "$C" -e UNRAID_API_URL=http://127.0.0.1:9/graphql -e UNRAID_API_KEY="$SECRET" \
  -e REMOTE_CONTROL_NAME=off "$IMAGE" >/dev/null
for _ in $(seq 60); do in_c 'pgrep -u 99 -x claude' >/dev/null 2>&1 && break; sleep 1; done

echo "lockdown: Claude's process"
if in_c 'pgrep -u 99 -x claude' >/dev/null 2>&1; then pass "claude runs as uid 99"; else fail "no claude process as uid 99"; docker logs "$C" 2>&1 | tail -20; fi
if in_c 'pgrep -u 0 -x claude' >/dev/null 2>&1; then fail "a claude process runs as root"; else pass "no claude process as root"; fi
# The tmux server renames itself ("tmux: server"), so no exact name match.
tmux_users=$(in_c "ps -eo user:20,args | awk '\$2 ~ /^tmux/ {print \$1}' | sort -u | tr '\n' ' '")
if [ "$tmux_users" = "claude " ]; then pass "tmux runs as claude only"; else fail "tmux process owners: '$tmux_users'"; in_c 'ps -eo user:20,pid,args' | grep -i tmux; fi
# shellcheck disable=SC2016 # expanded inside the container, not here
# Root in `docker exec` has no CAP_SYS_PTRACE, so it may not read another
# user's /proc/<pid>/environ; read it as Claude's user. If the claude binary
# marks itself non-dumpable, fall back to its parent, the claude-session
# shell that hands it the environment unchanged.
pid=$(in_c 'pgrep -u 99 -x claude | head -1')
envs=$(as_claude "tr '\\0' '\\n' < /proc/$pid/environ" 2>/dev/null)
if [ -z "$envs" ]; then
  pid=$(in_c "ps -o ppid= -p $pid | tr -d ' '")
  envs=$(as_claude "tr '\\0' '\\n' < /proc/$pid/environ" 2>&1)
fi
if [ -z "$envs" ] || ! printf '%s\n' "$envs" | grep -q '^PATH='; then
  fail "could not read Claude's environment (pid '$pid'): $(printf '%s' "$envs" | head -c 300)"
else
  if printf '%s' "$envs" | grep -q "$SECRET"; then fail "Unraid API key in Claude's environment"; else pass "Unraid API key not in Claude's environment"; fi
  if printf '%s\n' "$envs" | grep -qx 'HOME=/home/claude'; then
    pass "HOME is Claude's home"
  else
    fail "HOME in Claude's environment: $(printf '%s\n' "$envs" | grep '^HOME=' || echo 'not set'); names: $(printf '%s\n' "$envs" | cut -d= -f1 | tr '\n' ' ')"
  fi
fi
if in_c 'bash -ic "__claude_tmux has-session -t =main" 2>/dev/null'; then pass "a root console finds the session"; else fail "console attach helper"; fi
if in_c 'pgrep -u 99 -x claude >/dev/null || exit 1'; then pass "healthcheck command succeeds"; else fail "healthcheck"; fi

echo "lockdown: policy files"
owner() { in_c "stat -c '%U:%G %a' $1"; }
if [ "$(owner /etc/claude-code/managed-settings.json)" = "root:root 644" ]; then pass "managed-settings.json root-owned 0644"; else fail "managed-settings.json: $(owner /etc/claude-code/managed-settings.json)"; fi
if [ "$(owner /etc/claude-code/managed-mcp.json)" = "root:root 644" ]; then pass "managed-mcp.json root-owned 0644"; else fail "managed-mcp.json: $(owner /etc/claude-code/managed-mcp.json)"; fi
if [ "$(owner /etc/claude-code)" = "root:root 755" ]; then pass "/etc/claude-code root-owned 0755"; else fail "/etc/claude-code: $(owner /etc/claude-code)"; fi
for f in /etc/claude-code/managed-settings.json /etc/claude-code/managed-mcp.json /usr/local/bin/claude-guard; do
  if as_claude "echo '{}' >> $f" 2>/dev/null; then fail "Claude's user can write $f"; else pass "Claude's user cannot write $f"; fi
done
if as_claude 'mkdir -p /etc/claude-code/managed-settings.d && echo "{}" > /etc/claude-code/managed-settings.d/x.json' 2>/dev/null; then
  fail "Claude's user can add a managed drop-in"
else
  pass "Claude's user cannot add a managed drop-in"
fi
if as_claude 'mv /etc/claude-code/managed-mcp.json /tmp/x' 2>/dev/null; then fail "Claude's user can move managed-mcp.json"; else pass "Claude's user cannot move managed-mcp.json"; fi
if as_claude 'sudo -n true' 2>/dev/null || as_claude 'su -c true root </dev/null' 2>/dev/null; then fail "Claude's user can become root"; else pass "no sudo or su to root"; fi

echo "lockdown: Unraid API key"
mcp=$(in_c 'cat /etc/claude-code/managed-mcp.json')
if printf '%s' "$mcp" | jq -e '.mcpServers.unraid.command == "/usr/local/bin/runraid"' >/dev/null; then pass "managed MCP config has the unraid server"; else fail "managed MCP config: $mcp"; fi
if printf '%s' "$mcp" | grep -q "$SECRET"; then fail "key in the managed MCP config"; else pass "key not in the managed MCP config"; fi
if [ "$(owner /run/claude-unraid/.env)" = "root:users 640" ]; then pass "key file root:users 0640"; else fail "key file: $(owner /run/claude-unraid/.env)"; fi
if as_claude 'echo x >> /run/claude-unraid/.env' 2>/dev/null; then fail "Claude's user can change the key file"; else pass "Claude's user cannot change the key file"; fi

echo "lockdown: ownership"
for p in /home/claude /workspace /workspace/CLAUDE.md /home/claude/.ssh/claude-host-readonly; do
  o=$(in_c "stat -c %U $p" 2>/dev/null)
  if [ "$o" = claude ]; then pass "$p belongs to claude"; else fail "$p owner: $o"; fi
done

echo "lockdown: start log"
log=$(docker logs "$C" 2>&1)
if printf '%s' "$log" | grep -q 'Claude as user claude, not root'; then pass "start log names the user"; else fail "start log: $(printf '%s' "$log" | tail -5)"; fi
if printf '%s' "$log" | grep -q "$SECRET"; then fail "key printed in the start log"; else pass "key not in the start log"; fi

if [ "$FAIL" -ne 0 ]; then
  echo "lockdown: FAILED"
  exit 1
fi
echo "lockdown: all passed"
