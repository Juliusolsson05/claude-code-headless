# Claude Code Semantic Event Spec

Source-backed catalog of every Anthropic streaming event Claude Code
consumes, every content block variant, every delta variant, and every
stop/usage/error shape. This document is the contract that the
`SemanticChannel` in this package must be able to represent.

All line references are into `claude-code-src/full/` unless otherwise
stated.

## Why this exists

`claude-code-headless` today has a three-channel scaffold (semantic,
screen, committed) but the semantic channel only models `turn_started /
turn_delta / turn_completed / source_changed`. That covers plain text
streaming and nothing else. Tool calls, thinking, refusals, usage,
server tools, stop reasons, MCP — none of that is representable on the
semantic channel today.

The new rendering strategy is: **live UI renders from the proxy-fed
semantic channel**, screen parsing is relegated to overlays and command
UX, JSONL is the settled source of truth. To make that work the
semantic channel has to be rich enough to represent everything Claude
Code's own TUI renders. This doc is the enumeration of what that is.

## 1. Transport-level SSE event families

From `services/api/claude.ts:1980-2296`:

| Event               | Source line(s)        | Notes |
| ------------------- | --------------------- | ----- |
| `message_start`     | 1980-1994             | Carries initial `BetaMessage` with `id`, initial `usage`, `model`. |
| `content_block_start` | 1995-2052           | Creates a block at `index`; type-specific init. |
| `content_block_delta` | 2053-2169           | Incremental update of a block. |
| `content_block_stop`  | 2171-2211           | Finalizes a block; triggers yielding an assistant message. |
| `message_delta`       | 2213-2293           | Final `stop_reason` + settled `usage`. |
| `message_stop`        | 2295-2296           | Terminal. |
| `ping`                | n/a (SDK consumes)  | Keepalive. |
| `error`               | via SDK error path  | `{ type: 'error', error: { type, message } }`. |
| `stream_event`        | 2301-2304           | Claude's *own* wrapper event layered on top. |

## 2. Content block variants

Instantiated at `content_block_start` in `claude.ts:1995-2052`.

| `type`                              | Streams via                         | Source lines |
| ----------------------------------- | ----------------------------------- | ------------ |
| `text`                              | `text_delta`                        | 2033-2040    |
| `thinking`                          | `thinking_delta`, `signature_delta` | 2041-2049    |
| `tool_use`                          | `input_json_delta`                  | 2000-2018    |
| `server_tool_use`                   | `input_json_delta`                  | 2003-2018    |
| `mcp_tool_use`                      | `input_json_delta`                  | logging.ts:669 |
| `connector_text` (feature-gated)    | `connector_text_delta`, `signature_delta` | 2068-2081 |
| `image`                             | — (not streamed)                    | utils/messages.ts:943 |
| `document`                          | — (not streamed)                    | errors.ts:289 |
| `redacted_thinking`                 | — (not streamed)                    | utils/tokens.ts:192 |
| `web_search_tool_result`            | — (server tool result)              | tools/WebSearchTool |
| `code_execution_tool_result`        | —                                   | messages.ts:2731 |
| `bash_code_execution_tool_result`   | —                                   | messages.ts:3040 |
| `text_editor_code_execution_tool_result` | —                              | messages.ts:3041 |
| `container_upload`                  | —                                   | messages.ts:2734 |
| `tool_result`                       | — (user-turn input)                 | messages.ts:949 |
| `advisor_tool_result`               | — (ant-internal)                    | claude.ts:2045 |

### Important quirks
- **Duplicate text between `content_block_start` and first `text_delta`**: Claude strips the initial text from `content_block_start` and lets `text_delta` provide everything (claude.ts:2023-2026).
- Same treatment for `thinking` at 2041-2049 (strip initial, rely on delta).
- `tool_use.input` is accumulated as a **string**, not parsed until `content_block_stop`.
- `signature` on thinking/connector_text blocks replaces, does not append.

## 3. `content_block_delta` variants

Handled in the switch at `claude.ts:2084-2162`:

