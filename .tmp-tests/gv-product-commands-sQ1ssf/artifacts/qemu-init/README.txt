GoodVibes QEMU Sandbox Init Bundle

Files:
  qemu-wrapper.sh     host-side wrapper used by /sandbox session run
  guest-bundle.json   current guest transport and workspace settings

Suggested setup:
  1. Ensure qemu-system-x86_64 is installed and on PATH.
  2. Prepare a guest image with SSH enabled.
  3. Forward guest port 22 to the configured host port.
  4. Point GoodVibes at /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-sQ1ssf/artifacts/qemu-init/qemu-wrapper.sh
     /sandbox set-qemu-wrapper /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-sQ1ssf/artifacts/qemu-init/qemu-wrapper.sh
  5. Point GoodVibes at your image
     /sandbox set-qemu-image <path-to-image>
  6. Verify transport
     /sandbox doctor
     /sandbox guest-test eval-js
