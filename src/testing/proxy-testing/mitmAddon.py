import json
import os
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
# The cap is now diagnostic-only: `body_b64` exists for forensic
# decoding of small bodies (warmup quota check, future small auxiliary
# calls). The sidecar filter consumes `request_shape` instead — a small
# JSON blob extracted from the buffered body INSIDE this addon process
# and emitted regardless of body size. mitmproxy already had the body
# in RAM (`request.content` materialises it on access) so the
# in-process parse costs nothing extra; we just stop wasting bytes by
# re-encoding multi-MB blobs into base64 over IPC.
_REQUEST_BODY_CAP = 256 * 1024


# How many leading characters of each system-prompt text block we ship
# to the adapter. The longest known sidecar fingerprint prefix is ~50
# chars (see SIDECAR_SYSTEM_PROMPT_PREFIXES in ClaudeProxyAdapter.ts);
# 200 leaves comfortable headroom while bounding worst-case event size
# when a request carries many `system` blocks.
_SYSTEM_PREFIX_CHARS = 200


def _extract_request_shape(content: bytes):
    """Parse the addon-buffered request body into the three fields the
    adapter's sidecar predicate actually reads: `max_tokens`,
    `message_count`, `system_prefixes`. Mirrors
    `ClaudeProxyAdapter.parseRequestBody` so the in-addon path and the
    legacy base64 path produce indistinguishable shapes — the adapter
    can't tell which source it received.

    Tolerance rules:
      * non-JSON or non-object body         -> None  (no signal at all)
      * missing/non-numeric max_tokens      -> field is None
      * missing/non-list messages           -> message_count is None
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

    # Mirror the adapter's tolerance for both legacy `system: string`
    # and modern `system: [{type:'text', text:'...'}]` shapes. We
    # collect every text block, not just the first, because Claude
    # Code's `sideQuery` puts the attribution header in slot 0 and the
    # CLI sysprompt in slot 1; the auxiliary fingerprint we care about
    # lives at slot 2+. See ClaudeProxyAdapter.parseRequestBody for the
    # full rationale this addon is duplicating.
    system_prefixes = []
    sys_field = obj.get("system")
    if isinstance(sys_field, str):
        system_prefixes.append(sys_field[:_SYSTEM_PREFIX_CHARS])
    elif isinstance(sys_field, list):
        for block in sys_field:
            if isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str) and text:
                    system_prefixes.append(text[:_SYSTEM_PREFIX_CHARS])

    return {
        "max_tokens": max_tokens,
        "message_count": message_count,
        "system_prefixes": system_prefixes,
    }


def request(flow: http.HTTPFlow) -> None:
    request = flow.request
    path = request.path or ""
    is_messages = (
        request.host.endswith("anthropic.com") and "/v1/messages" in path
    )
    if is_messages:
        request.headers["Accept-Encoding"] = "identity"

    payload = {
        "kind": "request",
        "flow_id": id(flow),
        "method": request.method,
        "url": request.pretty_url,
        "host": request.host,
        "path": request.path,
        "headers": dict(request.headers),
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
