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

You can also write to the bot: `report`, `status`, `check`, `help`, or any
question ("why is plex slow?").

## What it can and cannot do

| | |
|---|---|
| Checks every 15 minutes | Plain scripts, no AI, no cost. |
| Explanations and the morning report | Claude, read-only. It runs with nobody at the keyboard, so anything that would need your approval is refused automatically. Uses your Claude subscription. |
| Buttons | Start, stop or restart **one container**. Nothing else exists. Each button works once, for 15 minutes, at most 5 fixes an hour, and only for your Discord account. The container's state is checked again right before it runs. Every click is logged in the container log (`unraid-watch audit:`). |
| Never | Disks, array, parity, shares, the USB stick, Unraid settings, deleting anything. For those Claude tells you where to click in the Unraid web UI. The watcher can't touch Claude's own two containers either. |

## Setup (about 10 minutes)

### 1. Create the bot

1. Open <https://discord.com/developers/applications> and click **New Application**.
   Name it, e.g. `Castle Watch`.
2. Left menu **Bot**:
   - Click **Reset Token**, then **Copy**. This is the bot token. Treat it
     like a password: anyone with it can post as your bot.
   - Turn **Public Bot** off, so nobody else can add it to their server.
   - No "Privileged Gateway Intents" are needed.
3. Left menu **OAuth2** → **URL Generator**: tick `bot`. Under bot
   permissions tick **Send Messages**. Copy the URL at the bottom, open it,
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
- **Restarts.** Open problems are kept in memory and in the container; after
  the container is re-created, problems that still exist are reported once
  more.
- **Turn it off.** Empty the bot token field and apply.
