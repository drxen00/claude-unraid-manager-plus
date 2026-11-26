# Wraith server panel

[Wraith](https://wrraith.com) is a self-hosted chat app. Its spaces can have
*panel channels*: instead of messages, they show a server. With this set up,
one of your Wraith spaces shows your Unraid server:

- **#system**: CPU, memory, load, uptime and how full your disks are. Your
  containers are listed with **Start**, **Stop** and **Restart** buttons, and
  you can open their logs.
- **#alerts**: the problems the watcher finds, such as a container that
  crashed, a disk getting full, the array stopped, or Unraid's own warnings.
  They're listed as they come up and as they clear, with a push to your phone
  if you want one. In #alerts you choose which kinds reach your phone, and you
  can mute them for a while.

It runs next to the Discord bot ([discord.md](discord.md)) or on its own.

**Nothing on your server is opened up.** Your server dials out to Wraith,
the way your browser does, so there is no port forwarding, tunnel or
certificate.

## Setup (about 5 minutes)

You need a Wraith space you own. Make a new one for this if you like.

1. **In Wraith:** open the space → **Space settings** → **Server panel**.
   Type a name (e.g. `Castl3`) → **Make a connection code** → **Copy**.
   The code is shown only once. It works like a password, so don't post it.
2. **In Unraid:** **Docker** tab → **claude-unraid-manager** → **Edit**.
   Paste the code into **Wraith connection code** → **Apply**.
   Back in Wraith, the Server panel page should now say **Connected**.
3. **In Wraith:** create the channels. Space settings → **Channels** →
   create a channel, and pick the type **System**, then again for
   **Alerts**. They only appear in a space with a server connected.
4. **Link your account** (once). Open the Unraid terminal (web UI, top
   right, the `>_` icon) and run:
   ```
   docker exec -it claude-unraid-manager wraith-link
   ```
   It shows a code like `K7PD-3MXQ`. In Wraith, open #system, type the code
   into **Link your panel account**, and press Enter. The code works once,
   for 10 minutes. If you use the Discord bot, you can also DM it
   `wraith link` to get a code.

That's it. The container's log says
`unraid-watch: Wraith: connected to https://…` when it's working.

## What it can and cannot do

| | |
|---|---|
| Look | Load, memory, disks, containers, container logs, open problems |
| Change | Start, stop or restart **one container** when you tap the button. It's checked again right before it runs, at most 5 an hour (shared with the Discord buttons), and every tap is logged (`unraid-watch audit:`). |
| Claude | Chat with Claude on this server (see below). Anything it wants to do that its rules don't allow outright waits for your **Allow** in the chat. |
| Terminal | Off unless you turn it on. When on, a **root shell on the Unraid host** (see below). |
| Never (without the terminal) | Disks, array, parity, shares, the USB stick, Unraid settings directly, rebooting or shutting down the server, or anything on this tool's own containers. |

Only the one Wraith account you linked can use it. Anyone else in the space
sees "Link your panel account" and nothing else, and linking needs a code
from your server's terminal.

## Claude

Create a channel of type **Claude** in the space. Each chat is Claude Code on
this server, the same as the Claude app session:
- It runs as Claude's own limited user, in `/workspace`.
- It has the same safety rules and the same tools: logs, docker inspect,
  the read-only host checks, and appdata if mounted.
- Chats are saved the same way, so you can continue a Wraith chat in the
  Claude app and the other way round.

- **Permissions.** When Claude wants to run something its rules don't allow
  by themselves, the chat shows the request with **Allow** and **Deny**, and
  your phone gets a push. Nothing runs until you tap.
- **Fixes.** Restarting, updating, running a command inside a container or
  editing a config file are asked the same way, right in the chat, with the
  exact command or change shown. Fix requests from the Claude app, or from
  Discord, still go to Discord.
- **Model, effort and mode** can be changed per chat. Claude restarts on the
  same chat to switch. "Bypass permissions" is not available.
- At most 3 chats run at once. **End chat** stops one; the transcript stays.

## Terminal (a root shell, opt-in)

The #terminal channel can give you a **root shell on the Unraid host**: the
same power as the Unraid web terminal, from Wraith. It is **off** until you
turn it on, because of what it means. Anyone who controls the Wraith server
could, in theory, type into it as you, and so get full control of the server,
its array and your data.

To turn it on:

1. Unraid **Docker** tab → **claude-unraid-manager** → **Edit** → set
   **Wraith terminal** to `host` → **Apply**.
2. In the Unraid terminal:
   ```
   docker exec -it claude-unraid-manager wraith-terminal-setup
   ```
   Run the commands it prints. They copy a small wrapper to the flash drive
   and allow the terminal's own key, which is separate from the host-fix key.
3. Restart the container. The log says
   `unraid-watch: Wraith terminal: root shell on … works`.
4. Create a channel of type **Terminal** in the space.

How it behaves:
- One command at a time. Its output streams in.
- `cd` carries over to the next command. Variables don't.
- Ctrl-C, Ctrl-D and the like are the buttons under the input.
- If a command asks for input, what you type goes to it, and it's shown as
  dots.
- Full-screen programs (top, vim, mc) don't work here. Use the Unraid web
  terminal for those.

Every command it runs is written to the Unraid syslog first. To read that
record, run this in the Unraid terminal:
`grep claude-wraith-terminal /var/log/syslog`.

To turn it off: set **Wraith terminal** back to `off`, or delete its line
from `/root/.ssh/authorized_keys`.

## Good to know

- **Who you're trusting.** Wraith's server sends each request in your name.
  Whoever runs that server can technically do whatever you can do from these
  channels: look, start, stop or restart containers, chat with Claude and tap
  Allow, and, if you turned it on, use the root terminal. Without the
  terminal, your server still refuses the "Never" row above whoever asks.
  Discord works the same way: Discord itself could act through your bot.
- **The code.** It sits in the container's settings, like the Discord token.
  Claude runs as a separate user and doesn't get it. One known gap is the
  same as for the Discord token: `docker inspect` on this container shows it,
  and Claude may run `docker inspect`. With it, someone could pretend to be
  your server in Wraith. They couldn't change anything on your server. If you
  think the code leaked, click **Make a new code** in Wraith. The old one
  stops working at once, and you paste the new one into the template.
- **Unlink.** Click your name at the top of a panel channel → **Unlink
  account**. Or link a different account with a new `wraith-link` code,
  which replaces the old one.
- **Turn it off.** Empty **Wraith connection code** and apply, or click
  **Disconnect** in Wraith.
- **State.** The linked account and the #alerts history are kept in
  `appdata/claude-unraid-manager/workspace/.unraid-watch/wraith.json`.
  Only root can read it.
