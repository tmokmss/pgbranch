# pgbranch

Give each git branch / pull request its own Postgres database, on a cluster you already have.

pgbranch keeps a **template database** at the schema (and seed data) of `main`. A branch database
is a fast server-side copy of it (`CREATE DATABASE ... TEMPLATE ...`). pgbranch creates, resets,
lists and deletes branch databases, and cleans up old ones.

The main target is **Aurora PostgreSQL**, but any PostgreSQL 14+ works.

pgbranch does **not** run migrations itself. It calls your own command (a hook) with the connection
info in env vars, so it works with any migration tool: Prisma, Drizzle, Flyway, Alembic, sqldef,
plain SQL, ...

## Why

Neon and some other services have cheap database branching. Aurora does not. Aurora clones and
snapshot restores create new clusters or instances, which are slow and cost money for each branch.
For most preview environments and CI jobs you only need a separate *database* on the same cluster.
pgbranch does that with plain SQL.

## Quick start

```sh
npm install --save-dev pgbranch
```

`pgbranch.json` in your repo root:

```json
{
  "prefix": "app",
  "hooks": {
    "migrate": "npx prisma migrate deploy",
    "seed": "npm run db:seed"
  },
  "gc": { "ttl": "7d" },
  "appUrl": "postgresql://app_user@my-cluster.cluster-xxxx.ap-northeast-1.rds.amazonaws.com:5432/{database}"
}
```

```sh
export PGBRANCH_ADMIN_URL='postgresql://pgbranch_admin:secret@my-cluster...:5432/postgres'

npx pgbranch template refresh          # build the template from main (migrate + seed)
npx pgbranch create feature/login      # copy the template, run migrate, print the URL
npx pgbranch list
npx pgbranch reset feature/login       # back to a fresh copy
npx pgbranch delete feature/login
npx pgbranch gc                        # drop branch databases older than gc.ttl
```

## How it works

- All databases managed by pgbranch start with `<prefix>_`.
  - Template: `<prefix>_template`
  - Branch: `<prefix>_br_<sanitized branch name>`
- The template is marked `IS_TEMPLATE true ALLOW_CONNECTIONS false`. Nobody can connect to it by
  accident, so `CREATE DATABASE ... TEMPLATE` never fails with "source database is being accessed
  by other users".
- `template refresh` builds `<prefix>_template_next` (a copy of the current template, or empty the
  first time), runs `migrate` (and `seed` the first time) on it, then swaps it in. If the hook fails,
  the new copy is dropped and the old template stays as it was.
- `create` copies the template, then runs `migrate` on the new database. This applies the new
  migrations of the branch on top of `main`. If the hook fails, the new database is dropped.
- Metadata (branch name, created time, source) is stored as JSON in `COMMENT ON DATABASE`. No extra
  tables.
- Postgres advisory locks keep parallel CI jobs safe. Two jobs on the same branch run one after the
  other. Jobs on different branches only wait for each other during the short create / rename /
  drop steps.

### Branch names

The branch name is lowercased, every char not in `[a-z0-9_]` becomes `_`, repeats are collapsed
and `_` at both ends is removed: `feature/Login-Page` becomes `app_br_feature_login_page`.

Postgres names are at most 63 bytes. A longer name is cut and gets `_` + 8 hex chars of the SHA-1 of
the full branch name, so two long names never get the same database.

Two branches can still map to the same name (`feature/a` and `feature-a`). pgbranch stores the
original branch name in the metadata and refuses to touch a database that belongs to another branch.

## Commands

All commands accept these global options (before or after the command):

| Option | Meaning |
| --- | --- |
| `-c, --config <path>` | Config file (default `pgbranch.json`) |
| `--admin-url <url>` | Admin connection URL (default env `PGBRANCH_ADMIN_URL`) |
| `--json` | Print JSON (same as `--format json`) |
| `--format text\|json\|github` | Output format. `github` writes step outputs, see below |
| `--dry-run` | Print the SQL and actions. Change nothing |
| `--prefix`, `--maintenance-database`, `--strategy`, `--driver`, `--app-url`, `--migrate-hook`, `--seed-hook`, `--resource-arn`, `--secret-arn`, `--region` | Override the config |

| Command | What it does |
| --- | --- |
| `template refresh` | Build or update the template database |
| `create <branch> [--from <branch>] [--no-migrate] [--if-not-exists]` | Create a branch database and print its URL. `--from` copies another branch database instead of the template (connections to it are terminated). With `--if-not-exists`, an existing database is kept and `migrate` still runs on it, so you can call it on every push |
| `reset <branch> [--no-migrate]` | Drop and create again from the same source (template or `--from` branch) |
| `delete <branch> [--if-exists]` | Drop a branch database |
| `list` | Branch databases with branch name, created time and size |
| `url <branch>` | Print the connection URL |
| `gc [--ttl 7d] [--keep <branch>...]` | Drop branch databases older than the TTL (units `s m h d w`) |

