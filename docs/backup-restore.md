# Backup and restore

How Haggle's Postgres state, in Supabase, is backed up, and how to prove a restore works **without touching the production database**.

State that matters:
- jobs, quotes and approvals;
- payment handoffs and bookings;
- suppressions;
- workspaces and their hashed credentials;
- the outbox and the migration ledger.

Losing the outbox or suppressions can make Haggle contact someone twice, or contact someone who opted out. Treat a restore as an incident (`docs/runbook-incidents.md`).

## 1. What Supabase provides

Marked **to verify** wherever it depends on the plan or may have changed. Check the project's **Database → Backups** page and Supabase's backup documentation before relying on any of it:

| Feature | What Supabase documents | Status for our projects |
|---|---|---|
| Daily backups | Automatic daily backups on paid plans. Retention depends on the plan (documented as 7 days on Pro, longer on Team / Enterprise). The Free plan has no downloadable backups | **To verify:** the plan of the production and staging projects, and the retention shown on the Backups page |
| Point-in-time recovery (PITR) | A paid add-on (needs at least a small compute add-on) that restores to any second within its retention window, from WAL archiving. When enabled, it replaces daily backups | **To verify:** is PITR enabled on production, and with what retention? Recommended before real vendors are contacted |
| Restore in place | From the dashboard, restore the **same project** to a backup or a PITR timestamp. The project is unavailable during the restore, and everything written after that point is lost | Operator action only, never automated |
| Restore to a new project | Supabase documents restoring a backup into a **new** project, which is the safe way to inspect old data | **To verify:** availability on our plan |
| Storage objects | Database backups don't include Storage API objects | Haggle keeps no Storage objects (attachments are parsed and stored as rows), so nothing to add. **To verify** if that changes |

Whatever the plan, also take **our own logical dump** before every migration. That gives a copy that doesn't depend on Supabase's plan (section 2).

## 2. Before every migration: a logical dump

Run it from a trusted machine, with the target's URL in an env file the operator passes (never the repo's `.env` by default). The direct connection or the session pooler both work for `pg_dump`. Use a `pg_dump` version ≥ the server's major version (17).

```bash
set -a; . <path to the target env file>; set +a        # loads SUPABASE_DB_URL; prints nothing
pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner --no-privileges \
  --schema=public --file "haggle-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

- **Staging.** `staging-release.ts --execute --backup-dump <file>` takes the same dump (`--schema=public`, or `HAGGLE_DB_SCHEMA`) before any DDL. It passes the database to `pg_dump` in `PG*` variables, never on the command line. It refuses a path inside the repository and refuses to touch the schema without a dump or a `--backup-ref` (`docs/staging.md` §4).
- **The file is sensitive.** It contains contact details, hashed credentials and vendor messages. Store it encrypted (an encrypted disk or a vault). Never put it in the repo or a chat. Delete it when its retention ends.
- **Record the dump name** in the migration's change log, next to the ledger output (`migrations.ts status`).
- **Brain profiles.** With `HAGGLE_DB_SCHEMA` set, dump that schema instead of `public`. Also dump the brain's tables if they live elsewhere (`200_brain_profiles`).

## 3. Restore test into a throwaway database

This proves the dump restores and that the restored schema matches the repo. Run it at least once per pilot phase, and after any migration that changes constraints. It never touches the source database after the dump.

```bash
# 1. A throwaway Postgres 17 on this machine (removed at the end).
docker run -d --name haggle-restore-test -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55499:5432 postgres:17-alpine
until docker exec haggle-restore-test pg_isready -U postgres -q; do sleep 0.5; done
docker exec haggle-restore-test psql -U postgres -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;"
export RESTORE_URL=postgres://postgres:postgres@127.0.0.1:55499/postgres

# 2. Restore (the dump's public schema replaces the empty one).
pg_restore --dbname "$RESTORE_URL" --no-owner --no-privileges --clean --if-exists haggle-<timestamp>.dump

# 3. The ledger vs this checkout. Read-only; a localhost database is never "production".
HAGGLE_ENV=development node apps/mcp/scripts/migrations.ts status --db-url-env RESTORE_URL

# 4. Spot checks: row counts against the source's counts at dump time (noted in step 2 of section 2).
psql "$RESTORE_URL" -c "select (select count(*) from jobs) jobs, (select count(*) from quotes) quotes, (select count(*) from approvals) approvals, (select count(*) from vendor_suppressions) suppressions, (select count(*) from outbox) outbox, (select count(*) from engine_migrations) ledger"

# 5. Remove the throwaway database.
docker rm -f haggle-restore-test
```

**Pass criteria:**
- `pg_restore` exits 0. Grant warnings for Supabase-only roles are acceptable; note them.
- `migrations.ts status` shows the ledger present, with no drift against the commit the source runs.
- The row counts match the source's counts taken just before the dump.

**Upgrading a restored or old copy.** CI's `scripts/migration-compat.sh` runs the same upgrade the live database will need on a throwaway database, on every push. It starts from 102 with demo-era rows, applies 103 to the latest one file at a time, then runs the ledger backfill, record and verify. A restored copy at any migration upgrades the same way: `migrations.ts status`, then each pending file and its `record`.

**Never point a Haggle server at the restored copy in live mode.** It holds real contacts, and a live server would resume their deals. To inspect, use `psql` or `job-ops.ts` with `HAGGLE_ENV=development` against the throwaway URL.

## 4. Restoring production (incident only)

1. **Stop outbound work first.** Scale the server to zero, or remove the Inkbox webhook subscription, so nothing sends while data is rolled back. Note the time.
2. **Choose the target time.** Take the last moment before the damage (PITR), or the latest good backup.
3. **Restore the data.** Prefer restoring into a **new project**, then compare it and switch `SUPABASE_DB_URL`. Use an in-place restore only when the damage is total.
4. **Reconcile what happened after the restore point.** Messages sent, calls placed and handoffs confirmed after that point aren't in the restored database. Before the server resumes:
   - list them from Inkbox (mail, texts, calls) and the operator's records;
   - re-add every suppression created after it (`workspace-admin`);
   - record anything uncertain as an operator review.
5. **Verify, then resume.**
   - `migrations.ts verify` against the restored database;
   - the launch gate against the new URL;
   - deploy;
   - `smoke.ts --live-readonly`.

   Re-enable webhooks last.
