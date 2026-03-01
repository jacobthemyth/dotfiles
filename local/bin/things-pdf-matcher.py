#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "ocrmac",
#     "pymupdf",
#     "pillow",
#     "rapidfuzz",
# ]
# ///
"""
things-pdf-matcher

Extracts bold text (task titles) from scanned PDF index cards and matches them
against tasks in the Things database using fuzzy matching.

REQUIREMENTS:
    - Python 3.8+
    - macOS (uses Apple Vision OCR via ocrmac)
    - uv (curl -LsSf https://astral.sh/uv/install.sh | sh)

INSTALLATION:
    # Install uv
    curl -LsSf https://astral.sh/uv/install.sh | sh

    # Dependencies are automatically installed when you run the script
    # No pip install needed!

USAGE:
    # Production mode (requires Things database)
    things-pdf-matcher scanned-cards.pdf
    things-pdf-matcher --verbose --threshold 0.7 cards.pdf

    # Test mode with hardcoded queries (no external dependencies)
    things-pdf-matcher --test
    things-pdf-matcher --test --verbose

    # Test mode with PDF (uses test database)
    things-pdf-matcher --test scanned-test-cards.pdf
    things-pdf-matcher --test --verbose test-cards.pdf

OPTIONS:
    --test              Run in test mode with sample database
    --threshold FLOAT   Fuzzy match threshold (0-1, default: 0.8)
    --verbose          Show matching details and extraction progress
    --max-candidates N  Max candidates to show (default: 5)
    --debug            Show document structure and extraction details
    --non-interactive  Don't prompt for disambiguation (use best match)
    -h, --help         Show help message

OUTPUT:
    Single high-confidence match:
      things:///show?id=abc123

    Multiple high-confidence matches (interactive):
      Multiple matches found for "Task title":
        1. Task title (95%)
        2. Similar task (87%)
      Select match (1-2, s to skip):

    No high-confidence matches:
      No high-confidence matches. Top candidates:
        things:///show?id=abc123 (65% - "Possible match")
        things:///show?id=def456 (52% - "Another option")
"""

import argparse
import io
import logging
import os
import sqlite3
import sys
from dataclasses import dataclass
from typing import List, Optional, Tuple, Dict, Any

try:
    from rapidfuzz import fuzz, process
except ImportError:
    print("Error: rapidfuzz not installed", file=sys.stderr)
    print("Install with: pip install rapidfuzz", file=sys.stderr)
    sys.exit(1)

import fitz  # pymupdf
from ocrmac import ocrmac as ocrmac_lib
from PIL import Image


@dataclass
class Task:
    """Represents a Things task"""
    uuid: str
    title: str
    notes: Optional[str] = None


@dataclass
class Match:
    """Represents a fuzzy match result"""
    uuid: str
    title: str
    score: float


@dataclass
class ExtractedTitle:
    """Represents an extracted title with metadata"""
    text: str
    page: int
    confidence: str  # 'high', 'medium', 'low'
    method: str      # 'vision_ocr'


