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
#   - the Discord bot token is not in Claude's environment; the watcher starts
#   - with only a Wraith connection code: the watcher starts, the code stays out
#     of Claude's environment and the log, and wraith-link works for root only
# Needs Docker and jq. Creates and removes the containers cum-lock and cum-lock-w only.
set -uo pipefail

IMAGE=${1:?usage: lockdown.sh <manager-image>}
C=cum-lock
SECRET=dummy-secret-key-5f3a
DISCORD_SECRET=dummy-discord-token-9c1e

FAIL=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAIL=1; }
cleanup() { docker rm -f cum-lock cum-lock-w >/dev/null 2>&1; }
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
  -e DISCORD_BOT_TOKEN="$DISCORD_SECRET" -e DISCORD_USER_ID=184695080709324800 -e REPORT_TIME=off \
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
  if printf '%s' "$envs" | grep -q "$DISCORD_SECRET"; then fail "Discord token in Claude's environment"; else pass "Discord token not in Claude's environment"; fi
  if printf '%s\n' "$envs" | grep -qx 'HOME=/home/claude'; then
    pass "HOME is Claude's home"
  else
    fail "HOME in Claude's environment: $(printf '%s\n' "$envs" | grep '^HOME=' || echo 'not set'); names: $(printf '%s\n' "$envs" | cut -d= -f1 | tr '\n' ' ')"
  fi
fi
if in_c 'bash -ic "__claude_tmux has-session -t =main" 2>/dev/null'; then pass "a root console finds the session"; else fail "console attach helper"; fi
if in_c 'pgrep -u 99 -x claude >/dev/null || exit 1'; then pass "healthcheck command succeeds"; else fail "healthcheck"; fi
if docker logs "$C" 2>&1 | grep -q "Discord: watcher running"; then pass "Discord watcher started"; else fail "Discord watcher not started"; docker logs "$C" 2>&1 | grep -i discord; fi
# The dummy token cannot log in; whatever the watcher logs, it must not print the token.
if docker logs "$C" 2>&1 | grep -q "$DISCORD_SECRET"; then fail "Discord token printed in the log"; else pass "Discord token not in the log"; fi
if [ "$(in_c 'stat -c %U /workspace/watch')" = claude ]; then pass "watch directory belongs to Claude's user"; else fail "watch directory owner"; fi

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

