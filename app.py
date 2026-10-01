#!/usr/bin/env python3
"""A read-only, loopback-only local comic reader server."""

from __future__ import annotations

import json
import csv
import mimetypes
import os
import re
import socket
import sys
import threading
import urllib.parse
import webbrowser
from decimal import Decimal, InvalidOperation
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent
MANGA_ROOT = (PROJECT_ROOT.parent / "漫画").resolve()
STATIC_ROOT = (PROJECT_ROOT / "static").resolve()
ORDER_MANIFEST = (PROJECT_ROOT / "data" / "library_order.tsv").resolve()
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
APPENDIX_MARKERS = ("非剧情", "上架感言", "周日更新", "外出取材", "更新延迟", "本周休刊", "通知")
SERIES_ORDER_HINTS = ("史上最强", "败者为寇", "我独自升级")
EXPLICIT_CHAPTER_RE = re.compile(r"第(\d{1,4}(?:\.\d+)?)话")
EXPLICIT_ORDER_RE = re.compile(r"^(?P<prefix>[SA])(?P<number>\d{4}(?:\.\d+)?)_")
ORDER_TYPE_RE = re.compile(r"^[SA]\d{4}(?:\.\d+)?_(?P<kind>序章|正篇|特别篇|附录)_")
ORDER_KIND_MAP = {"prologue": "prologue", "main": "main", "special": "special", "appendix": "appendix"}

_cache_lock = threading.Lock()
_library_cache: dict[str, Any] | None = None
_library_signature: tuple[Any, ...] | None = None


def parse_order_key(value: str) -> tuple[str, Decimal] | None:
    match = re.fullmatch(r"([SA])(\d{4}(?:\.\d+)?)", value.strip())
    if not match:
        return None
    try:
        return match.group(1), Decimal(match.group(2))
    except InvalidOperation:
        return None


def format_order_key(prefix: str, value: Decimal) -> str:
    """Format an explicit key with four integer digits and exact decimals."""
    if value == value.to_integral():
        return f"{prefix}{int(value):04d}"
    text = format(value, "f").rstrip("0").rstrip(".")
    whole, _, fraction = text.partition(".")
    return f"{prefix}{int(whole):04d}.{fraction}"


def order_from_folder(series_name: str, folder_name: str) -> tuple[str, Decimal, str] | None:
    rest = chapter_rest(series_name, folder_name)
    match = EXPLICIT_ORDER_RE.match(rest)
    if not match:
        return None
    try:
        return match.group("prefix"), Decimal(match.group("number")), "folder_prefix"
    except InvalidOperation:
        return None


def kind_from_order_folder(series_name: str, folder_name: str, prefix: str) -> str:
    if prefix == "A":
        return "appendix"
    rest = chapter_rest(series_name, folder_name)
    match = ORDER_TYPE_RE.match(rest)
    if match:
        return {"序章": "prologue", "正篇": "main", "特别篇": "special", "附录": "appendix"}[match.group("kind")]
    return group_kind(folder_name)


def clean_ordered_title(series_name: str, folder_name: str) -> str:
    rest = chapter_rest(series_name, folder_name)
    match = EXPLICIT_ORDER_RE.match(rest)
    if match:
        rest = rest[match.end():]
        rest = re.sub(r"^(?:序章|正篇|特别篇|附录)_", "", rest, count=1)
    return rest.replace("_", " · ").strip(" ·")


