#!/usr/bin/env python3
"""Build the legacy-to-explicit reading-order manifest without touching manga files."""

from __future__ import annotations

import csv
import re
import sys
from decimal import Decimal
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
import app  # noqa: E402


HEADER = ["series", "order_key", "kind", "folder", "title", "note"]
CHAPTER_RE = re.compile(r"第(\d{1,4}(?:\.\d+)?)(?:\+(\d+))?话")
SPECIAL_RE = re.compile(r"特别篇第(\d{1,4}(?:\.\d+)?)话")
# Keep the volume label and its local chapter number separate.  Including
# digits in the first group makes a greedy match read ``卷四10`` as ``四1`` +
# ``0`` and scrambles the volume ordering.
VOLUME_RE = re.compile(r"卷([一二三四五六七八九十]+)(\d{1,4})")


def chapter_dirs(series: str) -> list[Path]:
    result = []
    for path in app.MANGA_ROOT.iterdir():
        if path.is_dir() and not path.is_symlink() and path.name.startswith(series + "_") and app.direct_images(path):
            result.append(path)
    return result


def decimal_from_text(value: str) -> Decimal:
    return Decimal(value)


def chapter_value(name: str) -> Decimal | None:
    match = CHAPTER_RE.search(name)
    if not match:
        return None
    value = Decimal(match.group(1))
    if match.group(2):
        value += Decimal(match.group(2)) / Decimal(10 ** len(match.group(2)))
    return value


def volume_value(name: str) -> tuple[int, int] | None:
    match = VOLUME_RE.search(name)
    if not match:
        return None
    roman = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    return roman.get(match.group(1), int(match.group(1)) if match.group(1).isdigit() else 0), int(match.group(2))


def title_for(series: str, folder: str, kind: str) -> str:
    if series == "我独自升级":
        rest = app.chapter_rest(series, folder)
        if rest.startswith("特别篇第"):
            return rest.replace("_", " · ")
        if rest.startswith("序章"):
            return rest.replace("_", " · ")
    if series == "拔剑九亿次" and "第0+1话" in folder:
        return "第0+1话 · 绑架式穿越"
    return app.display_title(series, folder, kind)[0]


def ordered_for(series: str, paths: list[Path]) -> tuple[list[tuple[Path, str, str]], list[tuple[Path, str, str]]]:
    """Return story rows and appendix rows in the intended legacy order."""
    if series == "史上最强":
        paths.sort(key=lambda p: Decimal(app.number_text(app.chapter_rest(series, p.name)) or "999999"))
        return [(p, "story", "按现有唯一目录序号映射") for p in paths], []

    if series == "败者为寇":
        story = [p for p in paths if not app.is_appendix(p.name)]
        appendix = [p for p in paths if app.is_appendix(p.name)]
        story.sort(key=lambda p: (chapter_value(p.name) or Decimal("999999"), app.natural_key(p.name)))
        appendix.sort(key=lambda p: app.natural_key(p.name))
        return [(p, "story", "按章节号含28.5排序") for p in story], [(p, "appendix", "非剧情材料") for p in appendix]

    if series == "我独自升级":
        prologues = [p for p in paths if "序章" in p.name]
        main = [p for p in paths if "序章" not in p.name and "特别篇" not in p.name]
        specials = [p for p in paths if "特别篇" in p.name]
        prologues.sort(key=lambda p: (p.stat().st_mtime_ns, p.name))
        main.sort(key=lambda p: (chapter_value(p.name) or Decimal("999999"), app.natural_key(p.name)))
        specials.sort(key=lambda p: (Decimal(SPECIAL_RE.search(p.name).group(1)) if SPECIAL_RE.search(p.name) else Decimal("999999"), p.name))
        return ([(p, "story", "序章按本地取得时间") for p in prologues]
                + [(p, "story", "按第N话") for p in main]
                + [(p, "story", "按特别篇编号") for p in specials]), []

    if series == "传武":
        explicit = [p for p in paths if chapter_value(p.name) is not None]
        volumes = [p for p in paths if chapter_value(p.name) is None]
        explicit.sort(key=lambda p: (chapter_value(p.name), app.natural_key(p.name)))
        volumes.sort(key=lambda p: (volume_value(p.name) or (999, 999), app.natural_key(p.name)))
        return ([(p, "story", "按显式第N话") for p in explicit]
                + [(p, "story", "按卷号与卷内号") for p in volumes]), []

    if series == "拔剑九亿次":
        paths.sort(key=lambda p: (chapter_value(p.name) or Decimal("999999"), app.natural_key(p.name)))
        return [(p, "story", "按标题章节号，忽略下载批次号") for p in paths], []

    paths.sort(key=app.natural_key)
    return [(p, "story", "待人工复核") for p in paths], []


def main() -> int:
    if not app.MANGA_ROOT.is_dir():
        print(f"找不到漫画目录：{app.MANGA_ROOT}", file=sys.stderr)
        return 2
    rows: list[dict[str, str]] = []
    series_names = sorted({p.name.split("_", 1)[0] for p in app.MANGA_ROOT.iterdir() if p.is_dir() and not p.is_symlink() and app.direct_images(p)})
    for series in series_names:
        story, appendix = ordered_for(series, chapter_dirs(series))
        for index, (path, _, note) in enumerate(story, 1):
            kind = "special" if "特别篇" in path.name or "番外" in path.name or "外传" in path.name else ("prologue" if "序章" in path.name else "main")
            rows.append({"series": series, "order_key": f"S{index:04d}", "kind": kind, "folder": path.name, "title": title_for(series, path.name, kind), "note": note})
        for index, (path, _, note) in enumerate(appendix, 1):
            rows.append({"series": series, "order_key": f"A{index:04d}", "kind": "appendix", "folder": path.name, "title": title_for(series, path.name, "appendix"), "note": note})

    destination = PROJECT_ROOT / "data" / "library_order.tsv"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=HEADER, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} rows to {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
