#!/usr/bin/env python3
"""Validate the six operator-side subscription lane documents."""

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Any

MAX_RESPONSE_BYTES = 1_048_576
DEFAULT_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class LaneSpec:
    document: str
    free: bool
    governing_windows: dict[str, tuple[str, str]]


LANES = (
    LaneSpec("claude.json", False, {"seven_day": ("seven_day_utilization", "seven_day_resets_at")}),
    LaneSpec("codex.json", False, {"weekly": ("weekly_utilization", "weekly_resets_at")}),
    LaneSpec("zai.json", False, {"weekly": ("weekly_utilization", "weekly_resets_at")}),
    LaneSpec("kimi.json", False, {"weekly": ("weekly_utilization", "weekly_resets_at")}),
    LaneSpec(
        "opencode-go.json",
        False,
        {
            "weekly": ("weekly_utilization", "weekly_resets_at"),
            "monthly": ("monthly_utilization", "monthly_resets_at"),
        },
    ),
    LaneSpec("zen-free.json", True, {}),
)


class ValidationError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


def valid_number(value: Any, *, positive: bool = False) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and (value > 0 if positive else True)
    )


def valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def window_seconds(record: dict[str, Any], governing: str) -> Any:
    value = record.get("window_seconds")
    if isinstance(value, dict):
        return value.get(governing, value.get(governing.replace("-", "_")))
    return value


def validate_document(spec: LaneSpec, document: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(document, dict):
        return [f"{spec.document}: document must be a JSON object"]
    if not valid_timestamp(document.get("observedAt")):
        errors.append(f"{spec.document}: observedAt must be an ISO timestamp")
    records = document.get("records")
    if not isinstance(records, list) or not records:
        errors.append(f"{spec.document}: records must be a non-empty array")
        return errors

    for index, value in enumerate(records, 1):
        prefix = f"{spec.document} record-{index}"
        if not isinstance(value, dict):
            errors.append(f"{prefix}: record must be an object")
            continue
        if not valid_number(value.get("weight"), positive=True):
            errors.append(f"{prefix}: weight must be a positive finite number")
        governing = value.get("governing_window")
        if spec.free:
            if governing is not None:
                errors.append(f"{prefix}: free lane governing_window must be null")
            continue
        if not isinstance(governing, str) or governing not in spec.governing_windows:
            expected = ", ".join(sorted(spec.governing_windows))
            errors.append(f"{prefix}: governing_window must be one of {expected}")
            continue
        duration = window_seconds(value, governing)
        if not valid_number(duration, positive=True):
            errors.append(f"{prefix}: window_seconds must include a positive {governing} duration")
        utilization_field, reset_field = spec.governing_windows[governing]
        utilization = value.get(utilization_field)
        if not valid_number(utilization) or utilization < 0 or utilization > 1:
            errors.append(f"{prefix}: {utilization_field} must be a finite fraction from 0 through 1")
        reset = value.get(reset_field)
        if not valid_timestamp(reset):
            errors.append(f"{prefix}: {reset_field} must be a non-null ISO timestamp")
    return errors


def load_directory(directory: pathlib.Path, spec: LaneSpec) -> Any:
    path = directory / spec.document
    if not path.is_file():
        raise ValidationError(f"{spec.document}: required document is missing")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"{spec.document}: unreadable or malformed JSON ({type(error).__name__})") from error


def load_http(base_url: str, api_key: str, spec: LaneSpec, timeout: float) -> Any:
    url = f"{base_url.rstrip('/')}/{spec.document}"
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "Accept-Encoding": "identity", "X-Api-Key": api_key},
        method="GET",
    )
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            status = response.status
            content_type = response.headers.get_content_type()
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise ValidationError(f"{spec.document}: HTTP {error.code}") from error
    except (OSError, urllib.error.URLError) as error:
        raise ValidationError(f"{spec.document}: request failed ({type(error).__name__})") from error
    if status < 200 or status >= 300:
        raise ValidationError(f"{spec.document}: HTTP {status}")
    if content_type != "application/json" and not content_type.endswith("+json"):
        raise ValidationError(f"{spec.document}: response is not JSON")
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValidationError(f"{spec.document}: response exceeds {MAX_RESPONSE_BYTES} bytes")
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise ValidationError(f"{spec.document}: malformed JSON") from error


def run(args: argparse.Namespace) -> int:
    api_key = None
    if args.base_url:
        api_key = os.environ.get(args.api_key_env)
        if not api_key:
            print(f"FAIL: environment variable {args.api_key_env} is unset", file=sys.stderr)
            return 2

    errors: list[str] = []
    for spec in LANES:
        try:
            document = (
                load_directory(pathlib.Path(args.directory), spec)
                if args.directory
                else load_http(args.base_url, api_key, spec, args.timeout)
            )
        except ValidationError as error:
            errors.append(str(error))
            continue
        errors.extend(validate_document(spec, document))

    if errors:
        print(f"FAIL: {len(errors)} lane document violation(s)", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"PASS: validated {len(LANES)} required lane documents")
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    source = result.add_mutually_exclusive_group(required=True)
    source.add_argument("--dir", dest="directory")
    source.add_argument("--base-url")
    result.add_argument("--api-key-env", default="CLIPROXY_USAGE_LANE_KEY")
    result.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    return result


if __name__ == "__main__":
    raise SystemExit(run(parser().parse_args()))
