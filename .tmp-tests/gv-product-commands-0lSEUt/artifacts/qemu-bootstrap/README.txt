GoodVibes QEMU Sandbox Setup Bundle

This bundle is the productized first-run QEMU setup path.

Files:
  qemu-wrapper.sh            host-side wrapper used by GoodVibes
  create-image.sh            creates /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-0lSEUt/artifacts/qemu-bootstrap/images/goodvibes-sandbox.qcow2 with qemu-img
  guest/bootstrap-guest.sh   bootstrap script to run inside the guest
  policy/workspace-projection.json   default workspace projection policy
  ssh_config                 SSH host stanza for the guest
  guest-bundle.json          current runtime transport settings
  setup-manifest.json        paths and recommended GoodVibes settings

Suggested flow:
  1. Create an image: /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-0lSEUt/artifacts/qemu-bootstrap/create-image.sh /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-0lSEUt/artifacts/qemu-bootstrap/images/goodvibes-sandbox.qcow2 20
  2. Boot a Linux guest using /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-0lSEUt/artifacts/qemu-bootstrap/images/goodvibes-sandbox.qcow2
  3. Run /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-0lSEUt/artifacts/qemu-bootstrap/guest/bootstrap-guest.sh inside the guest
  4. Configure port-forwarding so guest SSH reaches 127.0.0.1:2222
  5. Point GoodVibes at the generated paths
     /sandbox set-backend qemu
     /sandbox set-qemu-wrapper /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-0lSEUt/artifacts/qemu-bootstrap/qemu-wrapper.sh
     /sandbox set-qemu-image /home/buzzkill/Projects/goodvibes-tui/.tmp-tests/gv-product-commands-0lSEUt/artifacts/qemu-bootstrap/images/goodvibes-sandbox.qcow2
     /sandbox set-qemu-guest-host 127.0.0.1
     /sandbox set-qemu-guest-port 2222
     /sandbox set-qemu-guest-user goodvibes
     /sandbox set-qemu-workspace /workspace
  6. Validate with /sandbox doctor and /sandbox guest-test eval-js
