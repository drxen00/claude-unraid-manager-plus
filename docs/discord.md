# Discord reports and alerts

The watcher sends you, in a Discord direct message:

- **A morning report** at the time you choose: array and disks, how full they
  are, parity, containers, Unraid's own warnings, in plain English.
- **An alert when something breaks**: a container crashes or keeps
  restarting, a disk gets too full, the array stops or a disk is disabled, or
  Unraid raises a warning or alert. Claude looks into it and tells you what is
  wrong, why, and what to do. One message per problem, and a ✅ when it clears.
- **Buttons to fix it**, when starting, stopping or restarting a container
  would help. Nothing changes until you tap one.
- **Rules you set by talking to it**: "don't tell me about X until Y",
  "let me know when Z happens".

You can also write to the bot: `report`, `status`, `check`, `rules`, `help`,
or any question ("why is plex slow?").

## Telling it what you want to hear about

Talk to it like a person. It turns what you say into a rule, applies it right
away, shows you exactly what it set, and gives you an **Undo** button.

| You say | Rule it sets |
|---|---|
| "Don't tell me about disk space until a disk hits 99%" | 🔕 mute `disk:*:full` until any disk or pool is 99% full or more |
| "Snooze that till Friday" (after an alert) | 🔕 mute that problem until Friday morning |
| "Don't mention parity, I know there isn't any" | 📝 note that every report follows |
| "Let me know when plex is back up" | 🔔 alert once when `plex` is running |
| "Tell me every time plex crashes this week" | 🔔 alert on every new plex problem, ending in 7 days |
| "Let me know when the parity check finishes" | 🔔 alert when Unraid sends a notification matching `*parity*` |
| "Remind me tomorrow at 9 to check the backup" | 🔔 alert at that time |
| "Never mind about plex" | 🗑️ removes that rule |

What it can watch for (the watcher checks these itself every 15 minutes, no
AI): how full a disk or pool is, a container's state (running, stopped,
restarting, unhealthy, healthy, gone), a problem coming up or clearing, a new
Unraid notification (any level) with given words, the array started or
stopped, a parity sync or check running or done, and a time. If you ask for
something outside that list, it says so instead of pretending.

When a mute ends while the problem is still there, you hear about it once
more. An alert for something that's already true ("tell me when plex is
running" while it runs) waits for it to change and happen again. Problems
with the array itself (array stopped, a disk disabled) can't be muted.

Quick versions without Claude:

| Command | What it does |
|---|---|
| `rules` | Every mute, alert and note, with its id (`m1`, `a2`, `n3`). |
| `remove m1`, `remove all` | Remove rules. |
| `mute docker.img`, `mute disk:*:full 30d`, `mute plex 12h` | Mute until removed, or for a while. |
| `snooze plex`, `snooze plex 2d` | Mute for 7 days, or as long as you say. |
| `note don't mention parity` | A standing instruction for every report. |

Muted problems are still checked, just not announced; `status` says how many
are muted. Rules live in the watcher's state (`workspace/.unraid-watch`,
root only), out of Claude's reach. They change only from your own messages
or your taps: a rule Claude suggests in a report or an alert, rather than in
reply to you, is only a button. The bot remembers the last 12 messages, so
"that" means the message you're replying to.

## Fixing things

When an alert comes in, tap **🛠️ Fix it**, or just ask: "sonarr says
permission denied, fix it", "plex won't start, can you sort it out?". Claude
looks into it first (logs, settings), then asks before every single change:

> 🛠️ **Claude wants to update sonarr**: pull the newest image and re-create
> it from its Unraid template (like Update on the Docker tab; settings and
> data stay)
> Why: The log shows a crash that the newer version fixes.
> **Allow** · **Deny**

Nothing happens unless you tap **Allow**. No answer within 15 minutes counts
as no. If you deny, Claude doesn't ask for the same thing again and tells you
the other options. At the end it sends a short report: what was wrong, what
it changed, and whether it works now.

What Claude can do this way:

| Fix | Needs |
|---|---|
| Start, stop or restart a container | Nothing extra |
| Update a container (pull the newest image, re-create it from its template, exactly like **Update** on the Docker tab) | The host-fix setup below |
| Fix the owner of a folder below a container's appdata folder (the usual cause of "permission denied") | The host-fix setup below |

The same tools work from the Claude app (Remote Control): ask there, and the
Allow / Deny question comes to Discord.

### Host-fix setup (once, about 2 minutes)

