# CLI flags

Most flags below are global (available regardless of the subcommand in use). Session-lifecycle flags are evaluated at TUI startup and are silently ignored for non-TUI commands. A few flags are specific to one command; those are listed separately in [Command-specific flags](#command-specific-flags).

## Session lifecycle

### `--continue`

Resume the most recently active session for the current working directory. Reads the last-session pointer file written by `persistConversation`; does nothing when no pointer file exists.

```sh
goodvibes --continue
```

### `--resume [id]`, `-r [id]`

Resume a specific session by id. When the id is omitted, resolves via the same last-session pointer as `--continue`.

```sh
goodvibes --resume                  # resolve latest pointer
goodvibes --resume user-sess-1234   # explicit id
goodvibes -r user-sess-1234
goodvibes --resume=user-sess-1234   # inline-value form
```

### `--fork [id]`

Fork a session into a new branch.

- **Bare `--fork`** (no id) forks the session that is already active when the TUI starts.
- **`--fork <id>`** resumes the named session first, then forks it.

Sessions whose id happens to be the string `current` can be forked by passing the id explicitly (`--fork current`), which is distinct from the bare `--fork` form.

```sh
goodvibes --fork                       # fork active session
goodvibes --fork user-source-session   # resume then fork
goodvibes --fork=user-source-session   # inline-value form
goodvibes --fork current               # fork the session literally named "current"
```

## Session targeting

### `--session <id>`, `-s <id>`

Attach to a named session. Used by commands that operate on a specific session.

```sh
goodvibes --session user-sess-1234
goodvibes -s user-sess-1234
```

## Commit gate

### `--yes`, `-y`

Most CLI commands act immediately and never ask for confirmation, so this flag has no effect on them. Its one concrete effect today is on `plugin bundles install`, where without it the command only verifies the bundle manifest and prints the activation plan, and with it the plan is committed and the bundle is recorded as installed.

```sh
goodvibes plugin bundles install <ref> --sha256 <pin>          # preview only
goodvibes plugin bundles install <ref> --sha256 <pin> --yes    # commits the install
```

### `--non-interactive`

Sets `--yes` and additionally suppresses any interactive prompt a command might otherwise open. Useful for scripted or CI contexts where no TTY is available.

```sh
goodvibes --non-interactive run 'do something'
```

## Output format

### `--output <format>`, `-o <format>` (canonical)

Set the output encoding for `run` and other machine-readable commands. Three formats are valid, each with its own shape:

| Format | What it prints |
| --- | --- |
| `text` (default) | The final assistant response (or the error) as plain text |
| `json` | One pretty-printed JSON object at the end: `ok`, `response`, `error`, `stopReason`, `sessionId`, `model`, `provider`, and the event count |
| `stream-json` | Newline-delimited JSON: one object per streaming delta as it arrives, then a final completed-or-error object |

```sh
goodvibes run 'list files' --output json
goodvibes -o stream-json run 'stream output'
```

### `--output-format <format>` (deprecated alias)

Deprecated alias for `--output/-o`. Prints a deprecation warning to stderr and maps to the same `outputFormat` field. Use `--output` or `-o` instead. When both appear on the same command line, the last one wins.

### `--json` (alias)

Shorthand for `--output json`.

```sh
goodvibes run 'list files' --json
```

### `--print`

Run in non-interactive print mode. Implies `run` command when no subcommand is given. Prints assistant output to stdout and exits.

## Provider and model

### `--provider <name>`

Override the active provider.

```sh
goodvibes --provider openai
```

### `--model <id>`, `-m <id>`

Override the active model. When the model id includes a provider prefix (`provider:model` or `provider/model`), the provider is inferred automatically unless `--provider` is also set.

```sh
goodvibes --model openai:gpt-5.2
goodvibes -m anthropic:claude-sonnet-4-6
```

## Network and serving

### `--port <number>`

Override the port for `web`, `surfaces enable`, or other network-bound commands. Must be 1–65535.

### `--hostname <address>`, `--host <address>`

Override the bind address. `--host` is an alias; both map to the same `hostname` field.

```sh
goodvibes web --hostname 0.0.0.0 --port 3423
goodvibes surfaces enable web --host 0.0.0.0
```

### `--open`

Open the browser automatically after the web UI starts.

## Display

### `--no-alt-screen`

Disable the alternate screen buffer. Useful for terminals that do not support it or when capturing TUI output in a log.

## Paths

### `--daemon-home <path>`

Override the daemon home directory (default `~/.goodvibes/daemon`).

### `--working-dir <path>`, `--cd <path>`, `-C <path>`

Override the working directory used for session storage and project-scoped config resolution.

## Runtime

### `--config <key=value>`, `-c <key=value>`

Apply a settings override at startup. May be repeated.

```sh
goodvibes --config log.level=debug --config feature.x=true
```

### `--enable <feature>`, `--disable <feature>`

Enable or disable a named feature flag at startup. May be repeated.

## Prompt injection

### `--prompt <text>`, `-p <text>`

Seed the input buffer with a prompt before the TUI opens. Implies `run` command when no subcommand is given.

```sh
goodvibes --prompt 'explain this file'
goodvibes -p 'summarize the diff'
```

## Meta

### `--help`, `-h`

Print usage information and exit.

### `--version`, `-v`

Print the version string and exit.

## Argument terminator

`--` stops flag parsing. All subsequent tokens are passed through as positional arguments or subcommand arguments.

```sh
goodvibes run -- --flag-for-subprocess
```

## Command-specific flags

These apply to one command only, not globally.

### `--strict` (`doctor` only)

Also fail on advisory findings, for CI. Without it, `doctor` exits non-zero only for a must-fix finding.

```sh
goodvibes doctor --strict
```

### `--password <value>`, `--password-stdin`, `--role <role>` (`auth add-user` / `auth rotate-password` only)

Set the new user's password inline, or read it from stdin (`--password-stdin`) instead of putting it on the command line. Falls back to the `GOODVIBES_AUTH_PASSWORD` environment variable when neither is given. `--role` assigns a role and may be repeated; `auth add-user` defaults to the `user` role when none is given. `auth rotate-password` takes `--password`/`--password-stdin` but not `--role`.

```sh
goodvibes auth add-user alice --password-stdin --role admin
goodvibes auth rotate-password alice --password-stdin
```
