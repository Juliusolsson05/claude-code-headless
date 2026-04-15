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


def request(flow: http.HTTPFlow) -> None:
    request = flow.request
    path = request.path or ""
    if request.host.endswith("anthropic.com") and "/v1/messages" in path:
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