Exit code is `0` on success and `1` on any error. Logs and hook output go to stderr, so stdout only
has the result.

### GitHub output mode

`--format github` appends `database=...` and `url=...` to `$GITHUB_OUTPUT`, and prints
`::add-mask::<url>` first when the URL has a password, so it is hidden in the logs.

## Config reference

`pgbranch.json` (path can be changed with `--config` or `PGBRANCH_CONFIG`). Every field can be set
by an env var or a CLI flag. Order: file < env var < flag.

| Field | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `prefix` | `PGBRANCH_PREFIX` | (required) | Name prefix. `^[a-z][a-z0-9_]*$`, max 43 chars |
| `maintenanceDatabase` | `PGBRANCH_MAINTENANCE_DATABASE` | `postgres` | Database the admin connection uses |
| `strategy` | `PGBRANCH_STRATEGY` | `template` | `template` or `dump`, see below |
| `driver` | `PGBRANCH_DRIVER` | `pg` | `pg` (direct connection) or `data-api` |
| `hooks.migrate` | `PGBRANCH_HOOKS_MIGRATE` | none | Runs on every create, reset and template refresh |
| `hooks.seed` | `PGBRANCH_HOOKS_SEED` | none | Runs only when the template is built from empty |
| `gc.ttl` | `PGBRANCH_GC_TTL` | `7d` | Default TTL for `gc` |
| `appUrl` | `PGBRANCH_APP_URL` | none | URL to print, with `{database}`. If not set, the admin URL with the database replaced is printed |
| `dataApi.resourceArn` | `PGBRANCH_RESOURCE_ARN` | none | Aurora cluster ARN (data-api driver) |
| `dataApi.secretArn` | `PGBRANCH_SECRET_ARN` | none | Secrets Manager secret ARN (data-api driver) |
| `dataApi.region` | `PGBRANCH_REGION` | SDK default | AWS region (data-api driver) |
| (env / flag only) | `PGBRANCH_ADMIN_URL` | none | Admin URL. Not read from the file, so the password stays out of git |

Use `appUrl` so your app does not get the admin credentials.

### Hooks

Hooks run in a shell, with the directory of the config file as cwd (or the current directory if
there is no config file). A non-zero exit code is a failure. Env vars:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Admin URL with the target database |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Same, as libpq variables |
| `PGBRANCH_BRANCH` | Branch name (empty during `template refresh`) |
| `PGBRANCH_DATABASE` | Target database name |

In Data API mode there is no URL. The hook gets `PGBRANCH_RESOURCE_ARN`, `PGBRANCH_SECRET_ARN`,
`PGBRANCH_DATABASE` and `PGBRANCH_BRANCH` instead.

### Strategies

- `template` (default): `CREATE DATABASE <new> TEMPLATE <source>`. Runs on the server, no data goes
  over the network.
- `dump`: `pg_dump -Fc` to a temp file, then `pg_restore` into a new database. Slower, but works when
  template cloning is not possible, and `create --from` does not need to terminate connections to the
  source branch. Needs `pg_dump` and `pg_restore` in `PATH`, the same major version as the server or
  newer. While the template is being dumped, connections to it are allowed for a short time.

## Required privileges

The admin role needs:

- `LOGIN` and `CREATEDB`. Superuser is **not** needed.
- To own the databases it manages. pgbranch creates them, so this is true unless you change the
  owner. Owning is needed for `ALTER DATABASE` (rename, `IS_TEMPLATE`), `DROP DATABASE`, and to use a
  normal branch database as a source with `create --from`.
- To end sessions of other roles (for `delete`, `reset`, `gc`, `create --from` while your app is
  connected): membership in `pg_signal_backend`. On Aurora / RDS, `rds_superuser` already has it.

```sql
CREATE ROLE pgbranch_admin LOGIN CREATEDB PASSWORD '...';
GRANT pg_signal_backend TO pgbranch_admin;
```

### Ownership of tables

Hooks run as the admin role, so tables created by migrations are owned by it. If your app uses a
different role (via `appUrl`), give it access in your migrations, for example:

```sql
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
```

Grants are copied with the template, so every branch database has them. `CONNECT` on new databases
is granted to `PUBLIC` by default.

## Safety rule

pgbranch never drops, renames, alters or terminates connections to a database whose name does not
start with `<prefix>_`. It also never touches `postgres`, `template0`, `template1` or `rdsadmin`.
This check is in one function (`assertManaged` in `src/names.ts`), and every statement that changes
a database goes through it. Use `--dry-run` to see the SQL before running it.

