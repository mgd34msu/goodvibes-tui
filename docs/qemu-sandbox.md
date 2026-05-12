# QEMU Sandbox Bootstrapping

GoodVibes can run REPL and MCP isolation through a local QEMU guest. The TUI owns the setup bundle that turns a project-local `.goodvibes/tui/sandbox` directory into a repeatable Debian cloud-image sandbox.

## When To Use It

Use QEMU when you want tool and REPL execution isolated from the host while still giving GoodVibes a synced workspace at `/workspace`.

The intended settings are:

```text
sandbox.vmBackend = qemu
sandbox.qemuBinary = qemu-system-x86_64
sandbox.qemuImagePath = <workspace>/.goodvibes/tui/sandbox/goodvibes-sandbox.qcow2
sandbox.qemuExecWrapper = <workspace>/.goodvibes/tui/sandbox/qemu-wrapper.sh
sandbox.qemuGuestHost = 127.0.0.1
sandbox.qemuGuestPort = 2222
sandbox.qemuGuestUser = goodvibes
sandbox.qemuWorkspacePath = /workspace
sandbox.qemuSessionMode = launch-per-command
sandbox.replJavaScriptCommand = /home/goodvibes/.bun/bin/bun
sandbox.replIsolation = shared-vm
sandbox.mcpIsolation = shared-vm
```

## Host Prerequisites

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

## Bootstrap Workflow

From inside a project:

```text
/sandbox qemu bootstrap .goodvibes/tui/sandbox 20
```

That command generates the setup bundle and applies the QEMU settings. It does not download or build the qcow2 image itself. Run the generated image script next:

```sh
.goodvibes/tui/sandbox/create-image.sh .goodvibes/tui/sandbox/goodvibes-sandbox.qcow2 20G
```

Then validate:

```sh
GV_SANDBOX_SYNC_WORKSPACE=0 GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh .goodvibes/tui/sandbox/qemu-wrapper.sh bash -s < .goodvibes/tui/sandbox/guest-bootstrap.sh
```

That provisioning step installs the REPL/MCP runtime set listed below. Then validate:

```text
/sandbox doctor
/sandbox guest-test eval-py
```

Use `/sandbox qemu setup <dir>` when you want to scaffold and inspect the bundle before applying it. Use `/sandbox qemu inspect-setup <manifest>` and `/sandbox qemu apply-setup <manifest>` to review or reapply a generated manifest.

## Generated Files

The setup bundle creates:

```text
.goodvibes/tui/sandbox/qemu-wrapper.sh
.goodvibes/tui/sandbox/create-image.sh
.goodvibes/tui/sandbox/guest-bootstrap.sh
.goodvibes/tui/sandbox/goodvibes-sandbox.qcow2
.goodvibes/tui/sandbox/images/debian-12-genericcloud-amd64.qcow2
.goodvibes/tui/sandbox/keys/goodvibes_qemu_ed25519
.goodvibes/tui/sandbox/keys/goodvibes_qemu_ed25519.pub
.goodvibes/tui/sandbox/seed/user-data
.goodvibes/tui/sandbox/seed/meta-data
.goodvibes/tui/sandbox/seed/network-config
.goodvibes/tui/sandbox/seed/nocloud.iso
.goodvibes/tui/sandbox/logs/
.goodvibes/tui/sandbox/run/
.goodvibes/tui/sandbox/setup-manifest.json
```

`create-image.sh` downloads the Debian 12 generic cloud image, clones it into the mutable GoodVibes qcow2 image, resizes it, and builds the NoCloud seed ISO.

## Guest Boot Details

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

## Wrapper Modes

The generated wrapper supports:

```text
GV_SANDBOX_WRAPPER_MODE=host-exec
GV_SANDBOX_WRAPPER_MODE=ssh-guest
GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh
```

`launch-qemu-ssh` starts QEMU, waits for SSH, syncs the host workspace into guest `/workspace`, runs the requested command, and cleans up the QEMU process. `ssh-guest` attaches to an already-running guest. `host-exec` is only for wrapper bridge testing.

The wrapper prepends `$HOME/.bun/bin`, `$HOME/.deno/bin`, and `$HOME/.local/bin` to the guest command PATH before execution. The setup manifest also sets `sandbox.replJavaScriptCommand` to `/home/goodvibes/.bun/bin/bun`, so JavaScript-family REPL snippets use the guest Bun runtime instead of a host absolute executable path.

## Guest Runtime Packages

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

Run guest provisioning through the wrapper after the image is created and before relying on JavaScript, TypeScript, SQL, GraphQL, Bun, Deno, DuckDB, or MCP server runtimes:

```sh
GV_SANDBOX_SYNC_WORKSPACE=0 GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh .goodvibes/tui/sandbox/qemu-wrapper.sh bash -s < .goodvibes/tui/sandbox/guest-bootstrap.sh
```

## Troubleshooting

Useful files:

```text
.goodvibes/tui/sandbox/logs/serial-2222.log
.goodvibes/tui/sandbox/logs/qemu-2222.log
.goodvibes/tui/sandbox/run/qemu-2222.pid
.goodvibes/tui/sandbox/run/monitor-2222.sock
```

If SSH never comes up, inspect the serial log first. The usual causes are cloud-init not seeing the NoCloud ISO, the NIC name not matching `ens3`, or first-boot package/network work exceeding the SSH timeout.

If REPL execution fails before QEMU starts, that is usually a tool invocation/context issue rather than a VM boot issue. Validate the wrapper path directly with:

```text
/sandbox guest-test eval-py
```