echo "lockdown: fix tools"
# The watcher makes its state folder and key when it starts, a moment after Claude.
for _ in $(seq 30); do in_c "test -f /workspace/.unraid-watch/host-fix-key" 2>/dev/null && break; sleep 1; done
if printf '%s' "$mcp" | jq -e '.mcpServers.fix.command == "/usr/local/share/claude-unraid-manager/watcher/node" and (.mcpServers.fix.args[0] | endswith("fix-mcp.mjs"))' >/dev/null; then pass "managed MCP config has the fix server"; else fail "fix server entry: $mcp"; fi
if in_c 'jq -e ".permissions.allow | index(\"mcp__fix\")" /etc/claude-code/managed-settings.json' >/dev/null; then pass "fix tools allowed by the managed settings"; else fail "mcp__fix not allowed"; fi
if [ "$(owner /workspace/.unraid-watch)" = "root:root 700" ]; then pass "watcher state root-only 0700"; else fail "watcher state: $(owner /workspace/.unraid-watch)"; fi
if [ "$(owner /workspace/.unraid-watch/host-fix-key)" = "root:root 600" ]; then pass "host-fix key root-only 0600"; else fail "host-fix key: $(owner /workspace/.unraid-watch/host-fix-key)"; fi
if as_claude 'cat /workspace/.unraid-watch/host-fix-key' >/dev/null 2>&1; then fail "Claude's user can read the host-fix key"; else pass "Claude's user cannot read the host-fix key"; fi
if [ "$(owner /run/unraid-watch)" = "root:users 750" ]; then pass "fix socket directory root:users 0750"; else fail "fix socket directory: $(owner /run/unraid-watch)"; fi
if in_c 'host-fix-setup --authorized-key' | grep -q '^restrict,command="/bin/bash /boot/config/claude-unraid/host-fix" ssh-ed25519 '; then pass "host-fix-setup prints the forced-command line"; else fail "host-fix-setup line"; fi
if as_claude 'host-fix-setup' >/dev/null 2>&1; then fail "host-fix-setup works as Claude's user"; else pass "host-fix-setup refuses Claude's user"; fi
# Claude's user owns /workspace, so it can swap the state folder for one with its
# own key. host-fix-setup must then refuse instead of printing that key.
as_claude 'mv /workspace/.unraid-watch /workspace/.uw-real && mkdir -m 700 /workspace/.unraid-watch && ssh-keygen -q -t ed25519 -N "" -f /workspace/.unraid-watch/host-fix-key' >/dev/null 2>&1
if in_c 'host-fix-setup --authorized-key' >/dev/null 2>&1; then fail "host-fix-setup trusts a folder planted by Claude's user"; else pass "host-fix-setup refuses a planted state folder"; fi
as_claude 'rm -rf /workspace/.unraid-watch && mv /workspace/.uw-real /workspace/.unraid-watch' >/dev/null 2>&1
# The fix server answers MCP and lists the tools; without a watcher socket (the
# dummy token cannot log in) a call is refused, nothing is changed.
mcp_out=$(as_claude 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"container_restart\",\"arguments\":{\"name\":\"x\",\"reason\":\"test\"}}}" | timeout 20 /usr/local/share/claude-unraid-manager/watcher/node /usr/local/share/claude-unraid-manager/watcher/src/fix-mcp.mjs' 2>&1)
if printf '%s\n' "$mcp_out" | jq -se '.[1].result.tools | map(.name) | index("container_update") and index("appdata_chown") and index("container_exec") and index("appdata_edit")' >/dev/null 2>&1; then pass "fix server lists the tools"; else fail "fix server tools/list: $(printf '%s' "$mcp_out" | head -c 400)"; fi
if printf '%s\n' "$mcp_out" | jq -se '.[2].result.isError == true' >/dev/null 2>&1; then pass "fix call without the watcher is refused"; else fail "fix call: $(printf '%s' "$mcp_out" | tail -c 400)"; fi

echo "lockdown: ownership"
for p in /home/claude /workspace /workspace/CLAUDE.md /home/claude/.ssh/claude-host-readonly; do
  o=$(in_c "stat -c %U $p" 2>/dev/null)
  if [ "$o" = claude ]; then pass "$p belongs to claude"; else fail "$p owner: $o"; fi
done

echo "lockdown: start log"
log=$(docker logs "$C" 2>&1)
if printf '%s' "$log" | grep -q 'Claude as user claude, not root'; then pass "start log names the user"; else fail "start log: $(printf '%s' "$log" | tail -5)"; fi
if printf '%s' "$log" | grep -q "$SECRET"; then fail "key printed in the start log"; else pass "key not in the start log"; fi

echo "lockdown: links planted by Claude's user"
# Claude's user owns /workspace and its home, so it can put a link where root
# later writes or chowns. A restart re-runs everything root does at start;
# nothing it does may follow those links.
stats='stat -c "%n %U:%G %a" /etc /etc/passwd /etc/claude-code /etc/claude-code/managed-settings.json; sha256sum /etc/passwd /etc/claude-code/managed-settings.json'
before=$(in_c "$stats")
as_claude 'rm -rf /workspace/watch && ln -s /etc /workspace/watch
  rm -f /workspace/CLAUDE.md && ln -s /etc/claude-code/managed-settings.json /workspace/CLAUDE.md
  mv /home/claude/.ssh /home/claude/.ssh.real && ln -s /etc/claude-code /home/claude/.ssh' 2>&1 | head -5
starts=$(docker logs "$C" 2>&1 | grep -c 'Claude Unraid Manager is running')
docker restart "$C" >/dev/null
for _ in $(seq 60); do [ "$(docker logs "$C" 2>&1 | grep -c 'Claude Unraid Manager is running')" -gt "$starts" ] && break; sleep 1; done
after=$(in_c "$stats")
if [ "$before" = "$after" ]; then pass "root followed none of the links (/etc, passwd, managed settings unchanged)"; else fail "a link was followed: before '$before' after '$after'"; fi
if in_c 'test -f /workspace/CLAUDE.md && ! test -L /workspace/CLAUDE.md' && [ "$(in_c 'stat -c %U /workspace/CLAUDE.md')" = claude ]; then
  pass "CLAUDE.md written anew as Claude's file, the link replaced"
else
  fail "CLAUDE.md after the link: $(in_c 'ls -l /workspace/CLAUDE.md')"
fi
as_claude 'rm -f /home/claude/.ssh && mv /home/claude/.ssh.real /home/claude/.ssh' >/dev/null 2>&1

echo "lockdown: Wraith only"
# A well-formed code for a Wraith that is not there: the watcher keeps retrying, harmlessly.
WRAITH_SECRET="wpanel_$(printf '7%.0s' $(seq 64))"
WRAITH_CODE="wpc1.$(printf 'https://127.0.0.1:9' | base64 | tr '+/' '-_' | tr -d '=').$WRAITH_SECRET"
docker rm -f "$C" >/dev/null 2>&1
C=cum-lock-w
docker run -d --name "$C" -e WRAITH_PANEL_CODE="$WRAITH_CODE" -e REMOTE_CONTROL_NAME=off "$IMAGE" >/dev/null
for _ in $(seq 60); do in_c 'test -S /run/unraid-watch-admin/admin.sock' 2>/dev/null && break; sleep 1; done
log=$(docker logs "$C" 2>&1)
if printf '%s' "$log" | grep -q 'Wraith server panel on'; then pass "watcher starts with only a Wraith code"; else fail "Wraith panel not started: $(printf '%s' "$log" | grep -iE 'wraith|watch' | tail -5)"; fi
if printf '%s' "$log" | grep -q "$WRAITH_SECRET"; then fail "Wraith code printed in the log"; else pass "Wraith code not in the log"; fi
if [ "$(owner /run/unraid-watch-admin)" = "root:root 700" ]; then pass "admin socket folder root-only 0700"; else fail "admin socket folder: $(owner /run/unraid-watch-admin)"; fi
if in_c 'wraith-link' | grep -Eq 'Link code: +[A-Z2-9]{4}-[A-Z2-9]{4}'; then pass "wraith-link prints a code as root"; else fail "wraith-link as root: $(in_c 'wraith-link' 2>&1 | head -3)"; fi
if as_claude 'wraith-link' >/dev/null 2>&1; then fail "wraith-link works for Claude's user"; else pass "wraith-link refuses Claude's user"; fi
if as_claude "/usr/local/share/claude-unraid-manager/watcher/node -e 'require(\"net\").connect(\"/run/unraid-watch-admin/admin.sock\").on(\"connect\",()=>process.exit(0)).on(\"error\",()=>process.exit(1))'" >/dev/null 2>&1 \
  || as_claude 'ls /run/unraid-watch-admin' >/dev/null 2>&1; then
  fail "Claude's user can reach the admin socket"
else
  pass "admin socket out of Claude's reach"
fi
for _ in $(seq 60); do in_c 'pgrep -u 99 -x claude' >/dev/null 2>&1 && break; sleep 1; done
pid=$(in_c 'pgrep -u 99 -x claude | head -1')
envs=$(as_claude "tr '\\0' '\\n' < /proc/$pid/environ" 2>/dev/null)
if [ -z "$envs" ]; then
  pid=$(in_c "ps -o ppid= -p $pid | tr -d ' '")
  envs=$(as_claude "tr '\\0' '\\n' < /proc/$pid/environ" 2>&1)
fi
if [ -z "$envs" ] || ! printf '%s\n' "$envs" | grep -q '^PATH='; then
  fail "could not read Claude's environment (pid '$pid')"
elif printf '%s' "$envs" | grep -q "$WRAITH_SECRET"; then
  fail "Wraith code in Claude's environment"
else
  pass "Wraith code not in Claude's environment"
fi
# Wraith: Allow / Deny is answered in the Wraith chat, so the fix server is
# listed, with the permission tool the Wraith chats use.
if in_c 'jq -e ".mcpServers.fix.env.UNRAID_WRAITH_PERM == \"1\"" /etc/claude-code/managed-mcp.json' >/dev/null 2>&1; then pass "fix server listed for Wraith, with the permission tool"; else fail "fix server for Wraith: $(in_c 'jq -c .mcpServers.fix /etc/claude-code/managed-mcp.json')"; fi
if in_c 'test -e /workspace/.unraid-watch/wraith-terminal-key'; then fail "terminal key made although the terminal is off"; else pass "no terminal key while the terminal is off"; fi
if as_claude 'wraith-terminal-setup' >/dev/null 2>&1; then fail "wraith-terminal-setup works for Claude's user"; else pass "wraith-terminal-setup refuses Claude's user"; fi

if [ "$FAIL" -ne 0 ]; then
  echo "lockdown: FAILED"
  exit 1
fi
echo "lockdown: all passed"