class PdfExtractor:
    """Extracts task titles from scanned PDF using Apple Vision OCR (via ocrmac)"""

    DPI = 200  # render resolution for OCR

    def __init__(self, verbose: bool = False, debug: bool = False):
        self.verbose = verbose
        self.debug = debug

    def extract_titles(self, pdf_path: str, tasks: Optional[List[Task]] = None) -> List[str]:
        """Extract titles from scanned PDF pages using Apple Vision OCR"""
        if not os.path.exists(pdf_path):
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")

        if self.verbose:
            print(f"Processing scanned PDF with Apple Vision OCR: {pdf_path}", file=sys.stderr)

        doc = fitz.open(pdf_path)

        if self.verbose:
            print(f"PDF has {len(doc)} page(s)", file=sys.stderr)

        all_extracted: List[ExtractedTitle] = []

        for page_num in range(len(doc)):
            page = doc[page_num]
            # Render page to pixmap at target DPI
            mat = fitz.Matrix(self.DPI / 72, self.DPI / 72)
            pix = page.get_pixmap(matrix=mat)
            img = Image.open(io.BytesIO(pix.tobytes("png")))

            # Run Apple Vision OCR
            annotations = ocrmac_lib.OCR(img, recognition_level="accurate").recognize()

            if self.debug:
                print(f"\n[DEBUG] Page {page_num + 1}: {len(annotations)} text elements", file=sys.stderr)
                for text, confidence, bbox in annotations:
                    print(f"  [{confidence:.2f}] ({bbox[0]:.2f},{bbox[1]:.2f},{bbox[2]:.2f},{bbox[3]:.2f}) {text}", file=sys.stderr)

            title = self._pick_title_from_page(annotations, page_num + 1)
            if title:
                all_extracted.append(title)

        doc.close()

        if self.debug:
            print(f"\n[DEBUG] Extracted {len(all_extracted)} titles", file=sys.stderr)
            for title in all_extracted:
                print(f"  - {title.text} (page {title.page}, confidence={title.confidence})", file=sys.stderr)

        # Validate against known tasks if provided (filter false positives)
        if tasks:
            validated = self._validate_against_tasks(all_extracted, tasks)
            if self.debug:
                filtered_count = len(all_extracted) - len(validated)
                if filtered_count > 0:
                    print(f"\n[DEBUG] Filtered out {filtered_count} low-confidence items (likely notes)", file=sys.stderr)
        else:
            validated = all_extracted

        titles = [t.text for t in validated]

        return titles

    # Max y-gap between consecutive lines that are still part of the same block.
    # Title lines are ~0.03-0.04 apart; body starts after a 0.07-0.10 gap.
    LINE_GAP_THRESHOLD = 0.06

    def _pick_title_from_page(self, annotations: List[Tuple], page_num: int) -> Optional[ExtractedTitle]:
        """Pick the topmost block of text as the title for a page.

        Index cards have a title (one or more lines) at the top, then a gap,
        then optional body text.  We group consecutive top lines whose y-gap
        is within LINE_GAP_THRESHOLD and join them as the title.

        ocrmac returns Core Graphics coordinates where y=0 is the bottom,
        so the topmost element has the highest y value.
        """
        # Filter out tiny fragments (< 3 chars)
        candidates = [(text, conf, bbox) for text, conf, bbox in annotations if len(text.strip()) >= 3]

        if not candidates:
            return None

        # Sort by y descending (topmost first in visual space)
        candidates.sort(key=lambda item: item[2][1], reverse=True)

        # Collect the first block of lines (title) until we hit a large gap
        title_parts = [candidates[0]]
        for prev, cur in zip(candidates, candidates[1:]):
            gap = prev[2][1] - cur[2][1]
            if gap > self.LINE_GAP_THRESHOLD:
                break
            title_parts.append(cur)

        text = " ".join(part[0].strip() for part in title_parts)
        avg_confidence = sum(part[1] for part in title_parts) / len(title_parts)

        if avg_confidence >= 0.8:
            conf_label = "high"
        elif avg_confidence >= 0.5:
            conf_label = "medium"
        else:
            conf_label = "low"

        if self.verbose:
            print(f"  Page {page_num}: \"{text}\" (confidence: {avg_confidence:.0%})", file=sys.stderr)

        return ExtractedTitle(
            text=text,
            page=page_num,
            confidence=conf_label,
            method="vision_ocr",
        )

    def _validate_against_tasks(self, extracted: List[ExtractedTitle], tasks: List[Task]) -> List[ExtractedTitle]:
        """Validate extracted titles against known tasks to filter false positives"""
        validated = []

        for title in extracted:
            # Try to match against known tasks
            best_match = self._find_best_task_match(title.text, tasks)

            # If we get a decent match (>30%), it's probably a real title
            # If no match at all, it might be a note/subtitle
            if best_match and best_match.score > 0.3:
                validated.append(title)
            elif title.confidence == 'high':
                # Keep high-confidence even if no match (might be a new task)
                validated.append(title)
            elif self.debug:
                print(f"[DEBUG] Filtered out (low match): {title.text} (best match: {best_match.score if best_match else 0:.0%})", file=sys.stderr)

        return validated

    def _find_best_task_match(self, query: str, tasks: List[Task]) -> Optional[Match]:
        """Find best matching task for validation purposes"""
        if not tasks:
            return None

        # Use token sort ratio for better matching
        best_score = 0
        best_task = None

        for task in tasks:
            score = fuzz.token_sort_ratio(query.lower(), task.title.lower()) / 100.0
            if score > best_score:
                best_score = score
                best_task = task

        if best_task:
            return Match(best_task.uuid, best_task.title, best_score)
        return None


