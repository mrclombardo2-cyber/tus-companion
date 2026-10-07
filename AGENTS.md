# TUS Companion — Codex / ECC project instructions

These instructions are the project-level source of truth for AI-assisted changes in this repository.

## Product and production baseline

TUS Companion is an independent PWA for TUS Athlone timetables. Students select a Department and Student Group; they do not provide TUS or Microsoft credentials.

Current baseline:
- app release: `v16.5.2`
- production: Cloudflare Worker + static PWA assets + D1 + Queues + Browser binding
- source timetable: TUS / Scientia
- deployment gate: GitHub Actions regression tests followed by live Cloudflare verification
- production URL: `https://tus-companion.tusathlone.workers.dev`

Treat the checked-in code and workflows as authoritative if version numbers later change.

## Architecture ownership

- `frontend/` — PWA UI, CSS, service worker, manifest and browser-side cache/offline behavior.
- `cloud/worker/src/index.js` — Worker entry point, public API, scheduled work, queue handling and orchestration.
- `cloud/worker/src/scientia.js` — TUS/Scientia integration.
- `cloud/worker/src/timetable.js` — timetable normalization/processing.
- `cloud/worker/src/calendar.js` — ICS/calendar behavior.
- `cloud/worker/wrangler.toml` — Cloudflare bindings, queues, cron and D1.
- `cloud/worker/migrations/` — D1 migrations. Never rewrite an already-applied migration to change production schema; add a new migration.
- `cloud/collector/` — source-session maintenance/recovery helpers.
- `tests/` — Node and Playwright regression coverage.
- `.github/workflows/deploy-cloudflare.yml` — production test/deploy/live-verification pipeline.
- `.github/workflows/session-keeper.yml` — source-session keepalive workflow.
- `backend/` — legacy/local Python implementation and tests. Do not make it the production architecture unless the task explicitly requires that change.

## Non-negotiable invariants

1. Keep the production architecture Cloudflare-first. Do not introduce Firebase, Supabase, a paid always-on server, or a dependency on the user's PC unless explicitly requested.
2. The deployed app must continue to work while the user's personal computer is off.
3. Never require ordinary students to enter TUS/Microsoft credentials into the app.
4. Never place tokens, cookies, private keys, source-session material, admin credentials or other secrets in frontend code, commits, logs, fixtures, screenshots, test output or documentation.
5. Preserve the current timetable UX:
   - a previously used group may render its last valid cached timetable immediately;
   - refresh then happens in the background;
   - a first-time group waits for a fresh result;
   - stale first-open work uses the priority path;
   - offline mode continues to expose the last valid browser snapshot with an explicit cached/offline state.
6. Preserve D1 snapshot/history semantics and queue serialization unless there is a demonstrated correctness reason to change them.
7. Preserve source-session recovery and keepalive behavior. Changes touching authentication/session recovery require targeted review of both the Worker path and `session-keeper.yml`.
8. Preserve the PWA update path: service-worker/cache changes must not strand installed clients on stale assets.
9. Keep public calendar feeds backward compatible unless a breaking change is explicitly requested.
10. TUS Companion must continue to identify itself as independent/unofficial; do not imply TUS endorsement.
11. Prefer a small, reversible patch over a broad rewrite. Do not refactor unrelated code while fixing a scoped issue.
12. Do not deploy, rotate secrets, alter Cloudflare resources, mutate production D1 data, or change GitHub repository secrets unless the user explicitly asks for that external action.

## Required workflow for non-trivial changes

1. Explore first. Trace the real execution path and identify the smallest affected surface.
2. State the behavioral contract before editing.
3. Add or update a regression test when the change is testable.
4. Implement the smallest coherent change.
5. Run the relevant static and regression checks.
6. Review the diff for regressions, secrets, unintended dependency changes and production-side effects.
7. For Cloudflare/source/session changes, compare the proposal against the live-verification expectations in `.github/workflows/deploy-cloudflare.yml`.
8. Only declare completion when the verification performed is stated explicitly. Never claim production success from local tests alone.

Use ECC skills selectively when useful (for example verification, TDD, security review, code review, browser testing). Do not invoke every skill mechanically.

## Local verification baseline

From the repository root, the CI-equivalent non-production checks are:

```bash
node --check cloud/worker/src/index.js
node --check cloud/worker/src/calendar.js
node --check cloud/worker/src/scientia.js
node --check cloud/worker/src/timetable.js
node --check frontend/app.js
node --check frontend/sw.js

node --test tests/calendar.test.mjs
node --test tests/timetable.test.mjs
```

For UI regression testing, serve `frontend/` on port 4173 and run:

```bash
npx playwright test
```

Do not weaken or delete a failing regression merely to make a change pass.

## Change-specific verification

- Frontend/UI/CSS: test desktop and mobile viewports, narrow width, Today/Week behavior, course search, offline state and PWA update behavior when relevant.
- Service worker/cache: explicitly test upgrade from an older cached version as well as a clean first visit.
- Timetable parser/Scientia: test known-normal input plus empty, stale, partial and malformed upstream responses.
- Queue/scheduler: reason about duplicate jobs, retries, serialization, idempotency and stale/fresh transitions.
- D1: review migration safety, existing-row compatibility and rollback/recovery implications.
- Push/reminders: avoid duplicate sends and verify timezone/time-boundary behavior.
- Calendar/ICS: preserve stable URLs and valid calendar output.
- Security-sensitive work: verify authorization boundaries, rate limiting, input validation and secret handling.

## Dependency and platform policy

- Do not upgrade Node, Wrangler, Playwright, Cloudflare packages or GitHub Actions merely because a newer version exists.
- For platform/API behavior that may have changed, verify against primary Cloudflare, Playwright, GitHub or browser documentation before editing.
- Avoid adding runtime dependencies when the platform or existing code already provides the capability.
- Do not add telemetry, third-party analytics or tracking without explicit approval.

## Git and release discipline

- Work on a branch for substantive changes.
- Keep commits focused.
- Review the complete diff before proposing merge.
- Version bumps must remain coherent across the files and live checks that consume them.
- A merge to `main` can trigger production deployment. Treat merging as a production-affecting action.
- Never bypass the production workflow's live verification to force a release through.

## Completion format

For each completed coding task, report:
- what changed;
- files touched;
- tests/checks actually run and their result;
- anything not verified;
- whether the change has been deployed or is only committed/proposed.

Do not say “done”, “fixed” or “production-ready” if the relevant verification was not performed.
