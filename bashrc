# shellcheck shell=bash
# Appended to /etc/bash.bashrc in the image by claude-unraid-manager.
#
# Every interactive bash in this container (Unraid's Console button, or
# `docker exec -it claude-unraid-manager bash`) attaches straight to the
# Claude session. Ctrl-b then d detaches and lands back in this shell.
# Non-interactive shells (`bash -c`, the healthcheck) do not read this file.
# Living in the image rather than in the persisted home, it applies to every
# install and survives a user's own ~/.bashrc.
#
# The session runs as Claude's user (not root), so its tmux server belongs to
# that user: a root shell attaches through runuser.

__claude_tmux() {
  if [ "$(id -u)" = 0 ] && id "${CLAUDE_USER:-claude}" >/dev/null 2>&1; then
    runuser -u "${CLAUDE_USER:-claude}" -- env HOME="${CLAUDE_HOME:-/home/claude}" tmux "$@"
  else
    tmux "$@"
  fi
}

if [ -z "${TMUX:-}" ] && [ -t 0 ] && __claude_tmux has-session -t "=${TMUX_SESSION:-main}" 2>/dev/null; then
  __claude_tmux attach -t "=${TMUX_SESSION:-main}"
  echo
  if __claude_tmux has-session -t "=${TMUX_SESSION:-main}" 2>/dev/null; then
    echo "Detached from the Claude session (it keeps running)."
    echo "  back in:  run 'bash' again, or: runuser -u ${CLAUDE_USER:-claude} -- tmux attach -t ${TMUX_SESSION:-main}"
    echo "  leave:    exit"
  else
    echo "The Claude session has ended (container stopping, or Claude exited and is restarting)."
  fi
fi
