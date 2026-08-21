# @pellux/goodvibes-tui-linux-arm64

Prebuilt `goodvibes` and `goodvibes-daemon` binaries for **linux-arm64**.

This is a payload package with no lifecycle scripts. It is installed
automatically as an optional dependency of
[`@pellux/goodvibes-tui`](https://www.npmjs.com/package/@pellux/goodvibes-tui)
when your platform matches its `os`/`cpu` fields. The package manager
verifies it against the registry integrity hash, so no trust step and no
post-install download are required. Do not depend on it directly.
