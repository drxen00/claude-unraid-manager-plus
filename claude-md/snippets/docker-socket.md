### Docker Access

Docker socket is mounted. You can manage all containers on this server:
`docker ps`, `docker logs`, `docker inspect`, `docker stop/start/restart`,
`docker pull`, `docker create`, `docker rm`, `docker exec`.

Host-level commands run through the `host` wrapper:
```
host zpool status
host sh -c 'ls /boot/config/plugins/*.plg'
```

`host` starts a short-lived helper container (`$HOST_HELPER_IMAGE`, pre-pulled
at start) that enters the host's namespaces
(`docker run --rm --privileged --pid=host <image> nsenter -t 1 -m -u -i -n -p -- <command>`).
This container does not need `--privileged` for that; the Docker socket is
enough. Always use `host …` rather than spelling out the
`docker run … nsenter …` form: it is shorter, avoids quoting mistakes, and is
what the permission rules recognise.

Send Unraid notifications to the user's configured channels (email, Pushover,
Discord, ...) with:

```bash
host /usr/local/emhttp/webGui/scripts/notify -e "Event" -s "Subject" -d "Description" -i "normal|warning|alert"
```

This uses whatever agents the user enabled in Settings → Notification Settings.