| `delta.type`            | Payload field            | Target block                            |
| ----------------------- | ------------------------ | --------------------------------------- |
| `text_delta`            | `delta.text`             | `text`                                  |
| `thinking_delta`        | `delta.thinking`         | `thinking`                              |
| `signature_delta`       | `delta.signature`        | `thinking` or `connector_text`          |
| `input_json_delta`      | `delta.partial_json`     | `tool_use` / `server_tool_use` / `mcp_tool_use` |
| `connector_text_delta`  | `delta.connector_text`   | `connector_text` (feature-gated)        |
| `citations_delta`       | `delta.citation`         | Recognized, unhandled in claude.ts:2084-2086 |

## 4. Stop reasons

From `claude.ts:2242-2293`:

| `stop_reason`                   | Meaning                           | Claude-code behavior |
| ------------------------------- | --------------------------------- | -------------------- |
| `end_turn`                      | Normal completion                 | Nothing special; commit + idle. |
| `tool_use`                      | Model is calling a tool           | Continue loop with tool result. |
| `max_tokens`                    | Output cap hit                    | Yields error text; analytics `tengu_max_tokens_reached` (2264-2275). |
| `model_context_window_exceeded` | Prompt too large                  | Yields error text; analytics `tengu_context_window_exceeded` (2276-2293). |
| `pause_turn`                    | Model paused mid-turn             | Treated like `end_turn` currently. |
| `refusal`                       | Model refused per usage policy    | Yields refusal error via `getErrorMessageIfRefusal` (errors.ts:1184-1204). |
| `stop_sequence`                 | Configured stop sequence matched  | Commit + idle. |

## 5. Usage accounting

From `message_start.message.usage` and `message_delta.usage`, merged in
`updateUsage()` at `claude.ts:2924-2976`:

- `input_tokens`                  *(merge if > 0)*
- `output_tokens`                 *(always take latest)*
- `cache_creation_input_tokens`   *(merge if > 0)*
- `cache_read_input_tokens`       *(merge if > 0)*
- `cache_creation.ephemeral_1h_input_tokens`
- `cache_creation.ephemeral_5m_input_tokens`
- `cache_deleted_input_tokens`    *(feature-gated CACHED_MICROCOMPACT)*
- `server_tool_use.web_search_requests`
- `server_tool_use.web_fetch_requests`
- `service_tier`
- `inference_geo`
- `speed`
- `iterations` (tool-use loop counts)

## 6. Error shapes

- Streaming-level defensive errors (logged but not yielded): mismatched
  deltas, missing blocks, missing message — `claude.ts:2056-2189`. We
  surface these on the semantic channel as soft diagnostics.
- API errors via `APIError`: `status`, `message`, `headers`,
  `error.type`. See `services/api/errors.ts` and
  `services/api/withRetry.ts`. 529 overloaded errors are string-sniffed
  when status is lost (`claude.ts:2719-2723`).
- Refusal text generated by `getErrorMessageIfRefusal`
  (`errors.ts:1184-1204`).

## 7. Correlation headers

From `services/api/client.ts:104-389`:

- Request: `X-Claude-Code-Session-Id`, `x-client-request-id`, `x-app`,
  `User-Agent`, optional `x-claude-remote-container-id`,
  `x-claude-remote-session-id`, `x-anthropic-additional-protection`.
- Response: `request-id`, `retry-after`, `x-should-retry`,
  `anthropic-ratelimit-unified-reset`.

**Key for turn attribution**: `X-Claude-Code-Session-Id` plus request
ordering relative to the user prompt are the knobs we use to decide
which `/v1/messages` flow is the visible assistant turn.

## 8. TUI rendering rules we replicate

From `components/messages/` and `components/Spinner.tsx`:

- **Assistant text** → markdown (`Markdown` component, marked.lexer).
  Plain text fast-path via `MD_SYNTAX_RE` regex.
- **Thinking** → collapsed by default to `"∴ Thinking"`; verbose / expand
  shows full italic dimmed markdown.
