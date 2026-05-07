import json
import os
import re
import base64
from mitmproxy import http


OUT_PATH = os.environ.get("PROXY_EVENTS_FILE")


def _write(payload):
    if not OUT_PATH:
        return
    with open(OUT_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload) + "\n")


# Cap on the raw `body_b64` payload emitted to the adapter.
#
# Originally 256 KiB, sized for a maxed-out title-gen body (~4 KiB).
# Real Claude Code turns blew straight past it — production debug
# bundles show steady-state /v1/messages bodies of 700 KB to 1+ MB
# because every request includes the full conversation history.
# Result: the adapter's `requestShape` was null on ~99% of flows and
# the c8c2623 sidecar predicate ran blind. See debug bundle
# `2026-05-07T08-26-35-212-5d948ab5` (Content-Length 681862-1033291 on
# every Claude Code turn; only the 323-byte warmup quota check fit).
#
# Raised to 2 MiB so forensic tooling (debug bundles, ad-hoc decode)
# can recover the actual prompt text from a real turn — the previous
# 256 KiB cap silently lost the prompt for every conversation past the
# first few turns. 2 MiB covers every body we have observed in
# production and is small enough that an oversized attachment-heavy
# turn still falls back to the request_shape path without wedging
# the JSONL writer. The sidecar filter doesn't depend on body_b64
# anymore — it reads `request_shape` directly — so the cap is purely
# about diagnostic decode reach.
_REQUEST_BODY_CAP = 2 * 1024 * 1024


# How many leading characters of each system-prompt text block we ship
# to the adapter. The longest known sidecar fingerprint prefix is ~50
# chars (see SIDECAR_SYSTEM_PROMPT_PREFIXES in ClaudeProxyAdapter.ts);
# 200 leaves comfortable headroom while bounding worst-case event size
# when a request carries many `system` blocks.
_SYSTEM_PREFIX_CHARS = 200


# Headers we forward verbatim. Anything not on this list is silently
# dropped before the event lands in proxy-events.jsonl.
#
# WHY allowlist instead of denylist:
#   * Defense-in-depth on Authorization. mitmproxy decrypts the
#     bearer token and we never want it on disk. An allowlist makes
#     "we forgot to redact" structurally impossible — Authorization
#     is simply not in the list.
#   * The Anthropic SDK can attach custom headers via
#     ANTHROPIC_CUSTOM_HEADERS; user-set values can carry secrets we
#     don't want in bundles either.
#   * Future-proof against new identifying headers Claude Code adds:
#     dropping unknown headers means we don't accidentally leak a
#     header that was added between our allowlist update and our
#     review. If we miss a useful one, "no record" is a safer default
#     than "every header on disk by default."
#
# Headers chosen by reading the source of truth in
# `vendor/claude-code-src/full/services/api/client.ts` (defaultHeaders
# block) plus the few transport-level headers that help correlate
# requests in a packet capture.
_HEADER_ALLOWLIST = frozenset({
    "x-app",
    "user-agent",
    "x-claude-code-session-id",
    "x-claude-remote-container-id",
    "x-claude-remote-session-id",
    "x-client-app",
    "x-client-request-id",
    "anthropic-beta",
    "anthropic-version",
    "x-anthropic-additional-protection",
    "content-length",
    "content-type",
})


# Regex for extracting `cc_entrypoint=value` out of the Claude Code
# attribution-header text block. The block always lives in
# `system[0].text` (see vendor/claude-code-src/full/utils/sideQuery.ts
# line 148-167); this regex pulls just the entrypoint slug so
# downstream tooling can correlate calls back to their parent context
# (cli vs sdk-cli vs mcp vs claude-code-github-action) without having
# to re-parse the whole header string.
_CC_ENTRYPOINT_RE = re.compile(r"cc_entrypoint=([^;]+);")


def _filter_headers(raw):
    """Filter mitmproxy's request.headers down to the allowlist.

    Returns a plain dict of lowercase-keyed headers. Header names are
    normalised to lowercase because mitmproxy preserves the wire
    casing (User-Agent vs user-agent etc.) and downstream consumers
    shouldn't have to care.
    """
    out = {}
    for key, value in raw.items():
        lower = key.lower()
        if lower in _HEADER_ALLOWLIST:
            out[lower] = value
    return out