Updates and permission fixes run on the Unraid host through a second, tiny
script, like the read-only checks: it can do only those two things, only for
containers from the Docker tab and folders below appdata, never for this
tool's own containers or data. Its SSH key belongs to the watcher (root), not
to Claude. In the Unraid terminal:

```
docker exec -it claude-unraid-manager host-fix-setup
```

It prints the commands to copy the script to the USB stick, read it, and
allow the key. "Unraid SSH host" must be set in the template (it already is
if the read-only checks work). Restart the container; the log then says
`unraid-watch: host fixes over SSH to … (host-fix 1)`.

## What it can and cannot do

| | |
|---|---|
| Checks every 15 minutes | Plain scripts, no AI, no cost. |
| Explanations and the morning report | Claude, look only: reports and alerts never change anything. Uses your Claude subscription. |
| Fixes | Only when you ask or tap Fix it, only through the fix tools above, and only after you tap **Allow** for that exact change. One question at a time, at most 10 changes and 30 questions an hour. Every request and answer is logged (`unraid-watch audit:`). |
| Buttons | Start, stop or restart **one container**, change your rules (mute, alert, note), or Fix it. Each button works once, for 15 minutes, and only for your Discord account. The container's state is checked again right before it runs. |
| Never | Disks, array, parity, shares, the USB stick, Unraid settings, editing config files, deleting anything. For those Claude tells you where to click in the Unraid web UI. Claude's own two containers and their data are off limits too. |

## Setup (about 10 minutes)

### 1. Create the bot

1. Open <https://discord.com/developers/applications> and click **New Application**.
   Name it, e.g. `Castle Watch`.
2. Left menu **Installation**: set **Install Link** to **None**, untick
   **User Install**, and save. (Otherwise Discord refuses step 3's "Public
   Bot off" with "Private application cannot have a default authorization
   link".)
3. Left menu **Bot**:
   - Click **Reset Token**, then **Copy**. This is the bot token. Treat it
     like a password: anyone with it can post as your bot.
   - Turn **Public Bot** off, so nobody else can add it to their server.
   - No "Privileged Gateway Intents" are needed.
4. Left menu **OAuth2** → **URL Generator**: tick `bot`. Under bot
   permissions tick **Send Messages**; if asked, Integration Type is
   **Guild Install**. Copy the URL at the bottom, open it,
   and add the bot to a server you are in (any private server; create one if
   needed). Discord only lets a bot DM you if you share a server.

### 2. Find your user ID

In Discord: **Settings → Advanced → Developer Mode** on. Then right-click
your own name (in a member list or a message) → **Copy User ID**. It is a
long number.

### 3. Fill in the template

Unraid **Docker** tab → **claude-unraid-manager** → **Edit**:

- **Discord bot token**: the token from step 1.
- **Discord user ID**: the number from step 2.
- **Morning report time**: e.g. `08:00` (or `off`).
- **Timezone** (if still `UTC`): yours, e.g. `America/Chicago`, so 08:00 is
  your 08:00.

**Apply.** Within a minute the bot DMs you "Unraid watcher started", then a
first message with any problems it already sees.

### 4. Check it

- Container log: `Discord: watcher running` and
  `unraid-watch: connected to Discord as …`.
- Type `help` to the bot.

## Good to know

- **Sources.** Containers come through the socket proxy. The array state and
  disk fill come from the read-only host checks, and Unraid's warnings from
  the read-only API key. Without the host checks or the API key the watcher
  still works, but sees less. It says so ("The watcher can't check …") if a
  source stops answering.
- **Cost.** Each explanation, report or answer is one Claude run on your
  subscription. If you hit your usage limit, alerts still arrive, as a plain
  list without the explanation.
- **Secrets.** The token is only in the watcher's environment (it runs as
  root in the container; Claude runs as a separate user and does not get it).
  One known gap: `docker inspect` on this container shows its environment,
  including the token and the Unraid API key, and Claude may run
  `docker inspect`. With the token Claude could post as the bot; it still
  cannot press your buttons, which only accept clicks from your account.
- **State.** Your rules, the audit log and the host-fix key live in
  `appdata/claude-unraid-manager/workspace/.unraid-watch`, readable by root
  only, so they survive updating the container. Claude's user owns the
  workspace folder and could swap that folder for its own; the watcher
  checks it once at start (a root-only folder, or it is moved aside) and from
  then on only uses the folder it checked, and `host-fix-setup` refuses to
  print a key from a folder that is not root's. Open problems are kept there
  too; after a restart, problems that still exist are reported once more.
- **One thing at a time.** Claude works on one job at a time: while it waits
  for your Allow, a new alert's explanation waits its turn.
- **Turn it off.** Empty the bot token field and apply.
