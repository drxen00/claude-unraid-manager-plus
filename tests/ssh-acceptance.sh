#!/bin/bash
# tests/ssh-acceptance.sh <manager-image>
#
# A throwaway OpenSSH server (Debian) with host-readonly installed and the
# manager's key bound to it exactly as host-readonly-setup prints the line.
# Checks, with a real sshd doing the enforcing:
#   - host checks from the manager image work (version, uptime, df, help, scan)
#   - everything else is refused, through `host` and through plain ssh with
#     that key (forced command), and nothing ran on the server
#   - no shell, no stdio/remote forwarding, no scp/sftp with that key
#   - CLAUDE.md gets the full host scan behind the proxy
# Needs Docker. Creates and removes cum-ssh* objects only.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${1:?usage: ssh-acceptance.sh <manager-image>}
NET=cum-ssh-net
SSHD=cum-ssh
HOMEVOL=cum-ssh-home

FAIL=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAIL=1; }
cleanup() {
  docker rm -f "$SSHD" >/dev/null 2>&1
  docker volume rm "$HOMEVOL" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null
docker volume create "$HOMEVOL" >/dev/null
# A fresh volume is root-owned; the entrypoint would hand it to Claude's user.
docker run --rm -v "$HOMEVOL:/home/claude" "$IMAGE" chown 99:100 /home/claude

# The manager image as Claude runs in it: user 99:100, home on a volume.
mgr() {
  docker run --rm -i --network "$NET" --user 99:100 -e HOME=/home/claude \
    -v "$HOMEVOL:/home/claude" -e UNRAID_SSH_HOST="$SSHD" "$IMAGE" bash -c "$1"
}
KEYOPTS='-i /home/claude/.ssh/claude-host-readonly -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/home/claude/.ssh/known_hosts_unraid -o ConnectTimeout=5 -o LogLevel=ERROR'

echo "ssh: setup as printed by host-readonly-setup"
line=$(mgr 'host-readonly-setup --authorized-key')
case "$line" in
  'restrict,command="/bin/bash /boot/config/claude-unraid/host-readonly" ssh-ed25519 '*) pass "authorized_keys line" ;;
  *) fail "authorized_keys line: $line"; exit 1 ;;
esac
if mgr 'host-readonly-setup' | grep -qF "$line"; then pass "setup steps contain the same line"; else fail "setup steps"; fi

docker run -d --name "$SSHD" --network "$NET" -e AK="$line" \
  -v "$ROOT/host-readonly:/boot/config/claude-unraid/host-readonly:ro" \
  debian:trixie-slim bash -c '
    set -e
    apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server procps >/dev/null
    mkdir -p /run/sshd /root/.ssh
    chmod 700 /root/.ssh
    printf "%s\n" "$AK" > /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
    ssh-keygen -A >/dev/null
    echo sshd-ready
    exec /usr/sbin/sshd -D -e' >/dev/null
for _ in $(seq 120); do docker logs "$SSHD" 2>&1 | grep -q sshd-ready && break; sleep 1; done
sleep 2
if docker logs "$SSHD" 2>&1 | grep -q sshd-ready; then pass "sshd up"; else fail "sshd did not start"; docker logs "$SSHD"; exit 1; fi

echo "ssh: allowed checks through host"
ok_out() {
  local label=$1 want=$2 cmd=$3 out
  if out=$(mgr "$cmd" 2>&1) && printf '%s' "$out" | grep -q -- "$want"; then pass "$label"; else fail "$label: $out"; fi
}
ok_out "host version" '^1$' 'host version'
ok_out "host uptime" 'load average' 'host uptime'
ok_out "host df -h" 'Filesystem' 'host df -h'
ok_out "host free" 'Mem:' 'host free'
ok_out "host help" 'read-only checks' 'host help'
ok_out "host scan" '::HOSTNAME::' 'host scan'
out=$(mgr 'host zpool status; echo "status=$?"' 2>&1)
case "$out" in *"not installed"*"status=69"*) pass "missing tool reported (dispatch works)" ;; *) fail "zpool on a host without ZFS: $out" ;; esac

