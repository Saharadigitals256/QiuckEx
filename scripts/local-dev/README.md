# Local development stack

Bootstrap a local Supabase and Redis with seeded fixtures, so a contributor can
run the backend against real services instead of mocks (issue
[#296](https://github.com/Viky207/QiuckEx/issues/296)).

```bash
./scripts/local-dev/bootstrap.sh              # start/verify services, then seed
./scripts/local-dev/bootstrap.sh --seed-only  # apply fixtures to a running stack
./scripts/local-dev/bootstrap.sh --check      # verify the stack, seed nothing
./scripts/local-dev/bootstrap.sh --reset      # drop local data, then bootstrap
```

Then export what it prints and start the backend:

```bash
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY=$(supabase status -o env | grep ANON | cut -d= -f2-)
export REDIS_URL=redis://127.0.0.1:6379
pnpm --filter @quickex/backend dev
```

## What it does

1. **Preflight** — checks `supabase`, `psql`, and `redis-cli`, and reports *every*
   missing tool in one pass with the install command for each.
2. **Start** — brings up the local Supabase stack and waits for Postgres to accept
   connections.
3. **Redis** — waits for `PING`. Redis is **optional**: `env.schema.ts` documents
   that omitting `REDIS_URL` falls back to in-memory behaviour, so a missing Redis
   is a warning, not a failure.
4. **Migrate** — delegates to the owning module's runner
   (`app/backend/run-migration-supabase.js`) rather than reimplementing it.
5. **Seed** — applies [`seed.sql`](./seed.sql) inside a transaction.
6. **Verify** — confirms the schema and Redis are reachable, then prints the
   connection values.

## Seeded fixtures

| Table | Rows | Why |
|---|---|---|
| `verified_assets` | XLM, USDC | The assets a merchant can list locally; mirrors the tiers in the asset listing policy. |
| `usernames` | `merchant`, `customer`, `arbiter` | One handle per fixture role, so profile and marketplace paths have something to resolve. |
| `payment_links` | one active, one **expired** | The expired row makes the INV-06 expiry path reachable without hand-editing rows. |
| `notification_preferences` | merchant + customer | One row per `(public_key, channel)` pair. |

Every insert is `ON CONFLICT DO NOTHING` against a stable natural key, so
re-running the bootstrap never duplicates rows and never disturbs local edits.

## Safety

These scripts are **local development only**.

- `seed.sql` opens with a guard that raises an exception unless
  `current_database()` is a local name, so a misdirected `SUPABASE_DB_URL` aborts
  inside the transaction instead of writing to a hosted project.
- `--reset` refuses to run against anything that is not a loopback host, so a
  stray `DATABASE_URL` cannot turn a convenience script into a data-loss tool.
- **No fixture contains signing material.** The Stellar keys are public keys
  only. QuickEx is self-custody (ADR 0001): the backend holds no private keys, so
  a fixture that needed one would be a design error, not a missing convenience.
  `check-seed.mjs` enforces this.

## Checking the fixtures in CI

CI has no local stack, so the seed is validated statically instead of executed:

```bash
node scripts/local-dev/check-seed.mjs            # all checks
node --test scripts/local-dev/__tests__/seed.test.mjs
```

| Check | Enforces |
|---|---|
| `schema` | every table and column the seed names is created by a migration, including columns added by later `ALTER TABLE` migrations |
| `idempotency` | every insert has an `ON CONFLICT` clause |
| `secrets` | no Stellar secret key, mnemonic, PEM block, 64-hex private key, or JWT |
| `publicKeys` | every Stellar key is a syntactically valid public key (`G` + 55 base32) |
| `localGuard` | the seed has a `RAISE EXCEPTION` guard on `current_database()` and runs in an explicit transaction |

Fixtures rot silently — a renamed column or a reworded seed looks fine until
someone runs it locally. These checks turn that into a CI failure.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Supabase CLI not found` | `npm i -g supabase` |
| `psql not found` | `brew install postgresql` |
| `Redis did not respond` | Expected without Redis; the backend uses in-memory fallbacks. Start Redis with `brew services start redis` to test that path. |
| `Refusing to seed non-local database` | Your `SUPABASE_DB_URL` points at a hosted database. Unset it to use the local default. |
| `--reset refused: '<host>' is not a loopback host` | Working as intended. `--reset` only ever drops a local schema. |
| Seed fails with a column error | Run `node scripts/local-dev/check-seed.mjs` — it names the offending column and the known ones. |
