# greploop report - standard profile, main (adef3dc) .. f8036af

## Executed checks

- test: `npm test` -> exit 0 (ran by the runner, 0.6s); scope: node --test test/*.test.mjs
- lint: `npm run lint` -> exit 0 (ran by the runner, 0.6s)
- scanloop: verdict CLEAN from .scanloop/report.json
  - gitleaks 8.30.1: ran - `gitleaks.exe git --no-banner --redact --report-format json --report-path .scanloop/gitleaks.json --log-opts=adef3dc643b243d519ec2bcdc9e889a6d37b90fb..HEAD .`
  - semgrep 1.165.0: ran - `semgrep.exe scan --metrics=off --disable-version-check --config p/security-audit --config p/secrets --config p/owasp-top-ten --config p/javascript --baseline-commit adef3dc643b243d519ec2bcdc9e889a6d37b90fb --json --output .scanloop/semgrep.json -- src/server.mjs src/store.mjs test/notes.test.mjs`

## Review findings

- profile standard; iterations 2/3; reviewer dispatches 6/12; escalated quick -> standard after iteration 1
- lens scores are reviewer confidence (1-5), not proof of correctness:
  - bundle all: iteration 3 - correctness 4, security 4, quality 4; panel found no blocking or major issues
- confirmed and fixed:
  - F1 [blocking][consensus] src/store.mjs:19 - This is off by one. The comment and the feature both say 'only notes created after the note with that id', but >= keeps that note too. The normal way to use since is to pass the id of the caller's own last-seen note, so every poll returns that note again and clients see duplicates. I confirmed it: alice's note 1 is 'old', bob's note 2 is 'x', alice's note 3 is 'new', and list('a',{since:1}) returns ['old','new'] instead of ['new']. This is a behavior contract bug on /notes. -> since filter uses > so the cursor note is excluded; test `node --test test/notes.test.mjs` exit 0; red with the fix reverted (exit 1, claimed)
  - F2 [blocking][consensus] test/notes.test.mjs:64 - The test cannot catch the off-by-one. since=2 is bob's note id, and the owner filter already removes bob's notes, so >= and > give the same result. The test never uses one of the caller's own ids as the cursor, which is the boundary that matters. This breaks the house rule that every behavior change needs a real test. -> test uses alice's own note as the boundary and asserts total; test `node --test test/notes.test.mjs` exit 0; red with the fix reverted (exit 1, claimed)
  - F3 [major][consensus] src/server.mjs:41 - A bad since value (since=abc, since=-3, since=1.5, since=0 or an empty since=) falls back to 0. The store then treats it as 'every note', so the server returns 200 with the full list. The house rule says a bad request gets a 4xx JSON error. For a sync cursor, silently widening to all notes is worse than failing, because the client cannot tell that its cursor was ignored. -> since that is not a whole number returns 400; new test covers abc, -1, 1.5 and empty; test `node --test test/notes.test.mjs` exit 0; red with the fix reverted (exit 1, claimed)
- unresolved: none
- disputed: none
- pre-existing (not introduced by this change, never blocks):
  - src/server.mjs:39 - An invalid page or pageSize (for example page=abc) silently falls back to the default instead of returning a 4xx. pageSize also has no upper limit, so pageSize=1e9 is accepted. The new since line copied this pattern. (reported by reviewer)
  - src/store.mjs:28 - remove takes no owner. No route exposes it today, but any future DELETE route that calls it directly would let one user delete another user's notes, unlike the GET /notes/:id route, which checks the owner. (reported by reviewer)
  - src/store.mjs:18 - Every list call copies and scans every note from every user (O(total notes) per request). This does not scale past a toy store, but the diff did not introduce it. (reported by reviewer)
  - src/server.mjs:32 - TOKENS is a plain object literal, so a lookup can hit an inherited Object.prototype key. A header like 'Bearer constructor' resolves to a truthy function, not undefined, and passes the !user check. The diff did not touch this line. The since change does not make it worse: the owner filter compares against a function, so it returns an empty list. (reported by reviewer)
  - src/server.mjs:24 - A malformed page or pageSize (for example page=abc or pageSize=-5) silently falls back to the default instead of returning a 4xx. That is inconsistent with the new since validation, which returns 400. There is also no upper bound on pageSize. (reported by reviewer)
  - src/client.mjs:18 - all() makes one sequential request per page (a round trip for every 50 notes). This is untouched by the diff. (reported by reviewer)
- minor:
  - F4 [minor][consensus] test/notes.test.mjs:58 - No test covers since together with page/pageSize, or checks that total reflects the filtered set. Both are part of the response contract that client.mjs relies on (its all() stops when out.length >= total).
  - F5 [minor][consensus] src/store.mjs:16 - The filter compares numeric ids, which only works while ids are sequential integers. The server now exposes since as an ordering cursor, and nothing in src/client.mjs or the docs describes it for outside callers.

## Coverage gaps

- 3 files changed = 3 reviewed + 0 skipped + 0 excluded
- scanner osv-scanner: not-applicable
- escalated quick -> standard after iteration 1

## Release decision

- [met] review exit condition met for every bundle (standard)
- [met] no open blocking or major findings (reviewer or scanner)
- [met] scanloop complete, every required scanner ran - verdict CLEAN
- [met] scanloop ran on the current code
- [met] required check "test" passed on the current code
- [met] required check "lint" passed on the current code
- Passed the configured checks
