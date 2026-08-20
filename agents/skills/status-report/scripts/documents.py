#!/usr/bin/env python3
"""
Local Documents Collector for Status Reports

Walks configured directories, finds markdown and PDF files modified in the
report period, applies exclusion rules, and emits the contents as JSON for
the main LLM prompt.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect local markdown/PDF documents for status reports"
    )
    parser.add_argument("--start-date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--end-date", required=True, help="YYYY-MM-DD")
    parser.add_argument(
        "--directories",
        required=True,
        help="Comma-separated directories to scan (~ is expanded)",
    )
    parser.add_argument(
        "--extensions",
        default="md,pdf",
        help="Comma-separated extensions without dots (default: md,pdf)",
    )
    parser.add_argument(
        "--exclude-patterns",
        default="",
        help="Comma-separated substrings; any match against the absolute path excludes the file",
    )
    parser.add_argument(
        "--max-file-bytes",
        type=int,
        default=20000,
        help="Per-file byte cap; longer files are truncated (default: 20000)",
    )
    parser.add_argument("--output", required=True, help="Output JSON file path")
    return parser.parse_args()


def date_window(start_date: str, end_date: str) -> tuple:
    """Return (start_ts, end_ts) inclusive of the end date through 23:59:59 local."""
    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date, "%Y-%m-%d").replace(
        hour=23, minute=59, second=59
    )
    return start_dt.timestamp(), end_dt.timestamp()


def find_candidates(
    directories: List[str],
    extensions: set,
    start_ts: float,
    end_ts: float,
    exclude_patterns: List[str],
) -> List[Path]:
    """Walk directories and return paths matching all filters."""
    candidates: List[Path] = []
    for d in directories:
        root = Path(d)
        if not root.is_dir():
            print(f"Warning: directory not found: {d}", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            # Prune hidden segments and node_modules in-place so we don't descend
            dirnames[:] = [
                dn for dn in dirnames
                if not dn.startswith(".") and dn != "node_modules"
            ]
            # Prune subtrees that match an exclude pattern
            dirnames[:] = [
                dn for dn in dirnames
                if not _matches_exclude(os.path.join(dirpath, dn), exclude_patterns)
            ]

            for name in filenames:
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if ext not in extensions:
                    continue
                p = Path(dirpath) / name
                abspath = str(p.resolve(strict=False))
                if _matches_exclude(abspath, exclude_patterns):
                    continue
                if any(part.startswith(".") for part in p.parts):
                    continue
                try:
                    if p.is_symlink():
                        continue
                    mtime = p.stat().st_mtime
                except OSError:
                    continue
                if not (start_ts <= mtime <= end_ts):
                    continue
                candidates.append(p)
    return candidates


def _matches_exclude(path: str, patterns: List[str]) -> bool:
    """True if any pattern is a substring of path (case-sensitive)."""
    return any(p and p in path for p in patterns)


def read_markdown(path: Path, max_bytes: int) -> Dict[str, Any]:
    """Read a markdown file as UTF-8 with replacement, truncating at max_bytes."""
    size = path.stat().st_size
    truncated = size > max_bytes
    with open(path, "rb") as f:
        raw = f.read(max_bytes) if truncated else f.read()
    content = raw.decode("utf-8", errors="replace")
    return {"content": content, "truncated": truncated, "size_bytes": size}


def read_pdf(path: Path, max_bytes: int) -> Dict[str, Any]:
    """Convert a PDF to text via pdftotext. Raises subprocess.CalledProcessError on failure."""
    size = path.stat().st_size
    result = subprocess.run(
        ["pdftotext", "-layout", "-nopgbrk", str(path), "-"],
        capture_output=True,
        check=True,
    )
    text = result.stdout.decode("utf-8", errors="replace")
    truncated = len(text.encode("utf-8")) > max_bytes
    if truncated:
        encoded = text.encode("utf-8")[:max_bytes]
        text = encoded.decode("utf-8", errors="ignore")
    return {"content": text, "truncated": truncated, "size_bytes": size}


def build_document(
    path: Path,
    max_bytes: int,
    pdftotext_available: bool,
    skipped: List[Dict[str, str]],
) -> Optional[Dict[str, Any]]:
    """Return a document dict or None (with a `skipped` entry appended) on failure."""
    ext = path.suffix.lstrip(".").lower()
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
    except OSError as e:
        skipped.append({"path": str(path), "reason": f"stat failed: {e}"})
        return None

    if ext == "md":
        try:
            body = read_markdown(path, max_bytes)
        except OSError as e:
            skipped.append({"path": str(path), "reason": f"read failed: {e}"})
            return None
    elif ext == "pdf":
        if not pdftotext_available:
            skipped.append({"path": str(path), "reason": "pdftotext not installed"})
            return None
        try:
            body = read_pdf(path, max_bytes)
        except subprocess.CalledProcessError as e:
            stderr_snippet = (e.stderr or b"").decode("utf-8", errors="replace")[:200].strip()
            skipped.append(
                {"path": str(path), "reason": f"pdftotext failed: {stderr_snippet}"}
            )
            return None
        except OSError as e:
            skipped.append({"path": str(path), "reason": f"read failed: {e}"})
            return None
    else:
        skipped.append({"path": str(path), "reason": f"unsupported extension: {ext}"})
        return None

    return {
        "path": str(path),
        "name": path.name,
        "extension": ext,
        "mtime": mtime,
        "size_bytes": body["size_bytes"],
        "truncated": body["truncated"],
        "content": body["content"],
    }


def main() -> int:
    args = parse_args()

    directories = [
        os.path.expanduser(d.strip())
        for d in args.directories.split(",")
        if d.strip()
    ]
    extensions = {
        e.strip().lower().lstrip(".")
        for e in args.extensions.split(",")
        if e.strip()
    }
    exclude_patterns = [
        p.strip()
        for p in args.exclude_patterns.split(",")
        if p.strip()
    ]

    pdftotext_available = shutil.which("pdftotext") is not None
    if "pdf" in extensions and not pdftotext_available:
        print(
            "Warning: pdftotext not on PATH; PDFs will be skipped",
            file=sys.stderr,
        )

    start_ts, end_ts = date_window(args.start_date, args.end_date)
    candidates = find_candidates(
        directories, extensions, start_ts, end_ts, exclude_patterns
    )

    skipped: List[Dict[str, str]] = []
    documents: List[Dict[str, Any]] = []
    for path in candidates:
        doc = build_document(
            path, args.max_file_bytes, pdftotext_available, skipped
        )
        if doc is not None:
            documents.append(doc)

    documents.sort(key=lambda d: d["mtime"], reverse=True)

    output: Dict[str, Any] = {
        "date_range": {"start": args.start_date, "end": args.end_date},
        "directories_scanned": directories,
        "extensions": sorted(extensions),
        "exclude_patterns_applied": exclude_patterns,
        "pdftotext_available": pdftotext_available,
        "max_file_bytes": args.max_file_bytes,
        "documents": documents,
        "skipped": skipped,
    }

    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    print(
        f"Documents collected: {len(documents)}, skipped: {len(skipped)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