echo "ssh: refused"
refused() {
  local label=$1 cmd=$2 out
  out=$(mgr "$cmd; echo \"status=\$?\"" 2>&1)
  case "$out" in
    *"host-readonly: refused"*"status=65"*) pass "$label refused" ;;
    *) fail "$label: $out" ;;
  esac
}
refused "host touch" 'host touch /tmp/canary'
refused "host rm" 'host rm -rf /tmp'
refused "host cat /etc/shadow" 'host cat /etc/shadow'
refused "host zfs destroy" 'host zfs destroy tank'
refused "host smartctl -t long" 'host smartctl -t long /dev/sda'
refused "host command chaining" 'host "uptime;touch" /tmp/canary'
# shellcheck disable=SC2016 # the literal $(...) is the payload
refused "host substitution" 'host "uptime\$(touch)"'
# Plain ssh with the key: sshd runs host-readonly whatever is asked for.
refused "ssh touch" "ssh $KEYOPTS root@$SSHD 'touch /tmp/canary'"
refused "ssh sh -c" "ssh $KEYOPTS root@$SSHD 'sh -c \"touch /tmp/canary\"'"
refused "ssh bash" "ssh $KEYOPTS root@$SSHD bash"

out=$(mgr "ssh $KEYOPTS root@$SSHD </dev/null; echo \"status=\$?\"" 2>&1)
case "$out" in *"read-only checks"*"status=0"*) pass "no shell: plain login gets the usage text" ;; *) fail "plain login: $out" ;; esac
out=$(mgr "timeout 15 ssh $KEYOPTS -W 127.0.0.1:22 root@$SSHD </dev/null; echo \"status=\$?\"" 2>&1)
case "$out" in *"status=0"*) fail "stdio forwarding (-W) allowed: $out" ;; *) pass "stdio forwarding (-W) refused" ;; esac
out=$(mgr "timeout 15 ssh $KEYOPTS -o ExitOnForwardFailure=yes -N -R 127.0.0.1:2222:127.0.0.1:22 root@$SSHD; echo \"status=\$?\"" 2>&1)
case "$out" in *"status=0"*|*"status=124"*) fail "remote forwarding (-R) allowed: $out" ;; *) pass "remote forwarding (-R) refused" ;; esac
out=$(mgr "timeout 15 scp $KEYOPTS root@$SSHD:/etc/hostname /tmp/copied; echo \"status=\$?\"; test -s /tmp/copied && echo copied" 2>&1)
case "$out" in *copied*|*"status=0"*) fail "scp worked: $out" ;; *) pass "scp refused" ;; esac
out=$(mgr "printf 'get /etc/hostname /tmp/copied\n' | timeout 15 sftp $KEYOPTS -b - root@$SSHD; echo \"status=\$?\"; test -s /tmp/copied && echo copied" 2>&1)
case "$out" in *copied*|*"status=0"*) fail "sftp worked: $out" ;; *) pass "sftp refused" ;; esac

if docker exec "$SSHD" test -e /tmp/canary; then fail "a refused command ran on the server"; else pass "nothing ran on the server"; fi

echo "ssh: CLAUDE.md behind the proxy, scan over SSH"
# docker-mode only needs a socket at DOCKER_HOST to report "proxy"; the
# runner's daemon stands in for the proxy here.
out=$(docker run --rm --network "$NET" --user 99:100 -e HOME=/home/claude -v "$HOMEVOL:/home/claude" -e UNRAID_SSH_HOST="$SSHD" \
  -v /var/run/docker.sock:/run/docker-proxy/docker.sock -e DOCKER_HOST=unix:///run/docker-proxy/docker.sock \
  "$IMAGE" bash -c 'generate-claude-md.sh >/dev/null && cat /workspace/CLAUDE.md' 2>&1)
if printf '%s' "$out" | grep -q 'through the socket proxy'; then pass "proxy mode"; else fail "not in proxy mode"; fi
if printf '%s' "$out" | grep -q '^### System'; then pass "system section from the SSH scan"; else fail "no system section"; fi
if printf '%s' "$out" | grep -q 'Host checks are not set up\|Host scan over SSH failed'; then fail "scan note present"; else pass "no scan failure note"; fi

if [ "$FAIL" -ne 0 ]; then
  echo "ssh acceptance: FAILED"
  exit 1
fi
echo "ssh acceptance: all passed"
