#!/bin/bash
# generate-claude-md.sh — runs on every container start.
# Regenerates the "Detected Environment" section of CLAUDE.md while
# preserving the base rules and any user customizations below "## Custom".
#
# Paths can be overridden through the environment so the script can be
# exercised outside the container (see tests/run.sh).
set -euo pipefail

DEST="${CLAUDE_MD_DEST:-/workspace/CLAUDE.md}"
SHARE="${CLAUDE_MD_SHARE:-/usr/local/share/claude-unraid-manager}"
BASE="$SHARE/claude-md/base.md"
SNIP="$SHARE/claude-md/snippets"
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
# full (raw socket), proxy (filtering socket proxy) or none; see docker-mode.
DOCKER_MODE=$(DOCKER_SOCK="$DOCKER_SOCK" docker-mode 2>/dev/null || echo none)
MARKER_START="## Detected Environment"
MARKER_CUSTOM="## Custom"

# ── Preserve user's custom section if it exists ──────────────────────────────
CUSTOM_SECTION=""
if [ -f "$DEST" ] && grep -q "^$MARKER_CUSTOM" "$DEST"; then
  CUSTOM_SECTION=$(sed -n "/^$MARKER_CUSTOM/,\$p" "$DEST")
fi

# ── Write the base rules ────────────────────────────────────────────────────
cp "$BASE" "$DEST"

# ── Language setting ─────────────────────────────────────────────────────────
if [ -n "${CLAUDE_LANG:-}" ]; then
  cat >> "$DEST" <<EOF

## Language

Respond in ${CLAUDE_LANG}. Use English for technical terms (Docker, ZFS, container names, CLI commands).

EOF
fi

# ── Host scan ────────────────────────────────────────────────────────────────
# The scan itself lives in host-readonly ("scan"), so one fixed script runs on
# the host in both modes: with the raw socket through the privileged helper
# (script on stdin), behind the socket proxy over SSH, where the copy the user
# installed on the flash drive answers. One ::KEY::value line per item; values
# that span several lines are joined with "|", lists use ",".
HOST_RO="$SHARE/host-readonly"
host_scan() {
  if [ "$DOCKER_MODE" = full ]; then
    host bash -s -- scan < "$HOST_RO"
  elif [ -n "${UNRAID_SSH_HOST:-}" ] && [ -f "${CLAUDE_HOME:-$HOME}/.ssh/claude-host-readonly" ]; then
    host scan
  else
    return 3
  fi
}
scan_note() {
  if [ "$1" = 3 ]; then
    echo "_Host checks are not set up (behind the socket proxy they run over SSH), so system, storage, VM and plugin details are missing. The user sets them up with \`docker exec -it $(hostname) host-readonly-setup\`._"
  elif [ "$DOCKER_MODE" = full ]; then
    echo "_Host scan failed (helper image not available or Docker unreachable), so system, storage, VM and plugin details are missing. Restart the container to retry, or run \`host uptime\` to check._"
  else
    echo "_Host scan over SSH failed, so system, storage, VM and plugin details are missing. Run \`host version\` to see why (SSH off, key not installed, or wrong UNRAID_SSH_HOST)._"
  fi
}

SCAN=""
# First line of a ::KEY:: entry (values never contain newlines, see above).
get()   { printf '%s\n' "$SCAN" | sed -n "s/^::${1}:://p" | head -1; }
# A "|"-joined value as separate lines.
lines() { get "$1" | tr '|' '\n' | sed '/^$/d'; }
# A ","-joined value as "a, b, c".
csv()   { get "$1" | sed 's/,$//; s/,/, /g'; }

