# GitHub default branch is `dev`

The repository default branch is `dev`. GitHub runs `schedule` workflows, reads `dependabot.yml`, and lists `workflow_dispatch` workflows from the default branch. `deploy-staging.yml` is a `workflow_run` workflow evaluated from the default branch, so staging deploys only while that branch is `dev`.

`ci.yml` has a `default-branch` job that fails every push to `dev` or `main` if this is changed away from `dev`. Verify with `git ls-remote --symref origin HEAD` (it must print `ref: refs/heads/dev`).

If the default is ever set back to `main` (which holds only a README):

- `backup-prod.yml` never runs its nightly cron. There is no offsite dump.
- Dependabot opens no PRs.
- `deploy-prod` does not appear in the Actions "Run workflow" menu.
- Staging does not deploy, because GitHub evaluates `workflow_run` from the default branch only.

## Secrets live in environments, not the repository

Every deploy and backup secret is an **environment secret**. A repository-level Actions secret is readable by any workflow on any branch, including one added in a pull request; an environment secret is readable only by a job that names that environment and passes its rules.

| Environment | Secrets | Rules | Used by |
| --- | --- | --- | --- |
| `staging` | `FLY_API_TOKEN` (Fly deploy token scoped to `botpasses-staging`) | Deployment branches: `dev` only | `deploy-staging.yml` |
| `production` | `FLY_API_TOKEN` (Fly deploy token scoped to `botpasses-prod`) | Deployment branches: `dev` only. Required reviewer: the repo owner (`naffis`). | `deploy-prod.yml` |
| `backup` | `DATABASE_URL_DIRECT`, `BACKUP_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Deployment branches: `dev` only | `backup-prod.yml` (both jobs) |

Mint each Fly token with `fly tokens create deploy -a <app>` so it can deploy that one app and nothing else; the workflows also pass `-a <app>` to `flyctl deploy` so a wrong toml cannot retarget a token. If any of these names still exist as repository secrets, delete them there after the environments are populated.

The first R2 S3 pair was derived from an existing Cloudflare user token that already had object write, because that token cannot mint a narrower one (`API Tokens Write` is missing). Replace `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` with a bucket-scoped R2 API token for `botpasses-backups` when you can create one in the Cloudflare dashboard. Do not rotate `BACKUP_KEY` unless you re-encrypt every object already in the bucket.

## Restore the default to `dev`

1. Settings, Environments: create `staging`, `production`, and `backup` if they are missing. On each, set "Deployment branches and tags" to selected branches: `dev`. On `production`, keep the required reviewer (`naffis`). `deploy-prod.yml` waits on that review.
2. Add the secrets from the table above to their environments. `backup` needs all six; without them the nightly job fails closed every night.
3. Settings, Branches, Default branch: click the switch icon, choose `dev`, confirm. (`gh api -X PATCH repos/naffis/botpasses -f default_branch=dev` does the same.)
4. Actions, `backup-prod`, Run workflow. Both jobs must pass: `dump` uploads `botpasses-<stamp>.dump.enc`, `backup-verify` downloads it and decrypts it with `BACKUP_KEY`.
5. Restore drill: follow [restore.md](restore.md) into a scratch Neon branch or a local Postgres 16 once, and record the date in the table below.
6. Push any commit to `dev`; the `default-branch` job in `ci` is now green.

`deploy-prod` also refuses a `staging_sha` that has no successful `deploy-staging` run (it reads the run list through the GitHub API), so a commit cannot reach production without first having reached staging.

## Drill log

| Date | Object | Restored into | By |
| --- | --- | --- | --- |
| 2026-09-05 | `botpasses-20260905T135436Z.dump.enc` (1633 bytes; `backup-verify` green on [run 33970231210](https://github.com/naffis/botpasses/actions/runs/33970231210)) | Neon `botpasses-prod` scratch branch `restore-drill-20260905`. Project slug is in gitignored `.env.ops` (`NEON_PROD_PROJECT`). Decrypt produced a `PGDMP` archive. `pg_restore --no-owner --clean --if-exists` applied it; two ignored errors were Neon `cloud_admin` default-privilege ALTERs, not user tables. The dump is the first offsite copy of the isolated prod project (empty schema). | agent |
