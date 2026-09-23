# Database migrations

A deploy can be rolled back in seconds. A database change often cannot. Plan every schema
change so the old code and the new code can both run against the database while the change
is in flight, and so there is a written way back.

## 1. Expand, then contract

Split every breaking change into releases that are each safe on their own:

1. **Expand.** Add the new thing (column, table, index) without removing or renaming anything.
   Old code ignores it; new code can use it.
2. **Migrate.** Ship code that writes both old and new, backfill existing rows, then switch
   reads to the new one.
3. **Contract.** In a LATER release, once nothing reads the old column (and a rollback would
   not bring back code that does), drop it.

A rename is never one step: add the new column, copy, switch, drop the old one later. Never
drop or rename a column in the same release that stops using it - rolling that release back
would bring back code that needs a column that no longer exists.

## 2. Order: migration first, code second

The migration runs BEFORE the code that needs it is deployed. Because of expand/contract, the
currently live (old) code keeps working against the expanded schema, so there is no window
where live code and database disagree. If the migration fails, nothing new shipped.

Never rely on "the app runs pending migrations on boot" for a change that needs care: several
instances booting at once can race, and a failed migration becomes a crash loop.

## 3. Before running it on production

- **Backup, and know how to restore it.** SQLite: `sqlite3 app.db ".backup 'app-<timestamp>.db'"`
  (never `cp` a live database in WAL mode). Postgres: `pg_dump`, or note a point-in-time
  recovery marker if the host offers it. Write the restore command in the deploy report.
- **Dry run on a copy of production data.** Restore the backup somewhere else, run the migration
  there, run the app against it. Test data rarely has the NULLs, duplicates and very long rows
  that real data has.
- **Time it.** If the dry run takes minutes, it will lock tables on production for minutes.

## 4. Every migration has a way back

Either a `down` migration that was actually run once, or a written restore path ("restore
backup X, redeploy commit Y"). A dropped column's data cannot come back from a `down`
migration; only the backup has it. That is another reason contract steps come late.

## 5. Make migrations safe to run twice

A migration that dies halfway and is re-run must not fail or double-apply. Guard each step.

```sql
-- Postgres
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status text;
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
```

SQLite has no `ADD COLUMN IF NOT EXISTS`. Check first:

```js
const cols = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name)
if (!cols.includes('status')) db.exec("ALTER TABLE orders ADD COLUMN status TEXT")
db.exec("CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status)")
```

Create an index AFTER the step that adds its column. When schema setup runs as one script,
a `CREATE INDEX` placed before the guarded `ALTER` fails on every existing database (the column
is not there yet) while passing on a fresh one, so tests on an empty database never see it.

## 6. Backfill every new gating column

A new column that decides access or behavior (`is_verified`, `plan`, `role`, `status`) starts
as NULL or its default on every existing row. If the code treats that default as "no access",
every existing user is locked out the moment the release lands. Ship the backfill in the same
migration, before the code that reads the column, and check the count afterwards:

```sql
UPDATE users SET plan = 'free' WHERE plan IS NULL;
SELECT count(*) FROM users WHERE plan IS NULL;  -- must be 0
```

## 7. Big tables and long locks

- Adding a column with a constant default is fast on modern Postgres; adding a NOT NULL column
  or changing a column type can rewrite the whole table under a lock. Add nullable, backfill in
  batches, then add the constraint.
- Postgres: build indexes on large tables with `CREATE INDEX CONCURRENTLY` (it cannot run inside
  a transaction block, so it may need its own migration file).
- Set a lock timeout for migration sessions (`SET lock_timeout = '5s'`) so a migration waiting
  behind a long query fails fast instead of queueing every other request behind it.
- Backfill in batches of a few thousand rows, not one `UPDATE` of millions.
- MySQL and other engines have their own online-DDL rules; check the engine's docs for which
  changes lock the table.

## 8. Checklist for the deploy report

- [ ] Change is additive in this release (or the drop is a contract step for code already gone)
- [ ] Backup taken, restore command written down
- [ ] Dry run passed on a copy of production data, with timing
- [ ] Migration is idempotent (guarded) and indexes come after their columns
- [ ] New gating columns backfilled, NULL count checked
- [ ] Migration runs before the code that needs it
- [ ] Way back written: `down` migration or restore path
