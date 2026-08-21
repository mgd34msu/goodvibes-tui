# Cloudflare batch and control plane

GoodVibes can optionally use Cloudflare Workers and Queues for batch-capable daemon work. This is opt-in. By default the TUI keeps immediate local daemon behavior:

| Key | Default | Meaning |
| --- | --- | --- |
| `batch.mode` | `off` | No work uses the batch path (the three modes are explained under Batch modes below) |
| `batch.queueBackend` | `local` | Queued work stays on the local backend |
| `cloudflare.enabled` | `false` | The Cloudflare integration is off entirely |

The TUI owns the user flow. The SDK daemon owns all Cloudflare API calls, token creation, validation, discovery, provisioning, verification, repair paths, and secret persistence. The TUI never calls Cloudflare APIs directly.

## Onboarding

Select `Use Cloudflare for batch or remote daemon work` on the first onboarding screen. The Cloudflare screen configures:

| Field | Choices / notes |
| --- | --- |
| Cloudflare enabled/disabled | The master switch |
| Batch mode | `off`, `explicit`, or `eligible-by-default` (explained under Batch modes below) |
| Components | Workers and Queues are the normal defaults; Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2 are advanced optional components |
| Resource names/refs | Account, zone/domain, worker, queue, tunnel, Access, KV, DO, R2, and Secrets Store identifiers |
| Token setup path | One of the five paths in the next section |
| Provision on apply | Whether the final onboarding apply provisions resources immediately |

## Token setup

The wizard supports these paths:

- Save settings only: persist configuration and provision later.
- Paste temporary bootstrap token: the SDK creates a narrower operational token, stores it in GoodVibes secrets, and does not persist the bootstrap token.
- Read bootstrap token from environment: same as pasted bootstrap token, but the TUI reads the value from an environment variable in the current process.
- Paste final operational token: the TUI stores it as `goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN`.
- Use final token from environment: the TUI writes a `goodvibes://secrets/env/<ENV_NAME>` reference, usually `CLOUDFLARE_API_TOKEN`.

Bootstrap tokens should be temporary and should be revoked or allowed to expire after GoodVibes creates and validates the operational token.

## Slash command

Use `/cloudflare` for runtime inspection and daemon actions:

```text
/cloudflare status
/cloudflare setup
/cloudflare requirements [--all|--component queues]
/cloudflare create-token --account <account-id> --bootstrap-env <ENV_NAME>
/cloudflare discover --token-env CLOUDFLARE_API_TOKEN
/cloudflare validate --token-env CLOUDFLARE_API_TOKEN
/cloudflare provision --account <account-id> --batch-mode explicit --tunnel-token-ref goodvibes://secrets/goodvibes/CLOUDFLARE_TUNNEL_TOKEN
/cloudflare verify
/cloudflare disable
```

`/cloudflare setup` opens onboarding in edit mode. All other subcommands call SDK-owned daemon routes under local daemon admin/auth.

`/cloudflare provision` accepts the same major SDK daemon fields the onboarding screen exposes, including `--tunnel-name`, `--tunnel-id`, `--tunnel-service-url`, `--tunnel-token-ref`, `--access-app-id`, `--access-service-token-id`, `--access-service-token-ref`, `--kv-namespace-name`, `--kv-namespace-id`, `--do-namespace-name`, `--do-namespace-id`, `--r2-bucket-name`, `--secrets-store-name`, `--secrets-store-id`, `--operator-token-ref`, and `--worker-client-token-ref`.

## Daemon routes

The TUI integrates with these daemon routes, each backing the matching `/cloudflare` subcommand:

| Route | Does |
| --- | --- |
| `GET /api/cloudflare` | The integration descriptor |
| `GET /api/cloudflare/status` | Enabled/ready posture and configured resources |
| `POST /api/cloudflare/token/requirements` | List required API-token permissions |
| `POST /api/cloudflare/token/create` | Create the scoped operational token from a bootstrap token |
| `POST /api/cloudflare/discover` | Discover existing account resources |
| `POST /api/cloudflare/validate` | Validate the token and configuration |
| `POST /api/cloudflare/provision` | Provision the configured resources |
| `POST /api/cloudflare/verify` | Verify the provisioned resources |
| `POST /api/cloudflare/disable` | Turn the integration off |

Errors return JSON with `error` and `code`. The TUI displays route failures as actionable wizard or command output and does not block normal local daemon usage unless the user explicitly depends on Cloudflare provisioning.

## Batch modes

`off` keeps all work on the immediate local path.

`explicit` uses Cloudflare only for requests explicitly marked for batch execution.

`eligible-by-default` lets eligible daemon work use the configured batch path unless the caller opts out.

For most users, keep `off` or `explicit`. `eligible-by-default` is intended for always-on/background deployments such as a Mac mini or remote node.

## Secrets

Raw Cloudflare tokens are transient form or command input only. Persistent references use GoodVibes secret URIs:

```text
goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN
goodvibes://secrets/env/CLOUDFLARE_API_TOKEN
goodvibes://secrets/goodvibes/CLOUDFLARE_TUNNEL_TOKEN
goodvibes://secrets/goodvibes/CLOUDFLARE_ACCESS_SERVICE_TOKEN
```

The SDK may also store generated Worker client, Tunnel, Access service, and daemon/operator token material as GoodVibes secret references when provisioning needs them.
