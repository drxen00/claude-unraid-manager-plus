#!/bin/bash
# entrypoint.sh — runs as root, prepares the container, then starts Claude in
# tmux as the unprivileged user $CLAUDE_USER (uid 99). Everything that
# enforces policy stays root-owned: /etc/claude-code (managed settings and MCP
# config), the guard, and the Unraid API key file.
set -euo pipefail

SESSION="${TMUX_SESSION:-main}"
RC_NAME="${REMOTE_CONTROL_NAME:-$(hostname)}"
CONTINUE="${CONTINUE:-true}"
CLAUDE_USER="${CLAUDE_USER:-claude}"
CLAUDE_HOME="${CLAUDE_HOME:-/home/claude}"
export HOST_HELPER_IMAGE="${HOST_HELPER_IMAGE:-alpine:3.21}"

# Run a command as Claude's user. The Unraid API key and the Discord bot token
# are dropped from the environment: the MCP server reads the key from a file,
# and only the watcher (root) uses the token.
as_claude() {
  runuser -u "$CLAUDE_USER" -- env -u UNRAID_API_KEY -u DISCORD_BOT_TOKEN \
    HOME="$CLAUDE_HOME" USER="$CLAUDE_USER" LOGNAME="$CLAUDE_USER" "$@"
}

# ── Home and workspace belong to Claude's user ───────────────────────────────
# Bind mounts arrive owned by whoever created them; fix that once, recursively,
# only when the top directory is not ours yet.
for d in "$CLAUDE_HOME" /workspace; do
  mkdir -p "$d"
  if [ "$(stat -c %u "$d")" != "$(id -u "$CLAUDE_USER")" ]; then
    chown -R "$CLAUDE_USER":"$(id -g "$CLAUDE_USER")" "$d"
  fi
done
[ -f "$CLAUDE_HOME/.tmux.conf" ] || as_claude cp /usr/local/share/claude-unraid-manager/tmux.conf "$CLAUDE_HOME/.tmux.conf"
as_claude mkdir -p "$CLAUDE_HOME/.claude"

# Fix SSH key permissions (bind-mount may loosen them)
if [ -d "$CLAUDE_HOME/.ssh" ]; then
  chmod 700 "$CLAUDE_HOME/.ssh" 2>/dev/null || true
  find "$CLAUDE_HOME/.ssh" -type f ! -name '*.pub' ! -name 'known_hosts*' -exec chmod 600 {} + 2>/dev/null || true
  chown -R "$CLAUDE_USER":"$(id -g "$CLAUDE_USER")" "$CLAUDE_HOME/.ssh" 2>/dev/null || true
fi

# ── Appdata location check ───────────────────────────────────────────────────
# Unraid creates a new share when a template points at a /mnt/user/<x> that
# does not exist. If this container's data lives on a different user share
# than Docker's appdata path (Settings → Docker), that is the likely cause.
if [ -r /host/boot/config/docker.cfg ]; then
  docker_appdata=$(sed -n 's/^DOCKER_APP_CONFIG_PATH="\(.*\)"$/\1/p' /host/boot/config/docker.cfg)
  home_share=$(awk -v mp="$CLAUDE_HOME" '$5 == mp { for (i = 7; i <= NF; i++) if ($i == "-") { if ($(i + 1) == "fuse.shfs") print $4; exit } }' /proc/self/mountinfo \
    | cut -d/ -f2)
  docker_share=$(printf '%s' "$docker_appdata" | cut -d/ -f4)
  if [ -n "$home_share" ] && [ -n "$docker_share" ] && [ "$home_share" != "$docker_share" ]; then
    echo "Warning: this container's data is on the user share '$home_share', but Docker's appdata path is"
    echo "  $docker_appdata. If you did not create '$home_share' yourself, Unraid created it from the template"
    echo "  path: point the Data and Workspace paths at $docker_appdata instead."
  fi
fi

# ── Docker access ────────────────────────────────────────────────────────────
# The template mounts the socket proxy's directory, not the raw socket. The
# proxy container may start after this one, so wait for its socket a while.
DOCKER_MODE=$(docker-mode)
case "${DOCKER_HOST:-}" in
  unix://*)
    if [ "$DOCKER_MODE" = none ]; then
      echo "Waiting up to 60 s for the Docker proxy socket ${DOCKER_HOST#unix://} ..."
      for _ in $(seq 60); do
        sleep 1
        DOCKER_MODE=$(docker-mode)
        [ "$DOCKER_MODE" = none ] || break
      done
    fi ;;