Pick a prefix that no other database on the cluster uses.

## GitHub Action

```yaml
- uses: OWNER/pgbranch@v0   # replace with the published location
  id: db
  with:
    command: create --if-not-exists
    admin-url: ${{ secrets.PGBRANCH_ADMIN_URL }}
- run: npm test
  env:
    DATABASE_URL: ${{ steps.db.outputs.url }}
```

| Input | Meaning |
| --- | --- |
| `command` | Command and flags: `create --if-not-exists`, `delete --if-exists`, `reset`, `url`, `list`, `gc --ttl 7d`, `template refresh` |
| `branch` | Branch name for create / reset / delete / url. Default: the PR head branch, else the pushed branch |
| `config` | Config file path (default `pgbranch.json`) |
| `admin-url` | Admin URL. Masked in logs |

| Output | Meaning |
| --- | --- |
| `database` | Branch database name |
| `url` | Connection URL. Masked if it has a password |

The runner must reach your cluster. For Aurora in a private VPC, use a self-hosted runner in the VPC,
or the Data API driver (then your migration tool must also work through the Data API, or the
migrate step must run inside the VPC).

### Example workflow

```yaml
name: Branch database

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
  push:
    branches: [main]
  schedule:
    - cron: '17 3 * * *'   # nightly gc

env:
  PGBRANCH_ADMIN_URL: ${{ secrets.PGBRANCH_ADMIN_URL }}

jobs:
  # Keep the template at the schema of main.
  template:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npm ci            # the migrate / seed hooks need your tools
      - uses: OWNER/pgbranch@v0
        with:
          command: template refresh

  # One database per PR. Runs on every push to the PR.
  branch-db:
    if: github.event_name == 'pull_request' && github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npm ci
      - uses: OWNER/pgbranch@v0
        id: db
        with:
          command: create --if-not-exists
      - run: npm test
        env:
          DATABASE_URL: ${{ steps.db.outputs.url }}

  # Drop it when the PR is closed or merged.
  cleanup:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5   # for pgbranch.json
      - uses: OWNER/pgbranch@v0
        with:
          command: delete --if-exists

  # Drop branch databases that were left behind.
  gc:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: OWNER/pgbranch@v0
        with:
          command: gc --ttl 14d
```

## Data API mode (experimental)

With `"driver": "data-api"`, pgbranch talks to Aurora through the RDS Data API instead of a direct
connection. Set `dataApi.resourceArn` / `dataApi.secretArn` (or `PGBRANCH_RESOURCE_ARN` /
`PGBRANCH_SECRET_ARN`). AWS credentials come from the normal AWS SDK chain.

- The `dump` strategy is not supported in this mode.
- Hooks get ARNs instead of a URL (see [Hooks](#hooks)). Your migration tool must support the Data
  API, or the job must run inside the VPC with a normal connection.
- **Not yet tested on a real cluster.** It is not confirmed that the Data API runs
  `CREATE DATABASE` outside a transaction. Please run the smoke test and report the result:

  ```sh
  npm run build
  PGBRANCH_RESOURCE_ARN=... PGBRANCH_SECRET_ARN=... AWS_REGION=... node scripts/data-api-smoke.mjs
  ```

  It only creates and drops databases named `pgbranch_smoke_*`. It takes about 4 minutes because it
  checks that a lock survives an idle period.

## Known limits

- **Copies are full copies.** `CREATE DATABASE ... TEMPLATE` copies every page of the template.
  It is not copy-on-write like Neon. Keep the template small (schema plus a little seed data).
- **Branches share the cluster.** Compute, memory and connections are shared with everything else on
  the cluster. There is no per-branch compute.
- **Cluster-level objects are not branched**: roles, tablespaces, and settings stored with
  `ALTER ROLE` are shared. Extensions are per database and are copied.
- **Hooks get admin credentials.** Use `appUrl` for your app.
- `create --from <branch>` with the `template` strategy terminates the connections to the source
  branch database.
- The dump strategy needs `pg_dump` the same major version as the server or newer.
- PostgreSQL 14+ only (`DROP DATABASE ... WITH (FORCE)` and other newer syntax).
- Data API mode is experimental, see above.

## Development

```sh
npm install
npm test                   # unit tests
npm run typecheck
npm run build

# Integration tests need a Postgres superuser URL. They create the roles
# pgbranch_it (CREATEDB only) and pgbranch_it_app and use random prefixes.
PGBRANCH_TEST_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:integration

npm run build:action       # rebuild action-dist/ (commit the result)
```

Decisions and open questions are in [NOTES.md](NOTES.md).