def _messages_total_chars(messages):
    """Sum of all text content across a Claude /v1/messages messages
    array. Each message's `content` is either a string or an array of
    typed blocks; we add up text blocks and conservatively count each
    non-text block as 0 (we're not using this for billing, just for
    discriminating sidecar shape — a tool_result block's bytes don't
    move the sidecar/real-turn line).
    """
    total = 0
    if not isinstance(messages, list):
        return 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, str):
            total += len(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    text = block.get("text")
                    if isinstance(text, str):
                        total += len(text)
    return total


def _system_total_chars(sys_field):
    """Sum of text length across all system blocks. String form
    counts the string's length; array form sums every text block's
    length. Used as one of the discriminators between sidecar
    (small, single-task system) and real turn (large CLI sysprompt
    + tool descriptions + workspace context)."""
    if isinstance(sys_field, str):
        return len(sys_field)
    if not isinstance(sys_field, list):
        return 0
    total = 0
    for block in sys_field:
        if isinstance(block, dict):
            text = block.get("text")
            if isinstance(text, str):
                total += len(text)
    return total


def _extract_request_shape(content: bytes):
    """Parse the addon-buffered request body into the fields the
    adapter's sidecar predicate reads PLUS forensic discriminators
    we identified by reverse-engineering Claude Code's HTTP layer
    (vendor/claude-code-src/full/services/api/client.ts and
    utils/sideQuery.ts).

    Predicate-relevant fields (consumed by ClaudeProxyAdapter
    `isSidecarFlow`):
      * max_tokens, message_count, system_prefixes — original three.

    Forensic / future-predicate fields:
      * tools_count             — real Claude Code turns ALWAYS ship
                                  the tools array (Bash, Edit, Read,
                                  …); sidecars routed through
                                  sideQuery / queryHaiku ship tools=[].
                                  Strongest single signal we don't
                                  yet use.
      * system_blocks_count     — real turns have many system blocks
                                  (attribution, CLI sysprompt,
                                  tools/workspace context). Sidecars
                                  carry 2-3.
      * system_total_chars      — real turns measure in 10s of KB,
                                  sidecars in <5 KB.
      * messages_total_chars    — defence-in-depth against a sidecar
                                  variant that ships the full
                                  conversation (predict-next-prompt
                                  feature) by giving downstream
                                  tooling another magnitude check.
      * attribution_entrypoint  — extracted from the
                                  `cc_entrypoint=…` field embedded in
                                  system[0].text (the attribution
                                  header). Identifies parent context:
                                  cli / sdk-cli / mcp /
                                  claude-code-github-action /
                                  local-agent. Doesn't discriminate
                                  call type but is invaluable for
                                  correlating bundle traffic to the
                                  parent process.

    Tolerance rules (carried forward from the original):
      * non-JSON or non-object body         -> None  (no signal at all)
      * missing/non-numeric max_tokens      -> field is None
      * missing/non-list messages           -> count fields are None
      * `system` as string OR array of {type:'text', text:str}
        blocks                              -> collect text prefixes,
                                                cap each at
                                                _SYSTEM_PREFIX_CHARS
      * any other shape for `system`         -> empty list

    Returning None signals "no usable data" (older addons emitted no
    field at all); the adapter's fallback path then tries body_b64.
    Returning a populated dict, even with all fields null, signals
    "this addon DID parse the body and found nothing predictive" — the
    sidecar predicate's null guards still work but the body_b64 path
    is correctly skipped (we already saw the bytes; re-decoding them
    won't reveal more).
    """
    try:
        obj = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None

    raw_max = obj.get("max_tokens")
    max_tokens = raw_max if isinstance(raw_max, (int, float)) and not isinstance(raw_max, bool) else None

    messages = obj.get("messages")
    message_count = len(messages) if isinstance(messages, list) else None
    messages_total_chars = _messages_total_chars(messages)

    # Mirror the adapter's tolerance for both legacy `system: string`
    # and modern `system: [{type:'text', text:'...'}]` shapes. We
    # collect every text block, not just the first, because Claude
    # Code's `sideQuery` puts the attribution header in slot 0 and the
    # CLI sysprompt in slot 1; the auxiliary fingerprint we care about
    # lives at slot 2+. See ClaudeProxyAdapter.parseRequestBody for the
    # full rationale this addon is duplicating.
    sys_field = obj.get("system")
    system_prefixes = []
    if isinstance(sys_field, str):
        system_prefixes.append(sys_field[:_SYSTEM_PREFIX_CHARS])
        system_blocks_count = 1
    elif isinstance(sys_field, list):
        for block in sys_field:
            if isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str) and text:
                    system_prefixes.append(text[:_SYSTEM_PREFIX_CHARS])
        system_blocks_count = len(sys_field)
    else:
        system_blocks_count = 0
    system_total_chars = _system_total_chars(sys_field)

    # tools is an array on every real Claude Code call. Sidecars omit
    # it or pass []. None signals "field absent in body" — distinct
    # from 0 which signals "explicit empty array, very likely sidecar".
    tools = obj.get("tools")
    tools_count = len(tools) if isinstance(tools, list) else None

    # Pull cc_entrypoint out of the attribution header. This always
    # lives in system[0] (see sideQuery.ts:148-167 in vendored Claude
    # Code source). Look at the first prefix we collected; if no
    # match, leave None.
    attribution_entrypoint = None
    if system_prefixes:
        match = _CC_ENTRYPOINT_RE.search(system_prefixes[0])
        if match:
            attribution_entrypoint = match.group(1).strip()

    return {
        "max_tokens": max_tokens,
        "message_count": message_count,
        "system_prefixes": system_prefixes,
        "tools_count": tools_count,
        "system_blocks_count": system_blocks_count,
        "system_total_chars": system_total_chars,
        "messages_total_chars": messages_total_chars,
        "attribution_entrypoint": attribution_entrypoint,
    }


