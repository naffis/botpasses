# Set the GitHub default branch to `dev`

Today the repository's default branch is `main`, which holds only a README. GitHub runs `schedule` workflows, reads `dependabot.yml`, and lists `workflow_dispatch` workflows from the default branch. While it is `main`:

- `backup-prod.yml` never runs its nightly cron. There is no offsite dump.
- Dependabot opens no PRs.
- `deploy-prod` does not appear in the Actions "Run workflow" menu.
- `deploy-staging.yml` is a `workflow_run` workflow (it deploys the SHA that `ci` just passed on `dev`). GitHub evaluates `workflow_run` triggers from the default branch only, so **staging does not deploy at all until the default branch is `dev`**. Do this switch the same day the `workflow_run` change lands.

`ci.yml` has a `default-branch` job that fails every push to `dev` or `main` until this is fixed, so the state cannot go unnoticed again.

## Steps

1. Confirm the Actions secrets for `backup-prod.yml` exist under Settings, Secrets and variables, Actions: `DATABASE_URL_DIRECT`, `BACKUP_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Without them the nightly job fails closed every night.
2. Settings, Branches, Default branch: click the switch icon, choose `dev`, confirm. (`gh api -X PATCH repos/naffis/botpasses -f default_branch=dev` does the same.)
3. Settings, Environments: create `production` with at least one required reviewer. `deploy-prod.yml` waits on it.
4. Actions, `backup-prod`, Run workflow. Both jobs must pass: `dump` uploads `botpasses-<stamp>.dump.enc`, `backup-verify` downloads it and decrypts it with `BACKUP_KEY`.
5. Restore drill: follow [restore.md](restore.md) into a scratch Neon branch or a local Postgres 16 once, and record the date in the table below.
6. Push any commit to `dev`; the `default-branch` job in `ci` is now green.

Verify from a shell: `git ls-remote --symref origin HEAD` prints `ref: refs/heads/dev`.

## Drill log

| Date | Object | Restored into | By |
| --- | --- | --- | --- |
| | | | |
