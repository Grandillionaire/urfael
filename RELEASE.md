# Cutting a release

A short, honest checklist so the docs never drift from the code again (a production-readiness audit once found the benchmark count cited five different ways across the docs; the `docs-consistency` test now fails the build if that recurs, but this is the human side).

## Steps

1. **Land the work.** Every change ships with tests; the security-critical paths are frozen as benchmark checks.
2. **Run the full gauntlet** from `app/`:
   ```bash
   npm test          # unit suite (pure + security regressions)
   npm run fuzz      # input-boundary fuzzing (ReDoS detector)
   npm run redteam   # differential SSRF
   npm run security  # boots the real daemon + dashboard, runs the attack classes
   npm run e2e       # live-daemon end-to-end (run in a clean env / CI; it writes a vault)
   ```
   All must be green.
3. **Re-read the numbers.** The benchmark prints `N/N checks across M attack classes`; note them. The `docs-consistency` unit test derives the channel count, class count, check count, and version from source and asserts every doc agrees, so a stale number fails `npm test`. If it fails, fix the doc it names.
4. **Bump the version** in `app/package.json` and add a `CHANGELOG.md` entry for it (the consistency test checks the entry exists).
5. **Regenerate the lockfile** if dependencies changed: `cd app && npm install --package-lock-only`, then commit `package-lock.json`. Confirm `npm audit` is clean or that any remaining advisory is build/GUI tooling only (the runtime daemon + CLI have zero required dependencies).
6. **Tag it:** `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`.
7. **Deploy the site** (manual, outward-facing): `vercel deploy --prod` from `docs/`, attributed to the project's noreply email.

## What is intentionally not automated

- The live-daemon `e2e` and `security` harnesses are not in the credential-free CI matrix because they boot a real daemon on your `claude` login; run them locally or in a privileged job.
- The desktop GUI build (`npm run dist`, electron-builder) is verification-gated and ships unsigned until signing certs exist.
