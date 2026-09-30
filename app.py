#!/usr/bin/env python3
"""A read-only, loopback-only local comic reader server."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import socket
import sys
import threading
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent
MANGA_ROOT = (PROJECT_ROOT.parent / "漫画").resolve()
STATIC_ROOT = (PROJECT_ROOT / "static").resolve()
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
APPENDIX_MARKERS = ("非剧情", "上架感言", "周日更新", "外出取材", "更新延迟", "本周休刊", "通知")
SERIES_ORDER_HINTS = ("史上最强", "败者为寇", "我独自升级")

_cache_lock = threading.Lock()
_library_cache: dict[str, Any] | None = None
_library_signature: tuple[Any, ...] | None = None


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
    rest = folder_name[len(series_name) + 1 :] if folder_name.startswith(series_name + "_") else folder_name
    rest = re.sub(r"_原始(?:JPEG|WebP)$", "", rest, flags=re.IGNORECASE)
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
    raw = entry.get("number")
    number = float(raw) if raw is not None else float("inf")
    folder = entry["folder"]
    if entry["kind"] == "main":
        return (0, number, natural_key(folder))
    if entry["kind"] == "special":
        return (1, number, natural_key(folder))
    return (2, number, natural_key(folder))


def directory_signature() -> tuple[Any, ...]:
    if not MANGA_ROOT.exists() or not MANGA_ROOT.is_dir():
        return ("missing",)
    values: list[Any] = [MANGA_ROOT.stat().st_mtime_ns]
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

        grouped: dict[str, list[dict[str, Any]]] = {}
        if MANGA_ROOT.exists() and MANGA_ROOT.is_dir():
            for chapter_dir in MANGA_ROOT.iterdir():
                if not chapter_dir.is_dir() or chapter_dir.is_symlink() or chapter_dir.name.startswith("."):
                    continue
                images = direct_images(chapter_dir)
                if not images:
                    continue
                series_name = chapter_dir.name.split("_", 1)[0]
                kind = group_kind(chapter_dir.name)
                label, raw_number = display_title(series_name, chapter_dir.name, kind)
                grouped.setdefault(series_name, []).append(
                    {
                        "id": chapter_dir.name,
                        "folder": chapter_dir.name,
                        "series": series_name,
                        "kind": kind,
                        "title": label,
                        "number": raw_number,
                        "images": len(images),
                    }
                )

        series_names = sorted(
            grouped,
            key=lambda name: (
                SERIES_ORDER_HINTS.index(name) if name in SERIES_ORDER_HINTS else len(SERIES_ORDER_HINTS),
                natural_key(name),
            ),
        )
        series: list[dict[str, Any]] = []
        for series_name in series_names:
            chapters = sorted(grouped[series_name], key=chapter_sort_key)
            main = [item for item in chapters if item["kind"] == "main"]
            special = [item for item in chapters if item["kind"] == "special"]
            appendix = [item for item in chapters if item["kind"] == "appendix"]
            series.append(
                {
                    "name": series_name,
                    "chapters": main + special,
                    "appendix": appendix,
                    "totalImages": sum(item["images"] for item in chapters),
                }
            )
        _library_cache = {"series": series}
        _library_signature = signature
        return _library_cache


def find_chapter(chapter_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    library = scan_library()
    for series in library["series"]:
        for item in series["chapters"] + series["appendix"]:
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
