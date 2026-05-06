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


# Cap at 256 KiB so an oversized body (e.g. an attachment-heavy turn)
# can never wedge the JSONL writer or balloon the in-memory event
# buffer. 256 KiB is generous: a maxed-out title-gen request — the only
# consumer of this field — is well under 4 KiB, and a normal turn
# request is bounded by Claude Code's own context budget. Larger
# requests still emit a `request` event, just without `body_b64`, so
# the adapter falls back to its model-name heuristic.
_REQUEST_BODY_CAP = 256 * 1024


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

    # Body capture is gated on /v1/messages because:
    #   * the adapter only consumes it for sidecar detection on those
    #     flows, so emitting it for unrelated traffic (auth, MCP
    #     registry, telemetry) is pure noise on the wire to the renderer
    #     and a leak risk for any non-Anthropic host the user proxies;
    #   * `request.content` materialises the buffered body, which we
    #     don't want to do for every flow on every host.
    if is_messages:
        try:
            content = request.content or b""
            if 0 < len(content) <= _REQUEST_BODY_CAP:
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