esac
case "$DOCKER_MODE" in
  proxy)
    echo "Docker: through the socket proxy (${DOCKER_HOST#unix://})."
    as_claude docker version >/dev/null 2>&1 \
      || echo "Warning: Claude's user cannot use the proxy socket. In claude-docker-proxy set the socket mode to 0660 and ExtraParams --user 0:100."
    ;;
  full)
    echo "Docker: raw socket mounted. This container is root-equivalent on the host."
    [ -z "${DOCKER_HOST:-}" ] || echo "Warning: DOCKER_HOST is set, but with the raw socket mounted the proxy is no boundary."
    ;;
  *) echo "Warning: no Docker access. Is the claude-docker-proxy container running?" ;;
esac

# ── Make sure the host helper image is available ─────────────────────────────
# `host` (and the scan below) start a tiny helper container; pull it now so
# the first host command does not stall or fail on a cold cache. Only with the
# raw socket: the proxy refuses pulls and container creation.
if [ "$DOCKER_MODE" = full ]; then
  if ! docker image inspect "$HOST_HELPER_IMAGE" >/dev/null 2>&1; then
    timeout 60 docker pull -q "$HOST_HELPER_IMAGE" >/dev/null 2>&1 \
      || echo "Warning: could not pull $HOST_HELPER_IMAGE within 60 s — the first host command will pull it instead."
  fi
fi

# ── Unraid API MCP server ────────────────────────────────────────────────────
# Managed MCP config: Claude Code loads only the servers in this root-owned
# file, so Claude can neither change this one nor add others. An empty map
# when the API is not configured. The key goes into a root-owned file that
# only the MCP server (group of Claude's user) reads.
MANAGED_MCP=/etc/claude-code/managed-mcp.json
[ -s "$MANAGED_MCP" ] || printf '{"mcpServers": {}}\n' > "$MANAGED_MCP"
case "$(unraid-mcp-config "$MANAGED_MCP" || echo failed)" in
  configured) echo "Unraid API: read-only MCP server configured (${UNRAID_API_URL})." ;;
  not-configured) echo "Unraid API: not configured (set Unraid API URL and Key in the template)." ;;
  *) echo "Warning: Unraid API MCP server could not be configured; see above." ;;
esac

# The fix tools (watcher/src/fix-mcp.mjs): Claude's only way to change
# anything. The server holds no secrets; every call goes to the watcher's
# socket and waits for the owner's Allow in Discord. Listed only when the
# watcher runs, since nobody could approve anything otherwise.
WATCH_DIR=/usr/local/share/claude-unraid-manager/watcher
FIX_SOCKET_DIR=/run/unraid-watch
DISCORD_OK=false
if [ -n "${DISCORD_BOT_TOKEN:-}" ] && [[ "${DISCORD_USER_ID:-}" =~ ^[0-9]{17,20}$ ]]; then DISCORD_OK=true; fi
if [ "$DISCORD_OK" = true ]; then
  jq --arg node "$WATCH_DIR/node" --arg mcp "$WATCH_DIR/src/fix-mcp.mjs" --arg sock "$FIX_SOCKET_DIR/fix.sock" \
    '.mcpServers.fix = {type: "stdio", command: $node, args: [$mcp], env: {UNRAID_FIX_SOCKET: $sock}}' \
    "$MANAGED_MCP" > "$MANAGED_MCP.tmp" && mv "$MANAGED_MCP.tmp" "$MANAGED_MCP"
else
  jq 'del(.mcpServers.fix)' "$MANAGED_MCP" > "$MANAGED_MCP.tmp" && mv "$MANAGED_MCP.tmp" "$MANAGED_MCP"
fi
chmod 0644 "$MANAGED_MCP"

# ── Read-only host checks over SSH ───────────────────────────────────────────
# The key is created once and persisted in Claude's home. Installing the host
# side is the user's step (host-readonly-setup prints it); the container never
# writes to the host. Without the raw socket, `host` goes through this.
if [ ! -f "$CLAUDE_HOME/.ssh/claude-host-readonly" ]; then
  as_claude host-readonly-setup --authorized-key >/dev/null 2>&1 \
    || echo "Warning: could not create the SSH key for host checks."
fi
if [ "$DOCKER_MODE" != full ]; then
  if [ -z "${UNRAID_SSH_HOST:-}" ]; then
    echo "Host checks: not set up. Steps: docker exec -it $(hostname) host-readonly-setup"
  elif v=$(as_claude timeout 15 host version 2>&1); then
    shipped=$(sed -n 's/^VERSION=//p' /usr/local/share/claude-unraid-manager/host-readonly)
    if [ "$v" = "$shipped" ]; then
      echo "Host checks: over SSH to ${UNRAID_SSH_HOST} (host-readonly $v)."
    else
      echo "Host checks: the host has host-readonly version $v, this image ships $shipped. Update it: docker exec -it $(hostname) host-readonly-setup"
    fi
  else
    echo "Warning: host checks over SSH to ${UNRAID_SSH_HOST} failed: $v"
  fi
fi

