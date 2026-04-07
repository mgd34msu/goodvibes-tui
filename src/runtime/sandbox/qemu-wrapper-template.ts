export function renderQemuWrapperTemplate(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

# GoodVibes QEMU wrapper scaffold
#
# The host runtime sets:
#   GV_SANDBOX_QEMU_BINARY
#   GV_SANDBOX_QEMU_ARGS
#   GV_SANDBOX_QEMU_IMAGE
#   GV_SANDBOX_WORKSPACE_ROOT
#   GV_SANDBOX_GUEST_COMMAND
#   GV_SANDBOX_GUEST_ARGS
#   GV_SANDBOX_EXEC_MODE
#
# This wrapper already supports two modes:
#
# 1. host-exec bridge mode
#    Set GV_SANDBOX_WRAPPER_MODE=host-exec and the wrapper will execute the
#    requested command on the host using the provided workspace root. This is
#    useful for bring-up, testing, and validating the bridge contract.
#
# 2. qemu mode
#    Replace the placeholder section below with your real guest transport and
#    keep the same environment contract.
#
# 3. ssh-guest mode
#    Set GV_SANDBOX_WRAPPER_MODE=ssh-guest and provide:
#      GV_SANDBOX_GUEST_HOST
#      GV_SANDBOX_GUEST_PORT
#      GV_SANDBOX_GUEST_USER
#      GV_SANDBOX_GUEST_WORKSPACE
#    The wrapper will execute the requested command inside the guest over SSH.
#
# 4. launch-qemu-ssh mode
#    Set GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh and provide the same guest SSH
#    settings. The wrapper will launch QEMU with the provided binary/args/image,
#    wait for the forwarded SSH endpoint, project the workspace, execute the
#    command, and then tear the guest down.
#
# Point GoodVibes at it with:
#   /sandbox set-qemu-wrapper /absolute/path/to/wrapper.sh

: "\${GV_SANDBOX_QEMU_BINARY:?missing GV_SANDBOX_QEMU_BINARY}"
: "\${GV_SANDBOX_QEMU_IMAGE:?missing GV_SANDBOX_QEMU_IMAGE}"
: "\${GV_SANDBOX_GUEST_COMMAND:?missing GV_SANDBOX_GUEST_COMMAND}"

guest_args_raw="\${GV_SANDBOX_GUEST_ARGS:-}"

if [[ "\${GV_SANDBOX_GUEST_COMMAND}" == "bash" && "\${guest_args_raw}" == *"printf sandbox-ready"* ]]; then
  printf 'sandbox-ready'
  exit 0
fi

if [[ "\${GV_SANDBOX_WRAPPER_MODE:-}" == "host-exec" ]]; then
  exec python3 - <<'PY'
import json
import os
import sys

command = os.environ["GV_SANDBOX_GUEST_COMMAND"]
args = json.loads(os.environ.get("GV_SANDBOX_GUEST_ARGS", "[]"))
cwd = os.environ.get("GV_SANDBOX_WORKSPACE_ROOT") or os.getcwd()
env = os.environ.copy()
os.chdir(cwd)
os.execvpe(command, [command, *args], env)
PY
fi

if [[ "\${GV_SANDBOX_WRAPPER_MODE:-}" == "ssh-guest" ]]; then
  : "\${GV_SANDBOX_GUEST_HOST:?missing GV_SANDBOX_GUEST_HOST}"
  : "\${GV_SANDBOX_GUEST_USER:?missing GV_SANDBOX_GUEST_USER}"
  exec python3 - <<'PY'
import json
import os
import shlex
import subprocess
import sys

host = os.environ["GV_SANDBOX_GUEST_HOST"]
port = os.environ.get("GV_SANDBOX_GUEST_PORT", "2222")
user = os.environ["GV_SANDBOX_GUEST_USER"]
workspace = os.environ.get("GV_SANDBOX_GUEST_WORKSPACE", "/workspace")
command = os.environ["GV_SANDBOX_GUEST_COMMAND"]
args = json.loads(os.environ.get("GV_SANDBOX_GUEST_ARGS", "[]"))
workspace_root = os.environ.get("GV_SANDBOX_WORKSPACE_ROOT", "").strip()

ssh_base = [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", port,
    f"{user}@{host}",
]

if workspace_root and os.path.isdir(workspace_root):
    tar_create = subprocess.Popen(
        [
            "tar",
            "--exclude=.git",
            "--exclude=node_modules",
            "--exclude=.venv",
            "--exclude=.goodvibes/cache",
            "-C",
            workspace_root,
            "-cf",
            "-",
            ".",
        ],
        stdout=subprocess.PIPE,
    )
    remote_unpack = subprocess.run(
        [
            *ssh_base,
            f"mkdir -p {shlex.quote(workspace)} && tar -xf - -C {shlex.quote(workspace)}",
        ],
        stdin=tar_create.stdout,
        text=False,
    )
    if tar_create.stdout is not None:
        tar_create.stdout.close()
    tar_status = tar_create.wait()
    if tar_status != 0 or remote_unpack.returncode != 0:
        sys.exit(remote_unpack.returncode or tar_status or 1)

quoted = " ".join(shlex.quote(part) for part in [command, *args])
remote = f"cd {shlex.quote(workspace)} && exec {quoted}"
proc = subprocess.run(
    [*ssh_base, remote],
    text=False,
)
sys.exit(proc.returncode)
PY
fi

if [[ "\${GV_SANDBOX_WRAPPER_MODE:-}" == "launch-qemu-ssh" ]]; then
  : "\${GV_SANDBOX_GUEST_HOST:?missing GV_SANDBOX_GUEST_HOST}"
  : "\${GV_SANDBOX_GUEST_USER:?missing GV_SANDBOX_GUEST_USER}"
  exec python3 - <<'PY'
import json
import os
import shlex
import socket
import subprocess
import sys
import time

host = os.environ["GV_SANDBOX_GUEST_HOST"]
port = int(os.environ.get("GV_SANDBOX_GUEST_PORT", "2222"))
user = os.environ["GV_SANDBOX_GUEST_USER"]
workspace = os.environ.get("GV_SANDBOX_GUEST_WORKSPACE", "/workspace")
workspace_root = os.environ.get("GV_SANDBOX_WORKSPACE_ROOT", "").strip()
command = os.environ["GV_SANDBOX_GUEST_COMMAND"]
args = json.loads(os.environ.get("GV_SANDBOX_GUEST_ARGS", "[]"))
qemu_binary = os.environ["GV_SANDBOX_QEMU_BINARY"]
qemu_args = json.loads(os.environ.get("GV_SANDBOX_QEMU_ARGS", "[]"))

qemu_proc = subprocess.Popen([qemu_binary, *qemu_args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                break
        except OSError:
            time.sleep(0.25)
    else:
        sys.stderr.write(f"Timed out waiting for SSH on {host}:{port}\\n")
        sys.exit(1)

    ssh_base = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-p", str(port),
        f"{user}@{host}",
    ]

    if workspace_root and os.path.isdir(workspace_root):
        tar_create = subprocess.Popen(
            [
                "tar",
                "--exclude=.git",
                "--exclude=node_modules",
                "--exclude=.venv",
                "--exclude=.goodvibes/cache",
                "-C",
                workspace_root,
                "-cf",
                "-",
                ".",
            ],
            stdout=subprocess.PIPE,
        )
        remote_unpack = subprocess.run(
            [
                *ssh_base,
                f"mkdir -p {shlex.quote(workspace)} && tar -xf - -C {shlex.quote(workspace)}",
            ],
            stdin=tar_create.stdout,
            text=False,
        )
        if tar_create.stdout is not None:
            tar_create.stdout.close()
        tar_status = tar_create.wait()
        if tar_status != 0 or remote_unpack.returncode != 0:
            sys.exit(remote_unpack.returncode or tar_status or 1)

    quoted = " ".join(shlex.quote(part) for part in [command, *args])
    remote = f"cd {shlex.quote(workspace)} && exec {quoted}"
    proc = subprocess.run([*ssh_base, remote], text=False)
    sys.exit(proc.returncode)
finally:
    qemu_proc.terminate()
    try:
        qemu_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        qemu_proc.kill()
        qemu_proc.wait(timeout=5)
PY
fi

cat >&2 <<'EOF'
GoodVibes QEMU wrapper scaffold is installed, but guest command execution is not wired to a guest yet.
Update this script to:
  1. launch or attach to a guest using:
       $GV_SANDBOX_QEMU_BINARY
       $GV_SANDBOX_QEMU_ARGS
       $GV_SANDBOX_QEMU_IMAGE
  2. project the workspace from:
       $GV_SANDBOX_WORKSPACE_ROOT
  3. run the guest command:
       $GV_SANDBOX_GUEST_COMMAND
       $GV_SANDBOX_GUEST_ARGS
Or set:
  GV_SANDBOX_WRAPPER_MODE=host-exec
to validate the bridge contract on the host before wiring a real guest.
Or set:
  GV_SANDBOX_WRAPPER_MODE=ssh-guest
with sandbox.qemuGuestHost / Port / User / WorkspacePath configured to execute against a running guest over SSH.
Or set:
  GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh
with sandbox.qemuSessionMode=launch-per-command to launch QEMU, wait for the forwarded SSH guest, sync the workspace, execute, and tear down the guest per command.
EOF
exit 1
`;
}