- **Tool use** →
  - queued: static `●`
  - in-progress: animated blink circle
  - resolved: colored circle (`success` green / `error` red)
  - header: `tool.userFacingName(input) + "(" + tool.renderToolUseMessage(input) + ")"`
  - `(ctrl+o to expand)` when truncated.
- **Tool result** → tool's own `renderToolResultMessage`; Edit renders
  structured diffs with 3 lines of context.
- **Redacted thinking** → `"✻ Thinking…"` dim italic.
- **User message** → capped at 10,000 chars, trims to head+tail 2,500
  with "… +N lines …" marker.
- **Compact summary** → hidden outside transcript mode; full in
  transcript.
- **Status line** → rendered by user hook; input carries `cost`,
  `context_window`, `model`, `output_style`, `rate_limits`.
- **Spinner verbs** → random from `constants/spinnerVerbs.ts`; task
  `activeForm` overrides per-task. Tool-specific verb comes from the
  current active task in Claude Code's internal todo list.

## 9. Tool registry (built-in)

From `tools.ts:193-251`:

`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`,
`WebSearch`, `Agent`, `Skill`, `NotebookEdit`, `TaskCreate`, `TaskGet`,
`TaskUpdate`, `TaskList`, `TaskOutput`, `TodoWrite` (legacy),
`EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`, `EnterWorktree`,
`ExitWorktree`, `SendMessage`, `CronCreate`, `CronDelete`, `CronList`,
`RemoteTrigger`, `Monitor`, `Sleep`, `ToolSearch`, `LSP`,
`ListMcpResourcesTool`, `ReadMcpResourceTool`, and MCP tools named
`mcp__<server>__<tool>`.

Each tool has:
- `name`, `inputSchema`, `outputSchema`
- `userFacingName(input)` → display label
- `renderToolUseMessage(input)` → arg preview
- `renderToolResultMessage(result)` → success rendering
- `renderToolUseErrorMessage(result)` → error rendering (fallback available)
- `renderToolUseRejectedMessage(result)` → denial rendering (fallback available)
- `renderToolUseProgressMessage(progress)` → streaming progress (Bash, Agent, WebSearch, etc.)
- `checkPermissions(...)` → `allow` / `ask` / `deny`

## 10. What the semantic channel must carry

For parity with Claude Code's own rendering, the semantic channel in
this package must emit:

1. Turn lifecycle: `turn_started`, `turn_completed`, `source_changed`.
2. Text: `text_delta` with running accumulator + optional markdown twin.
3. Thinking: `thinking_started`, `thinking_delta`, `thinking_signature`,
   `thinking_completed`. Include redacted-thinking placeholders.
4. Tool use: `tool_started`, `tool_input_delta` (partial_json raw +
   best-effort parsed), `tool_input_finalized`, `tool_completed`.
5. Server / MCP tools: same lifecycle with `kind: 'server' | 'mcp'`.
6. Tool result: `tool_result` (from JSONL committed channel or next
   user turn; emitted on semantic channel so the renderer can pair it
   to the previous tool_started by id).
7. Stop: `turn_stopped` with `stop_reason`, `isRefusal`, and whether
   the turn should be treated as an error surface.
8. Usage: `usage_updated` with the merged usage shape.
9. Error: `stream_error` (soft — streaming defensive errors),
   `api_error` (hard — `APIError` surfaced to caller).
10. Diagnostic: `flow_selected` / `flow_ignored` so the consumer can
    observe attribution decisions instead of guessing.

All events carry `source: 'proxy' | 'jsonl' | 'screen'` and
`confidence: 'high' | 'medium' | 'fallback'`.

## 11. Design rules

- No visual state on the semantic channel. Overlays, pickers,
  compaction banners, activity verbs — those stay on the screen
  channel.
- Never assume a single `/v1/messages` flow is the visible turn.
  Attribution is explicit.
- Text blocks can interleave with tool blocks. Preserve block index
  and emit text deltas independently per block; the renderer
  re-assembles ordering.
- `input_json_delta` can produce malformed JSON mid-stream. Emit the
  raw string always; emit a parsed object only when it validates.
- Stop events are authoritative for turn completion. Do not let
  screen-idle heuristics close a live proxy-backed turn.