# Container snapshot; `docker ps` works with the raw socket and through the proxy.
list_containers() {
  local containers count
  containers=$(docker ps -a --format '- {{.Names}} ({{.Image}}, {{.Status}})' 2>/dev/null || true)
  count=$(printf '%s' "$containers" | grep -c . || true)
  echo "### Containers (${count} total)"
  echo ""
  printf '%s\n' "$containers" | head -40
  if [ "$count" -gt 40 ]; then
    echo "- … and $((count - 40)) more (list truncated; use \`docker ps -a\` for all)"
  fi
  echo ""
  echo "_Snapshot from container start: names, images and status only. Use \`docker ps -a\`, \`docker inspect <name>\` and \`docker logs <name>\` for current state and details._"
  echo ""
}

# ── Discovery scan ───────────────────────────────────────────────────────────
{
  echo ""
  echo "$MARKER_START"
  echo ""
  echo "_Auto-generated on $(date '+%Y-%m-%d %H:%M'). Do not edit — this section is refreshed on every container start._"
  echo ""

  if [ "$DOCKER_MODE" != none ]; then
    if [ "$DOCKER_MODE" = proxy ]; then
      cat "$SNIP/docker-proxy.md"
    else
      cat "$SNIP/docker-socket.md"
    fi

    scan_status=0
    SCAN=$(host_scan 2>/dev/null) || { scan_status=$?; SCAN=""; }

    if [ -z "$SCAN" ]; then
      echo ""
      scan_note "$scan_status"
      echo ""
    else
      VERSION=$(get VERSION)
      HOST=$(get HOSTNAME)
      CPU=$(get CPU)
      RAM=$(get RAM)
      UPTIME=$(get UPTIME)

      echo ""
      echo "### System"
      echo ""
      echo "- **Unraid ${VERSION:-unknown}** | ${CPU:-unknown CPU} | ${RAM:-?} RAM | Hostname: ${HOST:-unknown}"
      echo "- ${UPTIME:-uptime unknown}"
      echo ""

      # ── Storage ────────────────────────────────────────────────────────────
      echo "### Storage"
      echo ""

      ZFS_POOLS=$(lines ZFS_POOLS)
      ZFS_DATASETS=$(lines ZFS_DATASETS)
      ZFS_ENCRYPTED=$(csv ZFS_ENCRYPTED)
      # Keep only filesystems with a real block device. Unraid's docker.img and
      # libvirt.img are btrfs images on /dev/loop*, not storage.
      BTRFS=$(get BTRFS | tr '|' '\n' | awk '
        BEGIN { RS = ""; FS = "\n" }
        {
          keep = 0
          for (i = 1; i <= NF; i++) if ($i ~ /path \/dev\// && $i !~ /path \/dev\/loop/) keep = 1
          if (keep) for (i = 1; i <= NF; i++) if ($i ~ /Label|Total devices/) print $i
        }')
      ARRAY_STATE=$(get ARRAY_STATE)
      POOLS=$(csv POOLS)

      if [ -n "$ZFS_POOLS" ]; then
        echo "**ZFS pools:**"
        echo ""
        echo '```'
        echo "NAME    SIZE   ALLOC  FREE   HEALTH"
        echo "$ZFS_POOLS"
        echo '```'
        echo ""
        if [ -n "$ZFS_DATASETS" ]; then
          echo "Datasets (name, used, avail, mountpoint; first 30):"
          echo ""
          echo '```'
          echo "$ZFS_DATASETS"
          echo '```'
          echo ""
        fi
        if [ -n "$ZFS_ENCRYPTED" ]; then
          echo "Encrypted datasets: ${ZFS_ENCRYPTED}"
          echo ""
        fi
        echo "Commands: \`host zpool status\`, \`host zfs list\`, \`host zpool scrub <pool>\`"
        echo ""
      fi

      if [ -n "$BTRFS" ]; then
        echo "**btrfs volumes:**"
        echo ""
        echo "$BTRFS" | awk '{print "  " $0}'
        echo ""
        echo "Commands: \`host btrfs filesystem show\`, \`host btrfs scrub status <mount>\`, \`host btrfs filesystem usage <mount>\`"
        echo ""
      fi

      ARRAY_MDSTATE=$(printf '%s' "$ARRAY_STATE" | grep -oP '(?<=mdState=)\w+' || true)
      ARRAY_DISKS=$(printf '%s' "$ARRAY_STATE" | grep -oP '(?<=mdNumDisks=)\d+' || true)
      if [ -n "$ARRAY_MDSTATE" ] && [ "${ARRAY_DISKS:-0}" != "0" ]; then
        echo "**Unraid array:** ${ARRAY_MDSTATE} (mdNumDisks=${ARRAY_DISKS})"
        echo ""
        echo "Commands: \`host mdcmd status\`"
        echo ""
      elif [ -n "$ARRAY_MDSTATE" ]; then
        # Unraid 7 can run the array service with no data disks at all.
        echo "**Unraid array:** ${ARRAY_MDSTATE} with 0 data disks (pool-only setup; all data lives on pools)."
        echo ""
      else
        echo "**Unraid array:** state unknown (\`mdcmd status\` returned nothing)."
        echo ""
      fi

      if [ -n "$POOLS" ]; then
        echo "**Pools** (from \`/boot/config/pools/\`): ${POOLS} — mounted at \`/mnt/<name>\`"
        echo ""
      fi

      if [ -z "$ZFS_POOLS" ] && [ -z "$BTRFS" ]; then
        echo "No ZFS or btrfs detected. Pools may use XFS (single-device)."
        echo ""
      fi

      SHARES=$(csv SHARES)
      if [ -n "$SHARES" ]; then
        echo "**Shares:** ${SHARES}"
        echo ""
      fi
    fi

    # ── Docker containers ────────────────────────────────────────────────────
    list_containers

    if [ -n "$SCAN" ]; then
      # ── VMs ────────────────────────────────────────────────────────────────
      VMS=$(lines VMS)
      if [ -n "$VMS" ]; then
        echo "### Virtual Machines"
        echo ""
        while IFS= read -r entry; do
          vm_name=${entry%:*}; vm_state=${entry##*:}
          echo "- ${vm_name}${vm_state:+ (${vm_state})}"
        done <<< "$VMS"
        echo ""
        echo "Commands: \`host virsh list --all\`, \`host virsh dominfo <vm>\`"
        echo ""
      fi

      # ── Plugins ────────────────────────────────────────────────────────────
      PLUGINS=$(get PLUGINS)
      if [ -n "$PLUGINS" ]; then
        echo "### Installed Plugins"
        echo ""
        echo "$PLUGINS" | tr ',' '\n' | sed '/^$/d' | sed 's/^/- /'
        echo ""
      fi

      # ── Network ────────────────────────────────────────────────────────────
      # ── User Scripts ───────────────────────────────────────────────────────
      USERSCRIPTS=$(lines USERSCRIPTS)
      if [ -n "$USERSCRIPTS" ]; then
        echo "### User Scripts"
        echo ""
        # Schedule per script from the plugin's schedule.json, readable through
        # the boot mount when it is present. Keys there contain the script path.
        SCHEDULE="${USERSCRIPTS_SCHEDULE:-/host/boot/config/plugins/user.scripts/schedule.json}"
        schedule_for() {
          [ -r "$SCHEDULE" ] || return 0
          # A disabled script keeps its old cron line in schedule.json; show only "disabled".
          jq -r --arg f "$1" '
            to_entries[] | select(.key | contains("/scripts/" + $f + "/"))
            | .value
            | if .frequency == "disabled" then "disabled"
              else (.frequency // "") + (if (.custom // "") != "" then " " + .custom else "" end) end
          ' "$SCHEDULE" 2>/dev/null | head -1
        }
        while IFS= read -r entry; do
          folder=${entry%%:*}; rest=${entry#*:}
          display=${rest%%:*}; desc=${rest#*:}
          desc=$(printf '%s' "$desc" | sed 's/^ *//; s/ *$//')
          sched=$(schedule_for "$folder")
          line="- ${display}"
          [ -n "$desc" ] && line="${line} — ${desc}"
          [ -n "$sched" ] && line="${line} [${sched}]"
          echo "$line"
        done <<< "$USERSCRIPTS"
        echo ""
        echo "Scripts live in \`/host/boot/config/plugins/user.scripts/scripts/<folder>/script\`; the schedule is in \`/host/boot/config/plugins/user.scripts/schedule.json\`."
        echo ""
      fi

      # Only the host's own interfaces: drop per-container (veth), per-VM
      # (vnet), macvlan shim, Docker (docker0, br-<id>) and libvirt (virbr)
      # bridges and the tunl0 kernel stub. "name state address".
      NETWORK=$(get NETWORK | tr ',' '\n' | sed '/^$/d; s/^\([^@ ]*\)@[^ ]*/\1/; s/ *$//' \
        | grep -vE '^(veth|vnet|shim-|tunl[0-9]|docker0 |br-[0-9a-f]{12} |virbr)' || true)
      if [ -n "$NETWORK" ]; then
        echo "### Host Network Interfaces"
        echo ""
        echo "$NETWORK" | awk '{print "- " $0}'
        echo ""
        echo "Docker and libvirt networks are not listed; use \`docker network ls\` and \`host virsh net-list\`."
        echo ""
      fi
    fi

  else
    echo "**No Docker access.** Cannot see containers or scan the host."
    echo "Expected: the claude-docker-proxy container running, and its socket directory mounted at \`/run/docker-proxy\` (see the template). Tell the user to check that container in the Docker tab."
    echo ""
  fi

  # ── Unraid API ──────────────────────────────────────────────────────────────
  if [ -n "${UNRAID_API_URL:-}" ] && [ -n "${UNRAID_API_KEY:-}" ]; then
    cat "$SNIP/unraid-api.md"
  else
    cat "$SNIP/no-unraid-api.md"
  fi
  echo ""

  # ── Mount analysis ──────────────────────────────────────────────────────────
  # Every bind mount the user added in the template is listed, whatever the
  # container path is called. System mounts and the container's own data
  # paths are left out. A path is read-only if either the bind itself or the
  # underlying filesystem is (per-mount options vs. superblock options in
  # mountinfo). Mount points come octal-escaped from the kernel ("\040" for a
  # space) and are decoded for display. Works with mawk.
  MOUNTINFO="${MOUNTINFO:-/proc/self/mountinfo}"
  RO_RE='(^|,)ro(,|$)'
  # "read-only" / "read-write" for one mount point (last entry wins), empty if not mounted.
  mount_mode() {
    awk -v d="$1" -v ro="$RO_RE" '$5 == d { m = ($6 ~ ro || $NF ~ ro) ? "read-only" : "read-write" } END { print m }' "$MOUNTINFO" 2>/dev/null
  }
  decode_path() {
    printf '%s\n' "$1" | awk '{
      s = $0; out = ""
      while (match(s, /\\[0-7][0-7][0-7]/)) {
        code = substr(s, RSTART + 1, 1) * 64 + substr(s, RSTART + 2, 1) * 8 + substr(s, RSTART + 3, 1)
        out = out substr(s, 1, RSTART - 1) sprintf("%c", code)
        s = substr(s, RSTART + 4)
      }
      print out s
    }'
  }
  # One "escaped-path mode" line per user mount. An over-mounted path keeps its
  # last entry; submounts of a listed path (Docker binds recursively) are folded in.
  user_mounts() {
    awk -v ro="$RO_RE" '{
      mp = $5
      if (mp == "/" || mp ~ "^/(proc|sys|dev)(/|$)" || mp ~ "^/etc/(hosts|hostname|resolv\\.conf)$" ||
          mp == "/root" || mp ~ "^/root/" || mp == "/home/claude" || mp ~ "^/home/claude/" || mp == "/workspace" || mp ~ "docker\\.sock$" ||
          mp == "/run/docker-proxy") next
      print mp, (($6 ~ ro || $NF ~ ro) ? "read-only" : "read-write")
    }' "$MOUNTINFO" 2>/dev/null | tac | awk '!seen[$1]++' | LC_ALL=C sort \
      | awk '{ if (keep != "" && index($1, keep "/") == 1) next; keep = $1; print }'
  }
  echo "### Available Paths"
  echo ""
  MOUNTS=$(user_mounts || true)
  if [ -n "$MOUNTS" ]; then
    echo "| Path | Access | Contents |"
    echo "|------|--------|----------|"
    while read -r raw mode; do
      mp=$(decode_path "$raw")
      items=$( (find "$mp" -mindepth 1 -maxdepth 1 2>/dev/null || true) | wc -l)
      echo "| \`$mp\` | $mode | $items entries |"
    done <<< "$MOUNTS"
  else
    echo "Nothing from the host is mounted besides this container's own data."
  fi
  echo ""
  if [ -n "$SCAN" ]; then
    echo "Shares that appear under **Shares** above but not in this table are not mounted; you cannot read them."
  else
    echo "Host shares that are not in this table are not mounted; you cannot read them."
  fi
  echo "If the user wants you to work with one, do not guess at its contents. Tell them how to add it:"
  echo "Docker tab → this container → Edit → *Add another Path* → Host path \`/mnt/user/<share>\`,"
  echo "Container path \`/<share>\` (any name outside \`/home/claude\`), Access Mode read-only unless you must change files → Apply."
  echo "The container restarts and the path shows up in this table."

  # ── Boot access ────────────────────────────────────────────────────────────
  echo ""
  case "$(mount_mode /host/boot)" in
    read-write) cat "$SNIP/boot-rw.md" ;;
    read-only)  cat "$SNIP/boot-ro.md" ;;
    *)          cat "$SNIP/no-boot.md" ;;
  esac

  # ── Network mode ───────────────────────────────────────────────────────────
  # Host networking means this container shares the host's network namespace;
  # compare namespace identities instead of guessing from interface names
  # (Unraid uses eth0, bond0 or br0 on the host depending on its settings).
  echo ""
  echo "### Network Mode"
  echo ""
  LOCAL_NETNS=$(readlink /proc/self/ns/net 2>/dev/null || true)
  HOST_NETNS=$(get NETNS)
  if [ -n "$HOST_NETNS" ] && [ "$HOST_NETNS" = "$LOCAL_NETNS" ]; then
    echo "Running in **host** network mode. This container shares the host's network stack:"
    echo "all LAN services, VMs and other containers are reachable directly, and the host's ports are this container's ports."
  elif [ -n "$HOST_NETNS" ]; then
    echo "Running in **bridge** (or custom) network mode."
    echo ""
    echo "- Outbound connections work normally: the LAN, VMs, other containers' published ports and the internet are reachable (\`ssh user@<vm-ip>\` is fine)."
    echo "- Nothing can connect *into* this container unless a port is published."
    echo "- Containers on macvlan/ipvlan custom networks (e.g. \`br0\`) may be unreachable unless \"Host access to custom networks\" is enabled in Unraid's Docker settings."
    echo ""
    echo "Host networking is only needed when something must reach this container directly."
  else
    echo "Network mode unknown (host scan unavailable)."
  fi

} >> "$DEST"

# ── Append user's custom section (or create an empty one) ────────────────────
echo "" >> "$DEST"
if [ -n "$CUSTOM_SECTION" ]; then
  echo "$CUSTOM_SECTION" >> "$DEST"
else
  cat >> "$DEST" <<'EOF'
## Custom

Add your own instructions below this line.
They will be preserved when the container restarts.

EOF
fi

echo "CLAUDE.md generated at $DEST"
