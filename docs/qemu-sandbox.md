# QEMU sandbox bootstrapping

GoodVibes can run REPL and MCP isolation through a local QEMU guest. The TUI owns the setup bundle that turns the user-level `~/.goodvibes/tui/sandbox` directory into a repeatable Debian cloud-image sandbox.

## Isolation modes

QEMU is one option within a broader sandbox control plane that governs both evaluation runtimes and MCP isolation. The available modes are:

- REPL isolation: `shared-vm` or `per-runtime-vm`
- MCP isolation: `disabled`, `shared-vm`, `hybrid`, or `per-server-vm`
- host posture on Windows: `native-basic` or `require-wsl`
- VM backend: `local` or `qemu`

The rest of this document covers the `qemu` VM backend specifically, bootstrapping the guest, generated files, guest runtime packages, and troubleshooting.

The QEMU backend governs REPL and MCP tool isolation only. A separate mechanism, the per-command exec sandbox, governs the `exec` tool's own OS-level boundary and is not part of the QEMU setup at all. On Linux, when `sandbox.enabled` is true and a feature flag is on, shell commands the `exec` tool would otherwise ask permission for instead run inside a bubblewrap (`bwrap`) boundary. The workspace stays writable, the rest of the filesystem is read-only, `/tmp` is isolated, and network access is off by default.

A command whose base name appears in `sandbox.egressAllowlist` (or `*` for all commands) gets its network access back as a named, visible escalation; everything else runs fully offline inside the boundary. This exec sandbox has no VM backend choice and is unavailable on non-Linux hosts; it never claims a boundary it cannot deliver, and it composes with, but does not require, the QEMU setup described below.

## When to use it

Use QEMU when you want tool and REPL execution isolated from the host while still giving GoodVibes a synced workspace at `/workspace`.

The intended settings are:

```text
sandbox.vmBackend = qemu
sandbox.qemuBinary = qemu-system-x86_64
sandbox.qemuImagePath = ~/.goodvibes/tui/sandbox/goodvibes-sandbox.qcow2
sandbox.qemuExecWrapper = ~/.goodvibes/tui/sandbox/qemu-wrapper.sh
sandbox.qemuGuestHost = 127.0.0.1
sandbox.qemuGuestPort = 2222
sandbox.qemuGuestUser = goodvibes
sandbox.qemuWorkspacePath = /workspace
sandbox.qemuSessionMode = launch-per-command
sandbox.replJavaScriptCommand = /home/goodvibes/.bun/bin/bun
sandbox.replIsolation = shared-vm
sandbox.mcpIsolation = shared-vm
```

## Host prerequisites

Install these on the host before building the image:

```sh
qemu-system-x86_64
qemu-img
ssh
ssh-keygen
curl or wget
xorriso, genisoimage, or mkisofs
tar
```

KVM is optional but strongly recommended. On Linux, `/dev/kvm` should exist and be readable/writable by the user running GoodVibes.

## Bootstrap workflow

From inside a project:

```text
/sandbox qemu bootstrap
```

That command generates the setup bundle in `~/.goodvibes/tui/sandbox`, applies the QEMU settings, builds the qcow2 image, launches the guest, and provisions the REPL/MCP runtime set listed below. First boot can take several minutes because cloud-init and package installation run inside the guest.

The command runs its steps in order and waits for each to finish. It prints a progress line as the image build starts, prints another as guest provisioning starts, then prints a final summary once both are done. The image build step is allowed up to 30 minutes and guest provisioning up to 45 minutes before the command gives up and reports a timeout, since first boot can take several minutes even on a fast host. If QEMU exits before SSH becomes available, the generated wrapper fails fast and includes the tail of the QEMU log so port conflicts and startup failures are visible instead of hanging until the SSH timeout.

If you only want to generate/review the bundle without building the image or provisioning the guest:

```text
/sandbox qemu setup
/sandbox qemu bootstrap --scaffold-only
```

Then validate:

```text
/sandbox doctor
/sandbox guest-test eval-py
```

Use `/sandbox qemu setup [dir]` when you want to scaffold and inspect the bundle before applying it. Use `/sandbox qemu inspect-setup <manifest>` and `/sandbox qemu apply-setup <manifest>` to review or reapply a generated manifest.

## Generated files

The setup bundle creates:

```text
~/.goodvibes/tui/sandbox/qemu-wrapper.sh
~/.goodvibes/tui/sandbox/create-image.sh
~/.goodvibes/tui/sandbox/guest-bootstrap.sh
~/.goodvibes/tui/sandbox/goodvibes-sandbox.qcow2
~/.goodvibes/tui/sandbox/images/debian-12-genericcloud-amd64.qcow2
~/.goodvibes/tui/sandbox/keys/goodvibes_qemu_ed25519
~/.goodvibes/tui/sandbox/keys/goodvibes_qemu_ed25519.pub
~/.goodvibes/tui/sandbox/seed/user-data
~/.goodvibes/tui/sandbox/seed/meta-data
~/.goodvibes/tui/sandbox/seed/network-config
~/.goodvibes/tui/sandbox/seed/nocloud.iso
~/.goodvibes/tui/sandbox/logs/
~/.goodvibes/tui/sandbox/run/
~/.goodvibes/tui/sandbox/setup-manifest.json
~/.goodvibes/tui/sandbox/projection-policy.json
~/.goodvibes/tui/sandbox/ssh-config
~/.goodvibes/tui/sandbox/README.txt
```

