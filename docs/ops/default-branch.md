# Set the GitHub default branch to `dev`

Today the repository's default branch is `main`, which holds only a README. GitHub runs `schedule` workflows, reads `dependabot.yml`, and lists `workflow_dispatch` workflows from the default branch. While it is `main`:

- `backup-prod.yml` never runs its nightly cron. There is no offsite dump.
- Dependabot opens no PRs.
- `deploy-prod` does not appear in the Actions "Run workflow" menu.
- `deploy-staging.yml` is a `workflow_run` workflow (it deploys the SHA that `ci` just passed on `dev`). GitHub evaluates `workflow_run` triggers from the default branch only, so **staging does not deploy at all until the default branch is `dev`**. Do this switch the same day the `workflow_run` change lands.

`ci.yml` has a `default-branch` job that fails every push to `dev` or `main` until this is fixed, so the state cannot go unnoticed again.

## Secrets live in environments, not the repository

Every deploy and backup secret is an **environment secret**. A repository-level Actions secret is readable by any workflow on any branch, including one added in a pull request; an environment secret is readable only by a job that names that environment and passes its rules.

| Environment | Secrets | Rules | Used by |
| --- | --- | --- | --- |
| `staging` | `FLY_API_TOKEN` (Fly deploy token scoped to `botpasses-staging`) | Deployment branches: `dev` only | `deploy-staging.yml` |
| `production` | `FLY_API_TOKEN` (Fly deploy token scoped to `botpasses-prod`) | Required reviewers: at least one; deployment branches: `dev` only | `deploy-prod.yml` |
| `backup` | `DATABASE_URL_DIRECT`, `BACKUP_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Deployment branches: `dev` only | `backup-prod.yml` (both jobs) |

Mint each Fly token with `fly tokens create deploy -a <app>` so it can deploy that one app and nothing else; the workflows also pass `-a <app>` to `flyctl deploy` so a wrong toml cannot retarget a token. If any of these names still exist as repository secrets, delete them there after the environments are populated.

## Steps

1. Settings, Environments: create `staging`, `production`, and `backup`. On each, set "Deployment branches and tags" to selected branches: `dev`. On `production`, add at least one required reviewer. `deploy-prod.yml` waits on that review.
2. Add the secrets from the table above to their environments. `backup` needs all six; without them the nightly job fails closed every night.
3. Settings, Branches, Default branch: click the switch icon, choose `dev`, confirm. (`gh api -X PATCH repos/naffis/botpasses -f default_branch=dev` does the same.)
4. Actions, `backup-prod`, Run workflow. Both jobs must pass: `dump` uploads `botpasses-<stamp>.dump.enc`, `backup-verify` downloads it and decrypts it with `BACKUP_KEY`.
5. Restore drill: follow [restore.md](restore.md) into a scratch Neon branch or a local Postgres 16 once, and record the date in the table below.
6. Push any commit to `dev`; the `default-branch` job in `ci` is now green.

Verify from a shell: `git ls-remote --symref origin HEAD` prints `ref: refs/heads/dev`.

`deploy-prod` also refuses a `staging_sha` that has no successful `deploy-staging` run (it reads the run list through the GitHub API), so a commit cannot reach production without first having reached staging.

## Drill log

| Date | Object | Restored into | By |
| --- | --- | --- | --- |
| | | | |
