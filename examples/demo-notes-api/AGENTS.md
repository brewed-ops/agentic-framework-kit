# demo-notes-api

Tiny notes API: users own notes, list them page by page, and read them by id.

## Rules
- Every `/notes` request needs `Authorization: Bearer <token>`; a user only ever sees or changes
  their own notes.
- A bad request returns a 4xx JSON error; it never crashes the server.
- Response shapes are a contract: `src/client.mjs` and outside callers depend on them.
- Every behavior change comes with a test in `test/`; never weaken a test to make it pass.
- No dependencies.

Tests: `npm test`. Lint: `npm run lint`.