class ThingsMatcher:
    """Fuzzy matching using RapidFuzz"""

    @staticmethod
    def find_matches(
        query: str,
        tasks: List[Task],
        threshold: float = 0.8,
        max_candidates: int = 5
    ) -> List[Match]:
        """Find fuzzy matches for query in tasks using multiple matching strategies"""
        if not query:
            return []

        query_lower = query.lower()

        # Compute all three fuzz ratios per task in a single pass, keep max
        match_objects = []
        for task in tasks:
            title_lower = task.title.lower()
            score = max(
                fuzz.token_sort_ratio(query_lower, title_lower),
                fuzz.partial_ratio(query_lower, title_lower),
                fuzz.token_set_ratio(query_lower, title_lower),
            ) / 100.0
            match_objects.append(Match(task.uuid, task.title, score))

        # Sort by score descending
        match_objects.sort(key=lambda m: m.score, reverse=True)

        # Filter by threshold
        high_confidence = [m for m in match_objects if m.score >= threshold]

        if len(high_confidence) >= 1:
            return high_confidence
        else:
            # No high-confidence matches, return top N candidates
            return match_objects[:max_candidates]


class ThingsDatabase:
    """Interface to Things database"""

    THINGS_DB_PATH = os.path.expanduser(
        "~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/"
        "ThingsData-A57N3/Things Database.thingsdatabase/main.sqlite"
    )

    @staticmethod
    def connect(test_mode: bool = False) -> sqlite3.Connection:
        """Connect to Things database or create test database"""
        if test_mode:
            return ThingsDatabase.create_test_db()

        if not os.path.exists(ThingsDatabase.THINGS_DB_PATH):
            raise FileNotFoundError(
                f"Things database not found at {ThingsDatabase.THINGS_DB_PATH}"
            )

        return sqlite3.connect(ThingsDatabase.THINGS_DB_PATH)

    @staticmethod
    def fetch_tasks(conn: sqlite3.Connection) -> List[Task]:
        """Fetch all non-trashed tasks from database"""
        cursor = conn.cursor()
        cursor.execute("""
            SELECT uuid, title, notes
            FROM TMTask
            WHERE type = 0
              AND trashed = 0
            ORDER BY title
        """)

        tasks = []
        for row in cursor.fetchall():
            uuid, title, notes = row
            tasks.append(Task(uuid=uuid, title=title, notes=notes))

        return tasks

    @staticmethod
    def create_test_db() -> sqlite3.Connection:
        """Create in-memory test database with sample tasks"""
        conn = sqlite3.connect(":memory:")
        cursor = conn.cursor()

        # Create TMTask table
        cursor.execute("""
            CREATE TABLE TMTask (
                uuid TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                notes TEXT,
                type INTEGER,
                status INTEGER,
                trashed INTEGER,
                creationDate REAL
            )
        """)

        # Insert test data
        test_tasks = [
            ("OAuth123456789", "Review OAuth implementation", "Check token refresh logic"),
            ("ShortTask1234", "Buy milk", None),
            ("VeryLongTask123456", "Complete comprehensive review of the entire authentication system including OAuth2, JWT tokens, session management, and password reset flow", None),
            ("SpecialChars12345", "Fix bug in PDF parser (handle multi-column layouts)", None),
            ("CaseSensitive123", "URGENT: Deploy to production", None),
            ("Punctuation12345", "Review PR #1234: Add new feature", None),
            ("SimilarTask12345", "Tech interview prep", None),
            ("WithNumbers12345", "Update to Node.js v20.5.1", None),
            ("ExtraSpaces12345", "Clean    up    database", None),
            ("Abbreviated12345", "Implement auth w/ JWT", None),
            ("Unicode123456789", "Add emoji support 🎉", None),
            ("QuotedTask12345", 'Read "Clean Code" book', None),
            ("SlashTask123456", "Fix bug in API endpoint /users/:id", None),
            ("MultiPageTask123", "Research distributed systems patterns",
             "Key concepts to cover: 1) Consistency models - strong consistency, eventual consistency, causal consistency. Understanding CAP theorem and how it applies to real-world systems. 2) Replication strategies - master-slave, multi-master, quorum-based replication. Trade-offs between availability and consistency. 3) Partitioning approaches - hash-based, range-based, consistent hashing. How to handle hotspots and rebalancing. 4) Consensus algorithms - Paxos, Raft, and their practical implementations. Understanding leader election and log replication. 5) Event sourcing and CQRS patterns for handling distributed state. 6) Distributed transactions - two-phase commit, saga pattern, and compensating transactions. When to use each approach. 7) Service discovery and coordination using tools like Consul, etcd, or ZooKeeper. 8) Circuit breakers and fault tolerance patterns. How to build resilient systems. 9) Observability in distributed systems - distributed tracing, metrics aggregation, and log correlation. 10) Testing strategies for distributed systems including chaos engineering. Read papers: Google Spanner, Amazon Dynamo, Facebook TAO. Implement sample projects using microservices architecture. Document common failure scenarios and recovery strategies. Consider data locality and network partitions."),
        ]

        for uuid, title, notes in test_tasks:
            cursor.execute(
                "INSERT INTO TMTask VALUES (?, ?, ?, 0, 0, 0, ?)",
                (uuid, title, notes, 0.0)
            )

        conn.commit()
        return conn


