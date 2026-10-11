# NOTES

Decisions and open questions for pgbranch.

## Environment check (Phase 1, first step)

- PostgreSQL 16 server and client tools (`psql`, `pg_dump`, `pg_restore`) are already installed in the
  dev container (`/usr/lib/postgresql/16`). `pg_ctlcluster 16 main start` works, so integration tests
  run against a real local Postgres. No other approach was needed.
- CI covers Postgres 14, 15, 16, 17 with `services: postgres`.

## Where the code lives

- Work started by mistake in a `pgbranch/` folder on a fork of `aws-cdk`. It was moved to this
  repository with `git subtree split`, so the history here only has pgbranch commits.

## Decisions

- **Repo root for hooks** = the directory of the loaded config file. If no config file is found, the
  current directory.
- **Admin URL** is read only from `PGBRANCH_ADMIN_URL` or `--admin-url`, never from `pgbranch.json`,
  so the password does not end up in git.
- **Env var names** for every config field: `PGBRANCH_PREFIX`, `PGBRANCH_MAINTENANCE_DATABASE`,
  `PGBRANCH_STRATEGY`, `PGBRANCH_HOOKS_MIGRATE`, `PGBRANCH_HOOKS_SEED`,
  `PGBRANCH_GC_TTL`, `PGBRANCH_APP_URL`, `PGBRANCH_CONFIG`. Order: file < env < CLI flag.
- **Sanitizing** also trims `_` at both ends. If nothing is left (e.g. only non-ASCII chars), the
  8-hex sha1 of the branch name is used.
- **Name collisions** after sanitizing (`feature/foo` vs `feature-foo`): the metadata stores the
  original branch name, and `create` / `reset` / `delete` / `url` fail if the DB belongs to a
  different branch.
- **Prefix** must match `^[a-z][a-z0-9_]*$` and be at most 43 chars, so that
  `<prefix>_template_next` and `<prefix>_br_` + 16 chars fit in 63 bytes.
- **Safety rule** (`assertManaged` in `src/names.ts`) is called by every changing method of
  `DbOps` (`src/db-ops.ts`), which is the only place that builds changing SQL. It also refuses
  `postgres`, `template0`, `template1`, `rdsadmin`.
- **`create --if-not-exists`** on an existing DB still runs the `migrate` hook (unless
  `--no-migrate`), so a CI job on every push applies the branch's new migrations. It never drops an
  existing DB if the hook fails.
- **`reset`** fails if the DB does not exist. It reads the source from metadata (`template` or
  `branch:<name>`) and checks the source exists before dropping.
- **Drop** uses `pg_terminate_backend` first and then `DROP DATABASE ... WITH (FORCE)` (PG13+), which
  also covers a session that connects between the two steps.
- **Template swap**: the new template is set to `IS_TEMPLATE true ALLOW_CONNECTIONS false` *before*
  the renames (spec says after), so nobody can connect to it between the renames.
- **Crash recovery in `template refresh`**: leftover `_template_next` / `_template_old` are dropped at
  start. If `_template_old` exists but `_template` does not (crash in the middle of the swap), the old
  one is renamed back first.
- **Locks**: three kinds of advisory locks, keys built with `hashtext()`.
  - `pgbranch:<prefix>`: the main lock, held only around create / rename / drop.
  - `pgbranch:<prefix>:branch:<db>`: held for a whole `create` / `reset` / `delete` on one branch,
    hooks included. Two jobs on the same branch run one after the other.
  - `pgbranch:<prefix>:template`: held for a whole `template refresh`, so two refreshes do not
    break each other's `_template_next`. `create` is not blocked by it.
  - Order is always scoped lock first, then the main lock, so no deadlock.
  - We poll `pg_try_advisory_lock` every 500 ms (timeout 30 min) instead of a blocking call, so we
    can time out with a clear message.
- **Dump strategy**: target is created from `template0`. The source is dumped to a temp file with
  `pg_dump -Fc` and restored with `pg_restore --exit-on-error`. Because the template has
  `ALLOW_CONNECTIONS false`, the dump step turns connections on for the template while dumping (under
  the main lock) and turns them off again. The password is passed in `PGPASSWORD`, not in argv.
- **Hook output** goes to stderr so stdout stays clean for `--json`.
- **Hook env in template refresh**: `PGBRANCH_BRANCH` is empty.
- **`--dry-run`** still runs read-only queries (to know what would happen), skips locks and hooks,
  and prints the changing SQL with a `[dry-run]` prefix.
- **Dependency versions**: `commander@12` (v13+ needs Node 22), so the package runs on Node 20+.
  Dev tools need Node 22.12+ (`vitest@5`). We moved from `vitest@3` because its `tinypool` had
  critical advisories. One low advisory is left in `esbuild` (dev server on Windows only, which we
  do not use); `tsup` pins `esbuild@^0.27` and the fix is in 0.28.

- **GitHub Action runtime is `node24`**, not `node20` as the spec says. GitHub has deprecated the
  `node20` action runtime and moves actions to Node 24, so a `node20` action would get warnings or
  be forced to Node 24 anyway. The bundle targets Node 20 syntax, so it runs on both.
- **Action bundle** (`action-dist/index.cjs`) is committed, because an action runs without
  `npm install`. CI fails if it is out of date. It is CJS because `pg` is CJS.
- **Action `branch` input** defaults to `GITHUB_HEAD_REF` (PR head branch), then `GITHUB_REF_NAME`.
  The action always uses `--format github`.
- **CI runs on Node 22.** Node 20 reached end of life in April 2026; the package still declares
  `node >= 20`.

- **RDS Data API support was removed** (it was Phase 2 of the spec). The Data API would let a
  GitHub-hosted runner call create / delete without getting into the VPC. But the migrate hook and
  the app's tests still need a normal connection to the branch DB, so the job needs VPC access
  anyway. It also made the tool Aurora-only for that path, added the AWS SDK (most of the action
  bundle), and had open questions (`CREATE DATABASE` through `ExecuteStatement`, keeping a lock
  across calls). The `Driver` interface stays, because unit tests use a fake driver with it.

## Open questions

- Concurrent `create --if-not-exists` on the same branch: handled by the branch lock.
