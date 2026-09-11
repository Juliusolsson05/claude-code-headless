# Claude worktree transcript continuity

Status: implemented and locally verified; coordinated PR review/CI next.

## Problem and constraints

Native EnterWorktree relocates the same Claude session's transcript. Launch cwd is a hint, not durable transcript identity. The captured prompt was saved 31 ms after Enter but acknowledgement timed out against a missing file. Preserve exact identity and durable acknowledgement; never retry written prompts or synthesize acceptance from screen/proxy activity.

## Implementation sequence

1. Add deterministic filesystem regressions for resume from a missing original path and live transcript relocation. Include return to the original directory, stale relocation markers, ambiguous duplicates, foreign session identities, copied-history deduplication, and cleanup.
2. Implement one bounded exact-session resolver in claude-code-headless. Prefer a validated cwd candidate, follow native relocation metadata, discover the exact filename across provider project directories when needed, and reject ambiguity rather than guessing by mtime.
3. Bind headless observation to the resolved session, recover path changes, and distinguish missing resumes from fresh files not created yet. Keep replay/acceptance boundaries explicit and avoid replaying copied history during relocation.
4. Consume the public resolver in Agent Code history/session operations. Add host integration coverage for actual filesystem reads and real headless-to-prompt-acceptance delivery through the public package API.
5. Run targeted red/green regressions, repository checks and package verification, review diffs, synchronize Issues and open coordinated PRs. No merge without explicit user approval.

## Validation and ownership

Package system tests own resolver/watcher behavior. App system tests own history and delivery integration, without imports into package-private modules. Fixtures contain synthetic session IDs/content in isolated temporary directories; no personal home or provider credentials. Watchers, subprocesses and temporary files are always cleaned up. Real CLI verification is a separate explicit live check and must not touch the user's active session.

## Completion record

Issue: https://github.com/Juliusolsson05/claude-code-headless/issues/57. Host integration: https://github.com/Juliusolsson05/agent-code/issues/883.

- Exact-session discovery inspects bounded head/tail slices, follows native relocation markers (including terminal self-pointers), and rejects ambiguous or foreign identities. Missing resumes fail explicitly; an assigned fresh UUID may wait for its first write, including a move before its first observation.
- The live follower keeps one byte cursor and pending JSONL/UTF-8 data through rename/copy moves. A 256-byte anchor before the cursor checks continuity without hashing the entire consumed history. Inode/shrink detection covers redirect stubs. Revision counters preserve relocation signals received during asynchronous discovery; bounded backoff permits late destinations to recover.
- Regression tests were observed failing before the fixes. Final local `npm run check` passes: contract, types, 132 tests, build and installed-package smoke. `npm run test:coverage` passes the baseline.
- Tests use real temporary filesystem operations through the public headless API and a consumer-owned fake PTY. Native provider execution/UI verification remains a separate live check. The resolver also found the real incident transcript in a read-only check; no private transcript data is committed.
- Local verification used Node 25.5.0; package CI additionally checks supported Node 20.19 and 24. No merge is authorized.
