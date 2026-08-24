# WhatsApp for Omarchy

WhatsApp in the Omarchy Quattro bar: unread badge, desktop notifications you can
click, inline reply without leaving the bar, and one keystroke to the full
WhatsApp Web client when you need media, calls, or search.

<p align="center">
  <img src="docs/inbox.png" alt="Chat list in the Omarchy bar" width="48%" />
  <img src="docs/chat.png" alt="Conversation with inline reply" width="48%" />
</p>

## How it works

Two pieces, on purpose:

| Piece | Job |
|-------|-----|
| **Bridge daemon** (Node + [Baileys](https://github.com/WhiskeySockets/Baileys)) | Holds one linked-device session, receives messages, sends notifications, sends your replies |
| **Bar plugin** (QML) | Unread badge, chat list, conversation view, reply box |

They talk NDJSON over a unix socket in `$XDG_RUNTIME_DIR` — no localhost port,
no auth token, no browser running in the background just to get a notification.
The daemon is the fan-out point, so bars on several monitors stay in sync and a
notification click reaches whichever panel is on screen.

The **full client** is separate on purpose too: the bar panel is for reading and
replying, and the WhatsApp Web app window handles everything heavier. WhatsApp
allows up to four linked devices, so the bridge and the web app can be linked at
the same time.

## Install

```sh
omarchy plugin add https://github.com/srineshr1/omarchy-whatsapp.git --enable --yes
```

That is enough. The first time the widget starts it installs Node deps, the
`omarchy-whatsapp` user service, and CLI links. Click the icon and press Login.

From a source checkout instead:

```sh
git clone https://github.com/srineshr1/omarchy-whatsapp.git
cd omarchy-whatsapp
./install.sh
```

Requirements: Omarchy 4 (Quattro) and Node.js 20+. If Node lives in a version
manager (mise, proto, fnm, volta, nvm) setup finds it and pins the path into
the service unit.

## Link your account

Click the WhatsApp icon in the bar and scan the QR code, or:

```sh
omarchy-whatsapp login                 # QR in the terminal
omarchy-whatsapp login --pair 919812345678   # 8-digit code instead
```

On your phone: **Settings → Linked devices → Link a device**.

The code refreshes itself every ~20 seconds (WhatsApp expires each one), so the
panel always shows a live code — no need to reopen anything.

After five minutes without a scan the daemon **pauses** and removes the code
rather than leave an expired one on screen looking scannable. The panel then
offers **Show QR code**, and `omarchy-whatsapp login` reopens the window too.
That cap also keeps an unlinked install from polling WhatsApp's pairing endpoint
forever. To change it:

```sh
systemctl --user edit omarchy-whatsapp     # Environment=OMARCHY_WHATSAPP_PAIRING_WINDOW_MS=600000
```

## Use it

| Action | How |
|--------|-----|
| Open the panel | Click the bar icon |
| Move through chats | `j` / `k` or arrow keys |
| Refresh chats | Refresh button, or `r` |
| Open a chat | `Enter` |
| Reply | Type, then `Enter` |
| Back to the chat list | `Escape` |
| Close the panel | `Escape` from the list |
| Full WhatsApp Web | Right-click the icon, or the ⧉ button in the panel |
| Log out | Power button on the chat list |
| Open a chat from a notification | Click the notification |

Opening a chat marks it read on every device. Messages arriving while a
conversation is open are marked read immediately.

Desktop alerts and the bar's unread total follow WhatsApp's chat preferences:
muted chats (including **Always**) and chats that remain archived do not alert
or add to the total. Timed mutes expire automatically and refresh the badge.
If WhatsApp is set to unarchive a chat when a new message arrives, that
now-active chat alerts as normal. After upgrading, reconnect once so Always
mutes muted before this fix are rewritten from WhatsApp app-state.

## CLI

```sh
omarchy-whatsapp status                          # connection, account, unread
omarchy-whatsapp send 919812345678@s.whatsapp.net "on my way"
omarchy-whatsapp chats 10                        # recent chats as JSON
omarchy-whatsapp refresh                         # resync the chat list from WhatsApp
omarchy-whatsapp focus 919812345678@s.whatsapp.net   # open the panel on a chat
omarchy-whatsapp open                            # full web client
omarchy-whatsapp restart | logs | logout
omarchy-whatsapp uninstall                       # service, CLI, credentials
```

The first widget start (or `omarchy-whatsapp setup`) links these into
`~/.local/bin`. `omarchy-whatsapp-ctl -h` lists the raw daemon commands.

Disabling the bar plugin also disables and stops the `omarchy-whatsapp` user
service (the unit uses `Restart=on-failure` so a clean disable exit does not
come back). Re-enabling the plugin starts it again when `autostartDaemon` is
enabled.

## Settings

Per-widget settings live inline on the bar entry in `~/.config/omarchy/shell.json`
and hot-reload on save:

```json
{ "id": "io.github.ricky.whatsapp", "showUnreadCount": true, "chatLimit": 40 }
```

| Key | Default | Meaning |
|-----|---------|---------|
| `socketPath` | `""` | Daemon socket; blank uses `$XDG_RUNTIME_DIR/omarchy-whatsapp.sock` |
| `autostartDaemon` | `true` | Start the daemon if the socket is missing |
| `showUnreadCount` | `true` | Show the count next to the icon |
| `hideWhenEmpty` | `false` | Hide the widget entirely when nothing is unread |
| `chatLimit` | `40` | Chats listed in the panel |
| `messageLimit` | `60` | Messages loaded per conversation |
| `webAppUrl` | `https://web.whatsapp.com` | Full client URL |
| `webAppPattern` | `web.whatsapp.com` | Window pattern used to focus the full client |

Move the widget:

```sh
omarchy bar move io.github.ricky.whatsapp --section right
```

## What it stores, and where

| Path | Contents |
|------|----------|
| `~/.local/state/omarchy-whatsapp/auth/` | Linked-device credentials and Signal keys (`0700`) |
| `~/.local/state/omarchy-whatsapp/store.json` | Recent chats and up to 200 messages per chat (`0600`) |
| `$XDG_RUNTIME_DIR/omarchy-whatsapp.sock` | Control socket (`0600`, cleared on logout) |

Nothing leaves your machine except traffic to WhatsApp itself. Media is never
downloaded — photos and voice notes show as `📷 Photo`, `🎤 Voice message`, and
so on. Open the full client for the real thing.

`omarchy-whatsapp logout` unlinks the device and deletes all three.

Disabling the bar widget with `omarchy plugin disable io.github.ricky.whatsapp`
also stops and disables the WhatsApp user service. Linked-device credentials
and the chat cache are retained, so enabling the widget again can resume
without another QR scan. To stop the service and delete local data, use
`omarchy-whatsapp uninstall` instead.

## Things worth knowing before you install

- **Baileys is an unofficial WhatsApp Web client.** It is not endorsed by
  WhatsApp, and using it carries some risk to your account. It is the same
  mechanism every WhatsApp bridge on Linux uses, but the risk is yours.
- **The version is pinned deliberately.** `baileys@6.7.24`. npm's `latest`
  (6.17.16) is deprecated for a message-spoofing zero-day
  ([GHSA-qvv5-jq5g-4cgg](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg));
  do not bump it without checking that advisory.
- **Plugins run unsandboxed inside `omarchy-shell`.** This one keeps its network
  and protocol work in a separate process for exactly that reason — the QML side
  only parses JSON from a socket it owns — but you should still read the code
  before enabling it.
- **The daemon stays "offline" to WhatsApp** (`markOnlineOnConnect: false`) so
  your phone keeps its own notifications working.
- **Read receipts are sent** when you open a chat, the same as opening it on your
  phone.

## Troubleshooting

**Icon is dim / "Daemon offline"**

```sh
systemctl --user status omarchy-whatsapp
journalctl --user -u omarchy-whatsapp -n 50
```

**"no Node.js >= 20 found"** — install `nodejs`, or point the service at your
interpreter: `systemctl --user edit omarchy-whatsapp` and add
`Environment=OMARCHY_WHATSAPP_NODE=/path/to/node`.

**Daemon restart-loops / `EALLOWGIT` / `Permission denied (publickey)`**

The first start installs daemon dependencies from the lockfile.
`baileys@6.7.24` pulls `libsignal` from GitHub, and npm 12 refuses git
dependencies unless `allow-git` is set. Setup now opts in for this
project and clones over HTTPS, so a GitHub SSH key is not required.
Update the plugin if you installed before that fix — an older lockfile
recorded `git+ssh`. `git` must be on `PATH` (it is, if you installed
with `omarchy plugin add`).

**Widget not in the bar**

```sh
omarchy plugin list --json | jq '.[] | select(.id == "io.github.ricky.whatsapp")'
omarchy-shell shell rescanPlugins
qs log -p "$OMARCHY_PATH/shell" --tail 100
```

**Stuck on "Reconnecting…"** — `omarchy-whatsapp ctl reconnect`, then re-link
with `omarchy-whatsapp login` if the phone dropped the device.

## Remove

```sh
omarchy plugin remove io.github.ricky.whatsapp
```

The next login (or `systemctl --user start omarchy-whatsapp-sweep`) deletes the
user service, CLI links, credentials, and chat cache. To wipe immediately:

```sh
omarchy-whatsapp uninstall
# or, from a source checkout:
./install.sh --uninstall
```

## License

MIT. See [LICENSE](LICENSE).
