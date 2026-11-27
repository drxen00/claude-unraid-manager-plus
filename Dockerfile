# ── build: fetch the Claude Code native binary via npm ───────────────────────
# The npm package's postinstall copies the platform binary over bin/claude.exe;
# `claude` then execs it directly and no Node.js process stays resident. Only
# that one file is carried into the runtime image.
FROM node:22-bookworm-slim AS build

# Pin the Claude Code version so every image is reproducible.
# Bump this (and rebuild) to update Claude Code.
ARG CLAUDE_CODE_VERSION=2.1.296

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && cp -L "$(readlink -f /usr/local/bin/claude)" /claude \
    && chmod 0755 /claude \
    && /claude --version

# ── watcher: the Discord reporter (watcher/), dependencies from the lockfile ──
FROM node:24-trixie-slim AS watcher
WORKDIR /watcher
COPY watcher/package.json watcher/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY watcher/src ./src
RUN node --check src/main.mjs && node --check src/fix-mcp.mjs && node --check src/link-cli.mjs && node --check src/claudechat.mjs && node --check src/terminal.mjs && node --check src/uptime.mjs && node --check src/ownedfs.mjs && cp /usr/local/bin/node /watcher/node

# ── runtime ──────────────────────────────────────────────────────────────────
# Claude Code runs natively. Node.js is only shipped for the watcher, outside
# PATH, and without npm/npx: MCP servers started through `npx` do not work
# inside this container.
# trixie (Debian 13): runraid needs glibc 2.38, bookworm has 2.36.
FROM debian:trixie-slim

COPY --from=build /claude /usr/local/bin/claude
COPY --from=watcher /watcher /usr/local/share/claude-unraid-manager/watcher

# Docker CLI only (Debian's docker.io would pull in dockerd, containerd, runc).
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker

RUN apt-get update && apt-get install -y --no-install-recommends \
      tini tmux git curl ca-certificates openssh-client \
      ripgrep jq procps \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# runraid: Rust MCP server for the Unraid GraphQL API (dinglebear-ai/unraid,
# MIT), the release binary pinned by version and checksum. Bump both together.
ARG RUNRAID_VERSION=0.6.3
ARG RUNRAID_SHA256=bdd510d4bee8d1d432f71f61d06b52cf2fdfbab637d12d86b994e6bf152fa68a
RUN curl -fsSL -o /usr/local/bin/runraid \
      "https://github.com/dinglebear-ai/unraid/releases/download/unraid-rs-v${RUNRAID_VERSION}/runraid-linux-x86_64" \
    && echo "${RUNRAID_SHA256}  /usr/local/bin/runraid" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/runraid

# Claude runs as this unprivileged user, not as root: uid 99 / gid 100
# (nobody:users on Unraid, the usual owner of appdata). The entrypoint runs as
# root, prepares everything, and starts the session as this user. Everything
# that enforces policy (managed settings, the guard, the MCP config and the
# API key file) is root-owned and only readable by it.
ENV CLAUDE_USER=claude \
    CLAUDE_HOME=/home/claude
RUN useradd --uid 99 --gid 100 --home-dir /home/claude --no-create-home --shell /bin/bash claude \
    && mkdir -p /home/claude /workspace \
    && chown 99:100 /home/claude /workspace

# Managed settings: highest precedence, nothing in Claude's own settings can
# override them, and Claude cannot edit them (root-owned, Claude is not root).
COPY managed-settings.json /etc/claude-code/managed-settings.json
RUN chmod 0644 /etc/claude-code/managed-settings.json

# Ship the base CLAUDE.md, snippets, generator and helpers inside the image.
COPY claude-md/            /usr/local/share/claude-unraid-manager/claude-md/
COPY tmux.conf             /usr/local/share/claude-unraid-manager/tmux.conf
# Interactive shells (Console button, docker exec -it ... bash) attach to the
# Claude session. System-wide so it applies regardless of the persisted home.
COPY bashrc                /usr/local/share/claude-unraid-manager/bashrc
RUN printf '\n' >> /etc/bash.bashrc && cat /usr/local/share/claude-unraid-manager/bashrc >> /etc/bash.bashrc
COPY unraid-mcp-tools      /usr/local/share/claude-unraid-manager/unraid-mcp-tools
# Installed on the host by the user (host-readonly-setup prints the steps);
# also run through the privileged helper for the scan when the raw socket is mounted.
COPY host-readonly         /usr/local/share/claude-unraid-manager/host-readonly
# The host fixes, installed the same way (host-fix-setup prints the steps).
COPY host-fix              /usr/local/share/claude-unraid-manager/host-fix
# The Wraith terminal's wrapper, installed the same way (wraith-terminal-setup).
COPY host-shell            /usr/local/share/claude-unraid-manager/host-shell
COPY entrypoint.sh generate-claude-md.sh host boot-mode docker-mode logs claude-guard claude-session unraid-mcp-config host-readonly-setup host-fix-setup wraith-link wraith-terminal-setup /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/generate-claude-md.sh \
             /usr/local/bin/host /usr/local/bin/boot-mode /usr/local/bin/docker-mode /usr/local/bin/logs /usr/local/bin/claude-guard \
             /usr/local/bin/claude-session /usr/local/bin/unraid-mcp-config /usr/local/bin/host-readonly-setup /usr/local/bin/host-fix-setup /usr/local/bin/wraith-link /usr/local/bin/wraith-terminal-setup

# IS_SANDBOX is deliberately not set: it only serves to allow
# --dangerously-skip-permissions as root, which this image does not support.
ENV DISABLE_AUTOUPDATER=1 \
    TERM=xterm-256color \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD pgrep -u 99 -x claude >/dev/null || exit 1

LABEL org.opencontainers.image.source="https://github.com/drxen00/claude-unraid-manager-plus" \
      org.opencontainers.image.description="Claude Code as an Unraid system manager" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