def request(flow: http.HTTPFlow) -> None:
    request = flow.request
    path = request.path or ""
    is_messages = (
        request.host.endswith("anthropic.com") and "/v1/messages" in path
    )
    if is_messages:
        request.headers["Accept-Encoding"] = "identity"

    # Headers are filtered to an allowlist (see _filter_headers). The
    # previous unfiltered `dict(request.headers)` exfiltrated bearer
    # tokens, ANTHROPIC_CUSTOM_HEADERS-injected secrets, and any future
    # identifying header Claude Code might add — none of which belong
    # in a debug bundle the user can share. Allowlist makes the leak
    # surface structurally bounded.
    payload = {
        "kind": "request",
        "flow_id": id(flow),
        "method": request.method,
        "url": request.pretty_url,
        "host": request.host,
        "path": request.path,
        "headers": _filter_headers(request.headers),
    }

    # Body inspection is gated on /v1/messages because:
    #   * the adapter only consumes it for sidecar detection on those
    #     flows, so emitting it for unrelated traffic (auth, MCP
    #     registry, telemetry) is pure noise on the wire to the renderer
    #     and a leak risk for any non-Anthropic host the user proxies;
    #   * `request.content` materialises the buffered body, which we
    #     don't want to do for every flow on every host.
    if is_messages:
        try:
            content = request.content or b""
            if content:
                # request_shape is small (a few hundred bytes regardless
                # of body size) and is the canonical sidecar-predicate
                # input. Always emit when we successfully parse the
                # body — irrespective of _REQUEST_BODY_CAP, which
                # historically dropped every Claude Code turn and
                # silently disabled c8c2623's body-shape filter.
                shape = _extract_request_shape(content)
                if shape is not None:
                    payload["request_shape"] = shape
                # body_b64 stays size-gated. Kept for forensic decoding
                # of small auxiliary bodies (warmup quota check, future
                # small calls) and as a transitional fallback for
                # adapters that haven't been updated to read
                # request_shape yet. Past the cap we drop silently —
                # request_shape already covers the predicate's needs.
                if len(content) <= _REQUEST_BODY_CAP:
                    payload["body_b64"] = base64.b64encode(content).decode("ascii")
        except Exception as exc:
            payload["body_error"] = str(exc)

    _write(payload)


def responseheaders(flow: http.HTTPFlow) -> None:
    request = flow.request
    path = request.path or ""
    content_type = flow.response.headers.get("content-type", "")

    if request.host.endswith("anthropic.com") and "/v1/messages" in path and "text/event-stream" in content_type:
        flow.response.stream = _make_stream_tap(flow)


def _make_stream_tap(flow: http.HTTPFlow):
    request = flow.request

    def tap(chunk: bytes):
        if chunk:
            _write(
                {
                    "kind": "response-chunk",
                    "flow_id": id(flow),
                    "method": request.method,
                    "url": request.pretty_url,
                    "host": request.host,
                    "path": request.path,
                    "chunk_b64": base64.b64encode(chunk).decode("ascii"),
                }
            )
        else:
            _write(
                {
                    "kind": "response-end",
                    "flow_id": id(flow),
                    "method": request.method,
                    "url": request.pretty_url,
                    "host": request.host,
                    "path": request.path,
                }
            )
        return chunk

    return tap


def response(flow: http.HTTPFlow) -> None:
    request = flow.request
    response = flow.response
    content_type = response.headers.get("content-type", "")

    payload = {
        "kind": "response",
        "flow_id": id(flow),
        "method": request.method,
        "url": request.pretty_url,
        "host": request.host,
        "path": request.path,
        "status_code": response.status_code,
        "headers": dict(response.headers),
    }

    # We do NOT emit the SSE body here anymore.
    #
    # Why: the `response-chunk` stream tap configured in
    # `responseheaders()` is the authoritative live-streaming protocol.
    # Emitting the full buffered body on the completion hook created a
    # duplicate parallel path — consumers that subscribed to both
    # `response-chunk` and `response.body` would render a turn twice
    # (once live, once as a replayed blob), and consumers that only
    # subscribed to `response` would never see the live stream at all.
    # Two sources of truth for the same flow meant neither was
    # trustworthy. Chunks win; the buffered body is dropped.
    #
    # For NON-streaming responses on anthropic.com (e.g. a buffered
    # error body before SSE starts, or a non-stream /v1/messages reply
    # when the client didn't set stream=true) we still emit a short
    # preview so run.ts / diagnostics can inspect failure bodies
    # without decrypting traffic manually.
    if "text/event-stream" not in content_type and request.host.endswith(
        "anthropic.com"
    ):
        try:
            payload["body_preview"] = response.get_text(strict=False)[:4000]
        except Exception as exc:
            payload["body_error"] = str(exc)

    _write(payload)
