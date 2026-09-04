# Alerts

The hosted process writes one JSON object per line to stderr; Fly ships it to `fly logs` and to any configured log drain. Backups run in GitHub Actions. Nothing pages anyone by default. Wire these three.

## Log events worth an alert

| `event` | Meaning | Action |
| --- | --- | --- |
| `kek_raw_fallback` | A plane booted with raw `VAULT_KEK` instead of the KMS-wrapped KEK. The KMS cutover regressed or a secret was unset. | Page. Check `fly secrets list -a <app>` for `VAULT_KEK_WRAPPED`, `VAULT_KMS_KEY_ID`, `AWS_ROLE_ARN`; see [kek-rotation.md](kek-rotation.md). |
| `hosted_boot_failed`, `uncaught_exception`, `unhandled_rejection` | The process exited 1 and Fly is restarting it. | Page if repeated. |
| `shutdown_forced` | A deploy or restart could not drain within the 25 s deadline plus margin. | Investigate held connections. |
| `sweep_failed` | Hourly expiry sweep threw. Tables grow until it succeeds. | Ticket. |
| `aad_rebind_unreadable` | At boot an item envelope opened under neither the item-bound AAD nor the legacy `orgId` AAD. The row is left in place at `aad_version` 0 and the org cannot inject it. | Ticket. The item needs to be re-entered by its operator; `aad_rebind` carries the counts. |
| `kek_previous_loaded` | The process booted with `VAULT_KEK_PREVIOUS` set: a KEK rotation is in progress. | Expected during a rotation; see [kek-rotation.md](kek-rotation.md). Ticket if it persists after the rotation was closed out. |
| `sentry_send_failed` | Sentry envelope POST failed or timed out. | Ticket if sustained. |
| `auth_otp_locked`, `auth_totp_locked`, repeated `auth_otp_failed` / `auth_totp_failed` for one `email_hash` | Brute force against an operator account. | Review; rate limits already apply. |
| `schema_bootstrap` | `PostgresStore.migrate()` created the schema from `schema.ts` because `schema_migrations` did not exist. Expected only for dev and test databases. | On a plane this means the release_command did not run: check `fly releases` and `DATABASE_URL_DIRECT`. |

Requests are logged as `event: "request"` with `method`, `path`, `status`, `ms`, `request_id`. A 5xx rate or p95 `ms` alert can be built from these.

### Fly

Fly has no built-in log alerting. Ship logs to a drain (Grafana Cloud Loki, Datadog, Axiom, Better Stack; `fly logs` shows the same lines) with the `fly-log-shipper` app or the platform's native drain, then create a query alert per row above, for example Loki:

```
count_over_time({app="botpasses-prod"} |= `"event":"kek_raw_fallback"` [5m]) > 0
```

Sentry receives every `captureException` as an envelope with `release=botpasses@<package.json version>` and `environment=<plane>`; turn on Sentry issue alerts for new issues in `production`.

## Backup failure

`backup-prod.yml` fails closed: missing R2 secrets, a failed `pg_dump`, a failed upload, or a `backup-verify` job that cannot download and decrypt the object all fail the run. Failures notify only if someone is listening:

1. GitHub, Settings (personal), Notifications, Actions: enable "Send notifications for failed workflows only" for email and, if used, the mobile app. This covers scheduled runs of the repository owner.
2. For a team channel, add a final step to the `backup-verify` job with `if: failure()` that POSTs to a Slack or PagerDuty webhook stored as an Actions secret.
3. A run that never starts is silent. The `default-branch` job in `ci.yml` fails every push to `dev` while the default branch is not `dev` ([default-branch.md](default-branch.md)), which is the only way a missing nightly run becomes visible.

Check the last successful object monthly: `botpasses-<stamp>.dump.enc` in the R2 bucket with a stamp from the previous night.
