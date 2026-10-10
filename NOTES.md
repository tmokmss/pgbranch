# NOTES

Decisions and open questions for pgbranch.

## Environment check (Phase 1, first step)

- PostgreSQL 16 server and client tools (`psql`, `pg_dump`, `pg_restore`) are already installed in the
  dev container (`/usr/lib/postgresql/16`). `pg_ctlcluster 16 main start` works, so integration tests
  run against a real local Postgres. No other approach was needed.
- CI covers Postgres 14, 15, 16, 17 with `services: postgres`.

## Where the code lives

- The working branch is on a fork of `aws-cdk`, but pgbranch is a separate project. The code lives in
  the self-contained `pgbranch/` folder so it can be moved to its own repository as is (I was not
  allowed to replace the branch content with an orphan history).
- Because of this, `.github/workflows/ci.yml` and `action.yml` are inside `pgbranch/`. GitHub only
  runs workflows from the repository root, so CI starts working once the folder is its own repo.

## Decisions

- **Repo root for hooks** = the directory of the loaded config file. If no config file is found, the
  current directory.
- **Admin URL** is read only from `PGBRANCH_ADMIN_URL` or `--admin-url`, never from `pgbranch.json`,
  so the password does not end up in git.
- **Env var names** for every config field: `PGBRANCH_PREFIX`, `PGBRANCH_MAINTENANCE_DATABASE`,
  `PGBRANCH_STRATEGY`, `PGBRANCH_DRIVER`, `PGBRANCH_HOOKS_MIGRATE`, `PGBRANCH_HOOKS_SEED`,
  `PGBRANCH_GC_TTL`, `PGBRANCH_APP_URL`, `PGBRANCH_RESOURCE_ARN`, `PGBRANCH_SECRET_ARN`,
  `PGBRANCH_REGION`, `PGBRANCH_CONFIG`. Order: file < env < CLI flag.
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
  - We poll `pg_try_advisory_lock` every 500 ms (timeout 30 min) instead of a blocking call. This
    works the same way with the Data API, where a blocking call could hit the statement timeout.
- **Dump strategy**: target is created from `template0`. The source is dumped to a temp file with
  `pg_dump -Fc` and restored with `pg_restore --exit-on-error`. Because the template has
  `ALLOW_CONNECTIONS false`, the dump step turns connections on for the template while dumping (under
  the main lock) and turns them off again. The password is passed in `PGPASSWORD`, not in argv.
- **Hook output** goes to stderr so stdout stays clean for `--json`.
- **Hook env in template refresh**: `PGBRANCH_BRANCH` is empty.
- **`--dry-run`** still runs read-only queries (to know what would happen), skips locks and hooks,
  and prints the changing SQL with a `[dry-run]` prefix.
- **Dependency versions**: `commander@12` (v13+ needs Node 22), `vitest@3` (v4+ needs Node 22), so
  the package runs and tests on Node 20+.

## Open questions

- **[Phase 2] Data API and `CREATE DATABASE`.** Not confirmed that `ExecuteStatement` without
  `transactionId` runs `CREATE DATABASE` / `DROP DATABASE` / `ALTER DATABASE` outside a transaction
  block. The driver is written as if it does. Run `scripts/data-api-smoke.mjs` against a real cluster
  to check (see README).
- **[Phase 2] Data API locking.** A session-level advisory lock does not work because each
  `ExecuteStatement` can use a different connection. The driver keeps a Data API transaction open and
  takes `pg_try_advisory_xact_lock` in it. Needs a check on a real cluster (the smoke script does it).
  The Data API ends idle transactions after some minutes, so long lock holds (the scoped locks held
  during hooks) may be lost. To be checked.
- Concurrent `create --if-not-exists` on the same branch: handled by the branch lock.
