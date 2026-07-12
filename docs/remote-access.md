# Remote Access: a Home Server Setup

The continuity setup this guide builds: the GoodVibes daemon runs on one
always-on box (a home server, an old laptop, a NAS with a shell), your
sessions live there, and you reach them from anywhere — the webui from any
browser, the TUI over SSH — with [Tailscale](https://tailscale.com) (or a
similar mesh VPN) providing reachability beyond your LAN.

Every command below is real in the current release; the last step validates
the finished setup with `goodvibes doctor`, whose exit code is honest: `0`
when the install is usable, non-zero only for a must-fix finding.

## TLS, stated plainly, in both directions

- **The webui cockpit works over plain `http` on your LAN.** Browsing
  sessions, watching agents, and steering them needs nothing more than
  `http://<server>:3423`.
- **The full progressive-web-app feature set does not.** Browsers gate
  secure-context features — installing the webui as an app, offline caching,
  push notifications, microphone capture — behind `https`. Over plain `http`
  those stay unavailable no matter what GoodVibes does.
- **Providing TLS on a home network is your responsibility.** GoodVibes will
  not conjure a certificate for `192.168.1.20`. The recommended path is
  `tailscale serve` (step 6), which terminates TLS with a real certificate for
  your tailnet hostname. Alternatively, the control plane and HTTP listener
  can terminate TLS themselves (`controlPlane.tls.mode = direct` with
  certificate files — see [Deployment and services](deployment-and-services.md),
  "Inbound TLS").

## Step 1 — install GoodVibes on the always-on box

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

The installer downloads checksum-verified binaries, registers the daemon as a
systemd user service (`goodvibes-daemon.service`), and enables user lingering
so the service starts at boot — no login required, which is the point of an
always-on box. If lingering cannot be enabled non-interactively, the installer
prints the one command to run once (`loginctl enable-linger <user>`).

**You should now see** installer output ending with
`The daemon starts at boot and restarts on failure.` (or, if lingering needs
that one manual command, an explicit note saying so).

## Step 2 — verify the daemon is running

```sh
goodvibes service status
```

(or, equivalently: `systemctl --user status goodvibes-daemon.service`)

**You should now see** the service reported as installed and running. If it
is not, `goodvibes service check` prints what is wrong and exits non-zero.

## Step 3 — create a local admin user

Anything network-facing needs real credentials. Create a local user and retire
the bootstrap credential:

```sh
goodvibes auth add-user admin --password-stdin
goodvibes auth clear-bootstrap
```

Skipping this is not cosmetic: `goodvibes doctor` reports a network-bound
surface without local users as a must-fix finding and exits non-zero in step 7.

**You should now see** the new user listed by `goodvibes auth users`, and
`goodvibes auth status` no longer reporting a bootstrap credential.

## Step 4 — enable the browser surface and bind beyond loopback

By default every surface binds loopback only. Enable the webui and set the
host mode to `network` in the server's settings file
(`~/.goodvibes/tui/settings.json`):

```sh
goodvibes surfaces enable web
```

Then add the bind modes (hand-edit; these keys have no dedicated CLI):

```json
{
  "controlPlane": { "hostMode": "network" },
  "web": { "hostMode": "network" }
}
```

`hostMode: "network"` binds `0.0.0.0`; `"custom"` plus `web.host` /
`controlPlane.host` binds one specific address. The defaults are port `3421`
for the control plane and `3423` for the webui. Restart to apply:

```sh
goodvibes service restart
```

**You should now see** the surfaces reported network-bound:
`goodvibes web` prints the browser surface URL (e.g. `http://0.0.0.0:3423`)
and `goodvibes control-plane status` shows the control-plane bind, local
admin, and token posture.

Note (LAN-only alternative): if you will reach the box exclusively through
`tailscale serve` (step 6), you can leave both host modes `local` — Tailscale
proxies to loopback, and nothing else on the network can reach the surfaces
at all.

## Step 5 — open the webui from another machine on the LAN

From any browser on the same network:

```
http://<server-lan-address>:3423
```

Log in with the user from step 3.

**You should now see** the webui cockpit over plain `http` — sessions,
agents, steering. This is the honest plain-`http` tier: everything works
except the secure-context features listed at the top.

## Step 6 — reachability beyond the LAN, and TLS: Tailscale

Install Tailscale on the server and on each device you'll connect from, then
on the server:

```sh
sudo tailscale up
```

Every device in your tailnet can now reach the box by its Tailscale address or
MagicDNS name — the webui at `http://<server-tailscale-name>:3423`, still
plain `http`.

For TLS (and with it the full webui feature set), serve the browser surface
through Tailscale's built-in reverse proxy, which terminates HTTPS with a
certificate for your tailnet hostname:

```sh
sudo tailscale serve --bg 3423
```

**You should now see** `tailscale serve` print the public-to-your-tailnet
URL it now serves, e.g. `https://myserver.tail1234.ts.net/` — open it from
any tailnet device: the webui over real TLS, secure-context features
available, no certificate work on your part.

## Step 7 — the TUI: over SSH, or cross-machine

Over SSH is the zero-config path — on the server, the TUI adopts the running
daemon automatically (same home directory, same operator token store):

```sh
ssh <server>
goodvibes
```

**You should now see** the TUI running against the same daemon (and the same
sessions) the webui shows.

To point a TUI on a *different* machine at the server's daemon instead, give
both sides one shared token. On the server, start the daemon with
`GOODVIBES_DAEMON_TOKEN=<token>` in its environment; on the client:

```sh
GOODVIBES_DAEMON_TOKEN=<token> goodvibes \
  --config controlPlane.host=<server-tailscale-name> \
  --config controlPlane.port=3421
```

See "Connecting the TUI to an already-running daemon" in
[Deployment and services](deployment-and-services.md) for how the token is
installed and confirmed on each side.

## Step 8 — validate the finished setup

```sh
goodvibes doctor
```

`doctor` prints provider, auth, service, surface, trust, and exposure
findings. Its exit code is the validation: `0` means the install is usable
(advisory findings render as notes); non-zero means a must-fix finding — for
this setup, the ones to care about are a network-bound surface with no local
users or a still-present bootstrap credential (step 3 prevents both). For
CI-grade checking, `goodvibes doctor --strict` also fails on advisory
findings, and `--json` emits the findings machine-readably.

**You should now see** the report end with no must-fix findings and the
command exit `0` (`echo $?`).
