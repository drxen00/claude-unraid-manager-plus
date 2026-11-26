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
| Never | Disks, array, parity, shares, the USB stick, Unraid settings, a terminal, rebooting or shutting down the server, or anything on this tool's own containers. |
| Not yet | Claude in Wraith, and updating a container from Wraith. Use Discord or the Claude app for those. |

Only the one Wraith account you linked can use it. Anyone else in the space
sees "Link your panel account" and nothing else, and linking needs a code
from your server's terminal.

## Good to know

- **Who you're trusting.** Wraith's server sends each request in your name.
  Whoever runs that server can technically do whatever you can do from these
  channels: look, and start, stop or restart containers. They still can't do
  anything from the "Never" row above, because your server refuses those
  itself, whoever asks. Discord works the same way: Discord itself could act
  through your bot.
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