`projection-policy.json` records the workspace projection (currently just the guest workspace path, `/workspace`). `ssh-config` is a ready-to-use OpenSSH client stanza (`Host goodvibes-qemu`) pointing at the generated key and port, so `ssh -F ~/.goodvibes/tui/sandbox/ssh-config goodvibes-qemu` reaches the guest directly for manual debugging outside the wrapper. `README.txt` is a copy of the same first-run instructions summarized in this document.

`create-image.sh` is generated as a bootstrap implementation detail. Normal setup should use `/sandbox qemu bootstrap` so image creation, settings application, guest launch, and runtime provisioning stay in one recoverable TUI-managed flow.

## Guest boot details

The QEMU wrapper uses:

```text
-netdev user,id=net0,hostfwd=tcp:127.0.0.1:<port>-:22
-device virtio-net-pci,netdev=net0
-smbios type=1,serial=ds=nocloud
```

The cloud-init network config targets Debian's virtio NIC name:

```yaml
version: 2
ethernets:
  ens3:
    match:
      name: "ens3"
    dhcp4: true
    dhcp6: false
    optional: true
```

The generated user-data creates a `goodvibes` sudo user, injects the generated SSH public key, creates `/workspace`, starts SSH, and disables/masks `systemd-networkd-wait-online.service` so first boot does not block long enough to fail wrapper verification.

The wrapper waits up to `GOODVIBES_QEMU_SSH_TIMEOUT` seconds for SSH. The default is `300` because first boot cloud-init can be slow.

## Wrapper modes

The generated wrapper supports:

```text
GV_SANDBOX_WRAPPER_MODE=host-exec
GV_SANDBOX_WRAPPER_MODE=ssh-guest
GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh
```

`launch-qemu-ssh` starts QEMU, waits for SSH, syncs the host workspace into guest `/workspace`, runs the requested command, and cleans up the QEMU process. `ssh-guest` attaches to an already-running guest. `host-exec` is only for wrapper bridge testing.

The wrapper prepends `$HOME/.bun/bin`, `$HOME/.deno/bin`, and `$HOME/.local/bin` to the guest command PATH before execution. The setup manifest also sets `sandbox.replJavaScriptCommand` to `/home/goodvibes/.bun/bin/bun`, so JavaScript-family REPL snippets use the guest Bun runtime instead of a host absolute executable path.

## Guest runtime packages

`guest-bootstrap.sh` installs the runtime/tooling set needed by GoodVibes REPLs and common MCP servers:

```text
ca-certificates
curl
wget
git
jq
tar
unzip
xz-utils
build-essential
python3
python3-pip
python3-venv
nodejs
npm
sqlite3
postgresql-client
mariadb-client
openssh-server
ripgrep
fd-find
shellcheck
make
pkg-config
libssl-dev
python3-dev
golang
cargo
ruby
ruby-dev
```

It also installs TypeScript/GraphQL npm tools:

```text
typescript
tsx
ts-node
graphql
graphql-cli
```

These optional installers are enabled by default and can be disabled with env vars:

```text
GOODVIBES_QEMU_INSTALL_BUN=0
GOODVIBES_QEMU_INSTALL_DENO=0
GOODVIBES_QEMU_INSTALL_UV=0
GOODVIBES_QEMU_INSTALL_DUCKDB=0
```

The bootstrap runs guest provisioning automatically before the sandbox is considered ready. If a runtime is missing, rerun `/sandbox qemu bootstrap` and inspect its printed output plus `~/.goodvibes/tui/sandbox/logs/`.

## Troubleshooting

Useful files:

```text
~/.goodvibes/tui/sandbox/logs/serial-2222.log
~/.goodvibes/tui/sandbox/logs/qemu-2222.log
~/.goodvibes/tui/sandbox/run/qemu-2222.pid
~/.goodvibes/tui/sandbox/run/monitor-2222.sock
```

If SSH never comes up, inspect the serial log first. The usual causes are cloud-init not seeing the NoCloud ISO, the NIC name not matching `ens3`, or first-boot package/network work exceeding the SSH timeout.

If QEMU exits immediately, inspect `qemu-2222.log` and confirm the configured SSH forward port is free:

```sh
ss -ltnp | grep ':2222'
```

Stale QEMU processes can leave the port occupied after an interrupted bootstrap. Stop the old process before retrying, or change `sandbox.qemuGuestPort` if another service legitimately owns that port.

If REPL execution fails before QEMU starts, that is usually a tool invocation/context issue rather than a VM boot issue. Validate the wrapper path directly with:

```text
/sandbox guest-test eval-py
```