def load_order_manifest() -> tuple[dict[tuple[str, str], dict[str, str]], list[str]]:
    rows: dict[tuple[str, str], dict[str, str]] = {}
    warnings: list[str] = []
    if not ORDER_MANIFEST.is_file():
        return rows, warnings
    try:
        with ORDER_MANIFEST.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            required = {"series", "order_key", "kind", "folder", "title", "note"}
            if not reader.fieldnames or not required.issubset(reader.fieldnames):
                return {}, ["顺序清单缺少必要字段"]
            seen_keys: set[tuple[str, str, str]] = set()
            for line_number, row in enumerate(reader, 2):
                series = (row.get("series") or "").strip()
                folder = (row.get("folder") or "").strip()
                order_key = (row.get("order_key") or "").strip()
                kind = (row.get("kind") or "").strip()
                parsed = parse_order_key(order_key)
                if not series or not folder or parsed is None or kind not in ORDER_KIND_MAP:
                    warnings.append(f"顺序清单第{line_number}行格式无效")
                    continue
                prefix, _ = parsed
                group = "appendix" if kind == "appendix" or prefix == "A" else "story"
                key = (series, group, order_key)
                if key in seen_keys:
                    warnings.append(f"顺序清单重复序号：{series} {order_key}")
                seen_keys.add(key)
                rows[(series, folder)] = row
    except OSError as exc:
        warnings.append(f"无法读取顺序清单：{exc}")
    return rows, warnings


def natural_key(value: str) -> list[Any]:
    """Sort text naturally, including decimal and Chinese-containing names."""
    parts = re.split(r"(\d+(?:\.\d+)?)", value.casefold())
    result: list[Any] = []
    for part in parts:
        if not part:
            continue
        if re.fullmatch(r"\d+(?:\.\d+)?", part):
            result.append((0, float(part), len(part)))
        else:
            result.append((1, part))
    return result


def is_safe_regular_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink() and path.suffix.casefold() in ALLOWED_EXTENSIONS


def direct_images(chapter_dir: Path) -> list[Path]:
    if chapter_dir.is_symlink() or not chapter_dir.is_dir():
        return []
    images = [
        child
        for child in chapter_dir.iterdir()
        if is_safe_regular_file(child)
    ]
    return sorted(images, key=lambda path: natural_key(path.name))


