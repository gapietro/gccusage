# Process documents

`plans/` and `specs/` are the design and implementation documents written
while building this repo. They are committed so the reasoning behind a change
survives the pull request that made it.

## Sanitize before committing

This is a public repository, and these documents are written mid-session, so
they tend to accumulate pasted shell lines, transcript excerpts and payloads
straight from the author's machine. Scrub them the same way
`src/__tests__/fixtures/real-payloads/capture.md` scrubs captured payloads:

| Leaked value | Write instead |
|---|---|
| Absolute scratchpad path (`/private/tmp/claude-<uid>/…`) | `<scratchpad>` |
| The author's OS username in a path | `/Users/x/…`, or `<username>` |
| A real session or prompt UUID | `00000000-0000-4000-8000-000000000000` |
| Anything else that names the host machine | a placeholder |

Example paths in specs should match the ones the tests use (`/Users/x/…`), so
the document and the test file read as the same example.

Check before opening the PR:

```bash
grep -rnE '/private/tmp/claude-|/Users/[a-z]{3,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' docs/
```

Only placeholder UUIDs and generic usernames should come back. Fixing this at
review time only cleans the tip — the value stays in git history — so it is
worth catching before the commit rather than after (#64).