def prompt_user_selection(matches: List[Match], query: str) -> Optional[Match]:
    """Prompt user to select from multiple matches"""
    print(f"\nMultiple matches found for \"{query}\":", file=sys.stderr)
    for i, match in enumerate(matches, 1):
        print(f"  {i}. {match.title} ({int(match.score * 100)}%)", file=sys.stderr)

    while True:
        try:
            response = input(f"Select match (1-{len(matches)}, s to skip): ").strip().lower()

            if response == 's':
                return None

            choice = int(response)
            if 1 <= choice <= len(matches):
                return matches[choice - 1]
            else:
                print(f"Please enter a number between 1 and {len(matches)}, or 's' to skip", file=sys.stderr)
        except ValueError:
            print(f"Please enter a number between 1 and {len(matches)}, or 's' to skip", file=sys.stderr)
        except (EOFError, KeyboardInterrupt):
            print(file=sys.stderr)
            return None


def main():
    parser = argparse.ArgumentParser(
        description="Extract task titles from PDF and match against Things database",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument("pdf_file", nargs="?", help="PDF file to process")
    parser.add_argument("--test", action="store_true", help="Run in test mode")
    parser.add_argument("--threshold", type=float, default=0.8,
                       help="Fuzzy match threshold (0-1, default: 0.8)")
    parser.add_argument("--verbose", action="store_true",
                       help="Show matching details")
    parser.add_argument("--debug", action="store_true",
                       help="Show document structure and extraction details")
    parser.add_argument("--max-candidates", type=int, default=5,
                       help="Max candidates to show (default: 5)")
    parser.add_argument("--non-interactive", action="store_true",
                       help="Don't prompt for disambiguation (use best match)")

    args = parser.parse_args()

    # Configure logging
    if args.verbose:
        logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
    else:
        # Suppress all INFO and below messages from all loggers
        logging.basicConfig(level=logging.ERROR, format='%(asctime)s - %(levelname)s - %(message)s')
        # Aggressively suppress all third-party library loggers
        logging.root.setLevel(logging.ERROR)
        # Suppress specific known chatty loggers
        for logger_name in logging.root.manager.loggerDict:
            logging.getLogger(logger_name).setLevel(logging.ERROR)

    # Validate arguments
    if not args.test and not args.pdf_file:
        parser.error("PDF file required unless using --test mode")

    # Connect to database
    if args.verbose:
        print("Connecting to Things database..." if not args.test else "Using test database...", file=sys.stderr)

    try:
        conn = ThingsDatabase.connect(test_mode=args.test)
        tasks = ThingsDatabase.fetch_tasks(conn)
    except Exception as e:
        print(f"Error accessing database: {e}", file=sys.stderr)
        sys.exit(1)

    if args.verbose:
        print(f"Loaded {len(tasks)} tasks", file=sys.stderr)
        if args.test:
            print("\nTest database contains:", file=sys.stderr)
            for task in tasks:
                print(f"  - {task.title}", file=sys.stderr)
            print(file=sys.stderr)

    # Extract titles from PDF or use test queries
    if args.pdf_file:
        extractor = PdfExtractor(
            verbose=args.verbose,
            debug=args.debug
        )

        try:
            titles = extractor.extract_titles(args.pdf_file, tasks)
        except Exception as e:
            print(f"Error extracting from PDF: {e}", file=sys.stderr)
            if args.debug:
                import traceback
                traceback.print_exc()
            sys.exit(1)

        if not titles:
            print("No titles extracted from PDF", file=sys.stderr)
            sys.exit(1)

        if args.verbose:
            print(f"\nExtracted {len(titles)} title(s):", file=sys.stderr)
            for title in titles:
                print(f"  - {title}", file=sys.stderr)
            print(file=sys.stderr)
    else:
        # Test mode without PDF - use hardcoded queries
        titles = [
            "Review OAuth implementation",
            "review oauth",
            "Fix bug in PDF parser",
            "Tech interview",
            "Nonexistent task"
        ]
        if args.verbose:
            print("Using test queries:", file=sys.stderr)
            for title in titles:
                print(f"  - {title}", file=sys.stderr)
            print(file=sys.stderr)

    # Match each title
    for i, title in enumerate(titles):
        if len(titles) > 1 and args.verbose:
            print(f"\n{'='*60}", file=sys.stderr)
            print(f"Title {i+1}: \"{title}\"", file=sys.stderr)
            print('='*60, file=sys.stderr)

        matches = ThingsMatcher.find_matches(
            title,
            tasks,
            threshold=args.threshold,
            max_candidates=args.max_candidates
        )

        display_matches(matches, title, args.threshold, args.verbose, args.non_interactive)


def display_matches(matches: List[Match], query: str, threshold: float, verbose: bool, non_interactive: bool):
    """Display match results"""
    if not matches:
        print("No matches found", file=sys.stderr)
        return

    high_confidence = [m for m in matches if m.score >= threshold]

    if len(high_confidence) == 1:
        # Single high-confidence match
        match = high_confidence[0]
        print(f"{match.title}\tthings:///show?id={match.uuid}")
        if verbose:
            print(f"  {int(match.score * 100)}%", file=sys.stderr)
    elif len(high_confidence) > 1:
        # Multiple high-confidence matches
        if non_interactive:
            # Use best match
            match = high_confidence[0]
            print(f"{match.title}\tthings:///show?id={match.uuid}")
            if verbose:
                print(f"  {int(match.score * 100)}% (best of {len(high_confidence)} matches)", file=sys.stderr)
        else:
            # Interactive selection
            selected = prompt_user_selection(high_confidence, query)
            if selected:
                print(f"{selected.title}\tthings:///show?id={selected.uuid}")
            else:
                print("Skipped", file=sys.stderr)
    else:
        # No high-confidence matches
        if verbose:
            print("No high-confidence matches. Top candidates:", file=sys.stderr)
            for match in matches:
                print(f"  things:///show?id={match.uuid} ({int(match.score * 100)}% - \"{match.title}\")", file=sys.stderr)
        else:
            print(f"No match for \"{query}\"", file=sys.stderr)


if __name__ == "__main__":
    main()