def root_contained(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def extract_number(name: str) -> float | None:
    match = re.search(r"(?<!\d)(\d{1,4}(?:\.\d+)?)", name)
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def number_text(name: str) -> str | None:
    match = re.search(r"(?<!\d)(\d{1,4}(?:\.\d+)?)", name)
    return match.group(1) if match else None


def chapter_rest(series_name: str, folder_name: str) -> str:
    """Return the chapter portion without the series name or archive suffix."""
    rest = folder_name[len(series_name) + 1 :] if folder_name.startswith(series_name + "_") else folder_name
    return re.sub(r"_原始(?:JPEG|WebP)$", "", rest, flags=re.IGNORECASE)


def without_archive_index(rest: str) -> str:
    """Drop a legacy archive index such as ``494_`` before parsing the title."""
    return re.sub(r"^\d{1,4}(?:\.\d+)?_", "", rest, count=1)


def volume_parts(rest: str) -> tuple[str, str, str] | None:
    """Parse volume-local names such as ``卷四01_众生之难`` or ``第三卷 01 两年后``."""
    body = without_archive_index(rest)
    match = re.match(
        r"^(?P<label>第[一二三四五六七八九十百千万]+卷|卷[一二三四五六七八九十百千万]+)"
        r"[^0-9_]*(?P<local>\d{1,4})(?:[_\s]*(?P<title>.*))?$",
        body,
    )
    if not match:
        return None
    return match.group("label"), match.group("local"), (match.group("title") or "").strip()


def chinese_number(value: str) -> int | None:
    """Convert the small Chinese numerals used in volume labels to integers."""
    digits = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    if value.isdigit():
        return int(value)
    if value == "十":
        return 10
    if value.startswith("十"):
        return 10 + digits.get(value[1:], 0)
    if value.endswith("十"):
        return digits.get(value[:-1], 0) * 10
    if "十" in value:
        left, right = value.split("十", 1)
        return digits.get(left, 0) * 10 + digits.get(right, 0)
    return digits.get(value)


def volume_number(label: str) -> int | None:
    value = label[1:-1] if label.startswith("第") else label[1:]
    return chinese_number(value)


def is_appendix(name: str) -> bool:
    return any(marker in name for marker in APPENDIX_MARKERS) or "999_" in name


def group_kind(name: str) -> str:
    if is_appendix(name):
        return "appendix"
    if "特别篇" in name or "番外" in name or "外传" in name:
        return "special"
    return "main"


def display_title(series_name: str, folder_name: str, kind: str) -> tuple[str, str | None]:
    """Return a compact UI title and the raw numeric chapter token."""
    rest = chapter_rest(series_name, folder_name)
    body = without_archive_index(rest)
    explicit = EXPLICIT_CHAPTER_RE.search(body)
    if explicit:
        raw_number = explicit.group(1)
        title_body = re.sub(r"^第\d{1,4}(?:\.\d+)?话[_\s]*", "", body, count=1).strip()
        return f"第{raw_number}话 · {title_body or body}", raw_number

    volume = volume_parts(rest)
    if volume:
        label, local, title_body = volume
        return f"{label}{local} · {title_body or body}".rstrip(" ·"), None

    raw_number = number_text(rest)
    if kind == "appendix":
        return rest.replace("_", " · "), raw_number
    if rest.startswith("序章"):
        return rest.replace("_", " · "), raw_number
    if kind == "special" and rest.startswith("特别篇"):
        return rest.replace("_", " · "), raw_number
    if raw_number is not None:
        remainder = re.sub(r"^\d{1,4}(?:\.\d+)?_", "", rest, count=1)
        return f"第{raw_number}话 · {remainder or rest}", raw_number
    match = re.match(r"^(第\d+(?:\.\d+)?话)[_]?(.*)$", rest)
    if match:
        return f"{match.group(1)} · {match.group(2)}".rstrip(" ·"), raw_number
    return rest.replace("_", " · "), raw_number


def chapter_sort_key(entry: dict[str, Any]) -> tuple[Any, ...]:
    rest = chapter_rest(entry["series"], entry["folder"])
    body = without_archive_index(rest)
    explicit = EXPLICIT_CHAPTER_RE.search(body)
    if explicit:
        order: tuple[Any, ...] = (0, float(explicit.group(1)))
    else:
        volume = volume_parts(rest)
        if volume:
            label, local, _ = volume
            order = (1, volume_number(label) or float("inf"), float(local))
        else:
            raw = number_text(rest)
            order = (0, float(raw) if raw is not None else float("inf"))
    folder = entry["folder"]
    if entry["kind"] == "main":
        return (0, *order, natural_key(folder))
    if entry["kind"] == "special":
        return (1, *order, natural_key(folder))
    return (2, *order, natural_key(folder))


def directory_signature() -> tuple[Any, ...]:
    if not MANGA_ROOT.exists() or not MANGA_ROOT.is_dir():
        return ("missing",)
    values: list[Any] = [MANGA_ROOT.stat().st_mtime_ns]
    if ORDER_MANIFEST.exists():
        try:
            values.append(("order-manifest", ORDER_MANIFEST.stat().st_mtime_ns, ORDER_MANIFEST.stat().st_size))
        except OSError:
            values.append(("order-manifest", "unreadable"))
    else:
        values.append(("order-manifest", "missing"))
    for child in sorted(MANGA_ROOT.iterdir(), key=lambda item: item.name.casefold()):
        if child.is_dir() and not child.is_symlink():
            try:
                values.append((child.name, child.stat().st_mtime_ns))
            except OSError:
                continue
    return tuple(values)


def scan_library() -> dict[str, Any]:
    global _library_cache, _library_signature
    signature = directory_signature()
    with _cache_lock:
        if _library_cache is not None and signature == _library_signature:
            return _library_cache

        manifest, manifest_warnings = load_order_manifest()
        grouped: dict[str, list[dict[str, Any]]] = {}
        unindexed: dict[str, list[dict[str, Any]]] = {}
        if MANGA_ROOT.exists() and MANGA_ROOT.is_dir():
            for chapter_dir in MANGA_ROOT.iterdir():
                if not chapter_dir.is_dir() or chapter_dir.is_symlink() or chapter_dir.name.startswith("."):
                    continue
                images = direct_images(chapter_dir)
                if not images:
                    continue
                series_name = chapter_dir.name.split("_", 1)[0]
                manifest_row = manifest.get((series_name, chapter_dir.name))
                folder_order = order_from_folder(series_name, chapter_dir.name)
                order_key: str | None = None
                order_value: Decimal | None = None
                order_source = "unindexed"
                if folder_order is not None:
                    prefix, order_value, order_source = folder_order
                    order_key = format_order_key(prefix, order_value)
                if manifest_row is not None:
                    manifest_order = parse_order_key(manifest_row["order_key"])
                    if manifest_order is not None:
                        if folder_order is not None and manifest_row["order_key"] != order_key:
                            manifest_warnings.append(f"目录序号与清单冲突：{series_name}/{chapter_dir.name}")
                        elif folder_order is None:
                            prefix, order_value = manifest_order
                            order_key = manifest_row["order_key"]
                            order_source = "manifest"
                        if folder_order is None:
                            order_key = manifest_row["order_key"]
                            order_value = manifest_order[1]
                    kind = manifest_row["kind"]
                    label = manifest_row["title"] or display_title(series_name, chapter_dir.name, kind)[0]
                    raw_number = display_title(series_name, chapter_dir.name, kind)[1]
                elif folder_order is not None:
                    kind = kind_from_order_folder(series_name, chapter_dir.name, folder_order[0])
                    label, raw_number = display_title(series_name, chapter_dir.name, kind)
                    if folder_order is not None:
                        label = clean_ordered_title(series_name, chapter_dir.name)
                else:
                    kind = "unindexed"
                    label, raw_number = display_title(series_name, chapter_dir.name, group_kind(chapter_dir.name))

                entry = {
                    "id": chapter_dir.name,
                    "folder": chapter_dir.name,
                    "series": series_name,
                    "kind": kind,
                    "title": label,
                    "number": raw_number,
                    "images": len(images),
                    "orderKey": order_key,
                    "orderSource": order_source,
                }
                if order_key is None:
                    unindexed.setdefault(series_name, []).append(entry)
                else:
                    grouped.setdefault(series_name, []).append(entry)

        series_names = sorted(
            set(grouped) | set(unindexed),
            key=lambda name: (
                SERIES_ORDER_HINTS.index(name) if name in SERIES_ORDER_HINTS else len(SERIES_ORDER_HINTS),
                natural_key(name),
            ),
        )
        series: list[dict[str, Any]] = []
        for series_name in series_names:
            chapters = grouped.get(series_name, [])
            indexed_story = [item for item in chapters if item["kind"] != "appendix"]
            appendix = [item for item in chapters if item["kind"] == "appendix"]
            indexed_story.sort(key=lambda item: (Decimal(item["orderKey"][1:]), natural_key(item["folder"])))
            appendix.sort(key=lambda item: (Decimal(item["orderKey"][1:]), natural_key(item["folder"])))
            pending = sorted(unindexed.get(series_name, []), key=lambda item: natural_key(item["folder"]))
            series.append(
                {
                    "name": series_name,
                    "chapters": indexed_story,
                    "appendix": appendix,
                    "unindexed": pending,
                    "totalImages": sum(item["images"] for item in chapters) + sum(item["images"] for item in pending),
                }
            )
        _library_cache = {"series": series, "warnings": manifest_warnings}
        _library_signature = signature
        return _library_cache


def find_chapter(chapter_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    library = scan_library()
    for series in library["series"]:
        for item in series["chapters"] + series["appendix"] + series["unindexed"]:
            if item["id"] == chapter_id:
                return series, item
    return None


def chapter_response(chapter_id: str) -> dict[str, Any] | None:
    found = find_chapter(chapter_id)
    if found is None:
        return None
    series, item = found
    chapter_dir = MANGA_ROOT / item["folder"]
    images = direct_images(chapter_dir)
    payload = []
    for index, image in enumerate(images):
        relative = image.relative_to(MANGA_ROOT).as_posix()
        payload.append(
            {
                "name": image.name,
                "page": index + 1,
                "url": "/media/" + urllib.parse.quote(relative, safe=""),
            }
        )
    return {
        "id": item["id"],
        "series": series["name"],
        "title": item["title"],
        "kind": item["kind"],
        "images": payload,
    }


def validate_order_manifest() -> tuple[list[str], list[str]]:
    """Validate the explicit-order layer without changing any files."""
    errors: list[str] = []
    warnings: list[str] = []
    rows, load_warnings = load_order_manifest()
    warnings.extend(load_warnings)
    seen_folders: set[tuple[str, str]] = set()
    actual: set[tuple[str, str]] = set()
    order_keys: set[tuple[str, str, str]] = set()

    if not ORDER_MANIFEST.is_file():
        errors.append(f"缺少顺序清单：{ORDER_MANIFEST}")

    for series_name in sorted({
        child.name.split("_", 1)[0]
        for child in MANGA_ROOT.iterdir()
        if child.is_dir() and not child.is_symlink() and not child.name.startswith(".") and direct_images(child)
    }):
        for chapter_dir in sorted(MANGA_ROOT.iterdir(), key=lambda item: item.name.casefold()):
            if not chapter_dir.is_dir() or chapter_dir.is_symlink() or chapter_dir.name.startswith("."):
                continue
            if chapter_dir.name.split("_", 1)[0] != series_name or not direct_images(chapter_dir):
                continue
            key = (series_name, chapter_dir.name)
            actual.add(key)
            row = rows.get(key)
            folder_order = order_from_folder(series_name, chapter_dir.name)
            if row is None and folder_order is None:
                errors.append(f"目录未编序：{series_name}/{chapter_dir.name}")
                continue
            if row is not None:
                parsed = parse_order_key(row["order_key"])
                if parsed is None:
                    errors.append(f"顺序键无效：{series_name}/{chapter_dir.name}")
                    continue
                group = "appendix" if row["kind"] == "appendix" or parsed[0] == "A" else "story"
                duplicate_key = (series_name, group, row["order_key"])
                if duplicate_key in order_keys:
                    errors.append(f"顺序键重复：{series_name}/{row['order_key']}")
                order_keys.add(duplicate_key)
                seen_folders.add(key)
                if folder_order is not None:
                    folder_order_key = format_order_key(folder_order[0], folder_order[1])
                    if row["order_key"] != folder_order_key:
                        warnings.append(f"目录前缀与清单不同：{series_name}/{chapter_dir.name}")
            else:
                prefix, order_value, _ = folder_order
                group = "appendix" if prefix == "A" else "story"
                duplicate_key = (series_name, group, f"{prefix}{order_value}")
                if duplicate_key in order_keys:
                    errors.append(f"目录前缀重复：{series_name}/{prefix}{order_value}")
                order_keys.add(duplicate_key)

    for key in rows:
        if key not in actual:
            errors.append(f"顺序清单残留：{key[0]}/{key[1]}")
    return errors, warnings


def json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class ReaderServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class ReaderHandler(BaseHTTPRequestHandler):
    server_version = "LocalComicReader/1.0"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("[reader] " + (format % args) + "\n")

    def send_headers(self, content_type: str, length: int, cache_control: str = "no-store") -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")

    def respond(self, status: int, body: bytes, content_type: str = "application/json; charset=utf-8") -> None:
        self.send_response(status)
        self.send_headers(content_type, len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path
        if route == "/health":
            self.respond(HTTPStatus.OK, b'{"ok":true}', "application/json; charset=utf-8")
            return
        if route == "/api/library":
            self.respond(HTTPStatus.OK, json_bytes(scan_library()))
            return
        if route == "/api/chapter":
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            chapter_id = query.get("chapter", [""])[0]
            payload = chapter_response(chapter_id)
            if payload is None:
                self.respond(HTTPStatus.NOT_FOUND, json_bytes({"error": "章节不存在"}))
            else:
                self.respond(HTTPStatus.OK, json_bytes(payload))
            return
        if route.startswith("/media/"):
            self.serve_media(route[len("/media/") :])
            return
        if route == "/" or route == "":
            self.serve_static("index.html")
            return
        self.serve_static(route.lstrip("/"))

    def do_HEAD(self) -> None:
        self.respond(HTTPStatus.METHOD_NOT_ALLOWED, json_bytes({"error": "只支持 GET"}))

    def do_POST(self) -> None:
        self.respond(HTTPStatus.METHOD_NOT_ALLOWED, json_bytes({"error": "只支持 GET"}))

    def do_PUT(self) -> None:
        self.respond(HTTPStatus.METHOD_NOT_ALLOWED, json_bytes({"error": "只支持 GET"}))

    def do_DELETE(self) -> None:
        self.respond(HTTPStatus.METHOD_NOT_ALLOWED, json_bytes({"error": "只支持 GET"}))

    def serve_static(self, relative_text: str) -> None:
        decoded = urllib.parse.unquote(relative_text)
        if "\x00" in decoded:
            self.respond(HTTPStatus.BAD_REQUEST, json_bytes({"error": "非法路径"}))
            return
        candidate = (STATIC_ROOT / decoded).resolve()
        if not root_contained(candidate, STATIC_ROOT) or not candidate.is_file() or candidate.is_symlink():
            self.respond(HTTPStatus.NOT_FOUND, json_bytes({"error": "资源不存在"}))
            return
        try:
            data = candidate.read_bytes()
        except OSError:
            self.respond(HTTPStatus.NOT_FOUND, json_bytes({"error": "资源不可读"}))
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_headers(content_type, len(data), "no-store")
        self.end_headers()
        self.wfile.write(data)

    def serve_media(self, encoded_relative: str) -> None:
        relative = urllib.parse.unquote(encoded_relative)
        if not relative or "\x00" in relative:
            self.respond(HTTPStatus.BAD_REQUEST, json_bytes({"error": "非法媒体路径"}))
            return
        candidate = (MANGA_ROOT / relative).resolve()
        if not root_contained(candidate, MANGA_ROOT) or not is_safe_regular_file(candidate):
            self.respond(HTTPStatus.NOT_FOUND, json_bytes({"error": "图片不存在"}))
            return
        try:
            chapter_dir = candidate.parent
            if chapter_dir.parent != MANGA_ROOT or chapter_dir.is_symlink():
                raise FileNotFoundError
            if candidate not in direct_images(chapter_dir):
                raise FileNotFoundError
            data = candidate.read_bytes()
        except (OSError, FileNotFoundError):
            self.respond(HTTPStatus.NOT_FOUND, json_bytes({"error": "图片不存在"}))
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix.casefold() == ".webp":
            content_type = "image/webp"
        self.send_response(HTTPStatus.OK)
        self.send_headers(content_type, len(data), "private, max-age=3600")
        self.end_headers()
        self.wfile.write(data)


def choose_server() -> ReaderServer:
    for port in range(8767, 8788):
        try:
            return ReaderServer(("127.0.0.1", port), ReaderHandler)
        except OSError:
            continue
    raise OSError("8767—8787 均无法使用")


def main() -> None:
    if "--check-library" in sys.argv[1:]:
        errors, warnings = validate_order_manifest()
        for warning in warnings:
            print(f"WARN\t{warning}")
        for error in errors:
            print(f"ERROR\t{error}")
        if errors:
            print(f"检查失败：{len(errors)} 个错误，{len(warnings)} 个警告")
            raise SystemExit(1)
        print(f"检查通过：{len(load_order_manifest()[0])} 个目录顺序记录")
        return
    if not MANGA_ROOT.exists():
        print(f"找不到漫画目录：{MANGA_ROOT}", file=sys.stderr)
        raise SystemExit(2)
    server = choose_server()
    host, port = server.server_address
    url = f"http://{host}:{port}/"
    print(f"本地漫画阅读器：{url}")
    print("服务只监听本机；按 Ctrl-C 停止。")
    try:
        webbrowser.open(url)
    except Exception as exc:  # pragma: no cover - browser availability is OS-specific
        print(f"无法自动打开浏览器，请手动访问 {url}：{exc}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止本地漫画阅读器。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
