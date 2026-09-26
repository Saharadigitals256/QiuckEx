# 0003. Supabase is the system of record; no additional relational database

- Status: Accepted
- Date: 2026-02-10
- Surfaces: app/backend

## Context

`app/backend` needs to persist usernames, payment links, API keys, webhook
subscriptions and delivery logs, notification preferences, feature flags, audit
entries, receipt records, marketplace listings, and preview scopes.

`.env.example` also carries `DATABASE_URL`, `DATABASE_HOST/PORT/NAME/USER/PASSWORD`
and `REDIS_URL`. That template is inherited from an earlier design and does not
reflect what the backend actually does: there is no ORM, no migration runner, and
no query against those variables. The Supabase client is the only datastore the
code touches. See `app/backend/src/supabase/`.

This mismatch is a real source of contributor confusion — the README previously
told people to run `npx prisma migrate dev` or `npm run migration:run`, neither of
which exists in this repository.

## Decision

Supabase (Postgres + PostgREST + Auth-adjacent helpers) is the **only** system of
record for application data. The backend accesses it exclusively through
`SupabaseService` and the `@supabase/supabase-js` client. There is no second
relational database, no ORM, and no separate migration runner.

Rules that follow:

1. New persistent state goes in Supabase. Adding a datastore requires superseding
   this ADR.
2. `.env.example` is a **cross-stack template**, not a description of required
   backend config. Variables the backend does not read (`DATABASE_*`, `REDIS_URL`,
   `STRIPE_*`) are documented as such or removed. The authoritative list of what
   the backend requires is the Joi schema in
   `app/backend/src/config/env.schema.ts`, which is validated at startup.
3. `SUPABASE_URL` pointing at local Supabase is a signal, not an error:
   `ReconciliationModule`, `NotificationsModule`, and `DeveloperModule` are skipped
   in that configuration (`app/backend/src/app.module.ts`). This is degraded mode,
   not a crash, and the backend must still start and serve `/health`.
4. Schema changes go through Supabase migrations committed to the repository, and
   any PR that changes schema states its rollback path.

## Alternatives considered

**Add Prisma/TypeORM and a Postgres pool.** Rejected. It introduces a second data
path that must agree with the Supabase RLS policies, plus a migration toolchain, in
exchange for query ergonomics the existing client already covers.

**Keep the `DATABASE_*` variables for a future migration.** Rejected as a comment,
not a config. Unused variables in a template get read as requirements. The README
now calls them out explicitly instead.

**Redis as a primary store for links.** Rejected. Redis is a cache; making it a
source of truth would break the INV-01 traceability the current design keeps, for
a read-path optimization that Postgres indexes already handle.

## Consequences

- Contributors do not need PostgreSQL or Redis running locally for the core flows.
  This removes a setup step and the class of "works on my machine" failures from
  missing services.
- The `DATABASE_*` and `REDIS_URL` entries in `.env.example` are a known wart. They
  are documented rather than deleted here because the same template is consumed by
  deployment tooling; cleanup is tracked separately.
- Any capability needing strong relational constraints, complex joins, or
  transactional multi-row writes (reconciliation being the current candidate) is
  harder in PostgREST than it would be behind an ORM. Accepted for now; if it
  becomes the bottleneck, the decision to revisit belongs in a new ADR rather than
  a quiet migration.
- RLS is part of the security posture. A new table without an RLS policy is
  incomplete, and reviewers should treat it as `custody:sensitive` when it holds
  financial records.