# ── Generate / refresh CLAUDE.md ─────────────────────────────────────────────
# As root: it reads the flash drive, which only root may read. The result
# belongs to Claude's user, so the Custom section stays editable.
/usr/local/bin/generate-claude-md.sh
chown "$CLAUDE_USER":"$(id -g "$CLAUDE_USER")" /workspace/CLAUDE.md

# ── Build the claude launch arguments ────────────────────────────────────────
ARGS=()
[ "$CONTINUE" = "true" ] && ARGS+=(--continue)
# Remote Control needs a claude.ai login; with an API key it cannot start.
# REMOTE_CONTROL_NAME=off disables it explicitly.
REMOTE_CONTROL=false
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is set: Remote Control disabled (requires a claude.ai login)."
elif [ -n "$RC_NAME" ] && [ "$RC_NAME" != "off" ]; then
  ARGS+=(--remote-control "$RC_NAME")
  REMOTE_CONTROL=true
fi

# ── Start tmux with Claude inside, as Claude's user ──────────────────────────
# "=" makes tmux match the session name exactly instead of by prefix. For
# pane targets (send-keys) the session must end with ":" or tmux reads the
# whole string as a pane name.
if ! as_claude tmux has-session -t "=$SESSION" 2>/dev/null; then
  as_claude tmux new-session -d -s "$SESSION" -c /workspace
  # Small delay so tmux is fully ready before sending keys
  sleep 0.3
  # claude-session restarts claude if it exits; %q keeps names with spaces intact.
  as_claude tmux send-keys -t "=$SESSION:" "clear; $(printf '%q ' claude-session "${ARGS[@]}")" C-m
fi

# ── Discord watcher ──────────────────────────────────────────────────────────
# Runs as root so Claude's user cannot read its bot token, its state or the
# host-fix key. It checks the server without AI, asks Claude (claude -p, as
# Claude's user) to explain problems, and sends everything to the owner's
# Discord DM. Changes happen only through its buttons and the fix tools, each
# after the owner's tap.
if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
  if [ "$DISCORD_OK" != true ]; then
    echo "Discord: bot token is set, but 'Discord user ID' is empty or not a number. Watcher not started."
  else
    mkdir -p /workspace/watch
    chown "$CLAUDE_USER":"$(id -g "$CLAUDE_USER")" /workspace/watch
    # The watcher keeps its state (rules, audit log, host-fix key) in
    # /workspace/.unraid-watch, root only. Claude's user owns /workspace and
    # could swap that folder at any time, so the watcher checks and pins it
    # itself (watcher/src/statedir.mjs); nothing here touches it by path.
    # The socket the fix tools talk to: root and Claude's group only.
    mkdir -p "$FIX_SOCKET_DIR"
    chown root:"$(id -g "$CLAUDE_USER")" "$FIX_SOCKET_DIR"
    chmod 0750 "$FIX_SOCKET_DIR"
    (
      if [ -n "${UNRAID_API_CA_BUNDLE:-}" ]; then export NODE_EXTRA_CA_CERTS="$UNRAID_API_CA_BUNDLE"; fi
      while true; do
        rc=0
        "$WATCH_DIR/node" "$WATCH_DIR/src/main.mjs" || rc=$?
        if [ "$rc" = 2 ]; then
          echo "Discord watcher: configuration error (see above), not restarting."
          break
        fi
        echo "Discord watcher stopped (exit $rc); restarting in 30 s."
        sleep 30
      done
    ) &
    echo "Discord: watcher running; reports go to your Discord DMs (morning report: ${REPORT_TIME:-08:00})."
    if [ -z "${UNRAID_SSH_HOST:-}" ]; then
      echo "Fixes: start/stop/restart work; updates and permission fixes need the host-fix setup: docker exec -it $(hostname) host-fix-setup"
    fi
  fi
else
  echo "Discord: not set up. Add a bot token and your Discord user ID in the template to get reports."
fi

echo "Claude Unraid Manager is running (Claude as user $CLAUDE_USER, not root)."
echo "  Attach: docker exec -it \$(hostname) bash"
if [ "$REMOTE_CONTROL" = true ]; then
  echo "  Remote: open the Claude app and look for '$RC_NAME'"
else
  echo "  Remote: Remote Control is disabled"
fi
# A claude.ai login leaves .credentials.json and an oauthAccount entry in .claude.json.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$CLAUDE_HOME/.claude/.credentials.json" ] \
   && ! grep -qs oauthAccount "$CLAUDE_HOME/.claude.json"; then
  echo "  Login:  not logged in yet — attach and complete the login once"
fi

# Keep the container alive without burning CPU. On stop, end the tmux server
# first so Claude shuts down cleanly instead of being killed with the container.
shutdown() {
  as_claude tmux kill-server 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT
tail -f /dev/null &
wait $!
