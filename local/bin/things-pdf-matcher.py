#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "docling",
#     "python-Levenshtein",
# ]
# ///
"""
things-pdf-matcher

Extracts bold text (task titles) from scanned PDF index cards and matches them
against tasks in the Things database using fuzzy matching.

REQUIREMENTS:
    - Python 3.8+
    - uv (curl -LsSf https://astral.sh/uv/install.sh | sh)
    - docling (automatically installed via uv)
    - python-Levenshtein (automatically installed via uv)

INSTALLATION:
    # Install uv
    curl -LsSf https://astral.sh/uv/install.sh | sh

    # Dependencies are automatically installed when you run the script
    # No pip install needed!

NOTE:
    First run will download ~2GB of dependencies (PyTorch, etc.) for docling.
    This is required for OCR/image recognition on scanned PDFs.
    Subsequent runs will be fast.

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
    --use-llm          Use llm CLI for title extraction (fallback)
    --use-ollama       Use ollama for title extraction (fallback)
    -h, --help         Show help message

OUTPUT:
    Single high-confidence match:
      things:///show?id=abc123

    Multiple high-confidence matches:
      Multiple high-confidence matches:
        things:///show?id=abc123 (95% - "Task title")
        things:///show?id=def456 (87% - "Similar task")

    No high-confidence matches:
      No high-confidence matches. Top candidates:
        things:///show?id=abc123 (65% - "Possible match")
        things:///show?id=def456 (52% - "Another option")
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

try:
    import Levenshtein
except ImportError:
    print("Error: python-Levenshtein not installed", file=sys.stderr)
    print("Install with: pip install python-Levenshtein", file=sys.stderr)
    sys.exit(1)

try:
    from docling.document_converter import DocumentConverter
except ImportError:
    print("Error: docling not installed", file=sys.stderr)
    print("Install with: pip install docling", file=sys.stderr)
    sys.exit(1)


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
    distance: int


class PdfExtractor:
    """Extracts task titles from scanned PDF using docling (OCR)"""

    def __init__(self, use_llm: bool = False, use_ollama: bool = False, verbose: bool = False):
        self.use_llm = use_llm
        self.use_ollama = use_ollama
        self.verbose = verbose
        self.converter = DocumentConverter()

    def extract_titles(self, pdf_path: str) -> List[str]:
        """Extract bold titles from scanned PDF"""
        if not os.path.exists(pdf_path):
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")

        if self.verbose:
            print(f"Processing scanned PDF with docling: {pdf_path}")
            print("(This may take a while on first run while downloading models...)")

        # Convert PDF with docling
        result = self.converter.convert(pdf_path)

        if self.verbose:
            print("PDF converted successfully")

        # Export to markdown - docling preserves formatting
        markdown = result.document.export_to_markdown()

        if self.verbose:
            print("\nExtracted markdown:")
            print("=" * 60)
            print(markdown[:1000] + ("..." if len(markdown) > 1000 else ""))
            print("=" * 60)

        # Extract titles from markdown
        titles = self._extract_titles_from_markdown(markdown)

        if self.verbose:
            print(f"\nExtracted {len(titles)} titles")

        # If no titles found and AI fallback requested
        if not titles and (self.use_llm or self.use_ollama):
            if self.verbose:
                print("\nNo titles found via markdown parsing, trying AI extraction...")
            titles = self._extract_with_ai_fallback(markdown)

        return titles

    def _extract_titles_from_markdown(self, markdown: str) -> List[str]:
        """Extract titles from markdown output"""
        titles = []
        lines = markdown.split('\n')

        for line in lines:
            line = line.strip()

            # Match markdown headers (# Title, ## Title, etc.)
            if line.startswith('#'):
                title = re.sub(r'^#+\s*', '', line).strip()
                if title and title.upper() != "NONE" and len(title) > 3:
                    titles.append(title)
                    if self.verbose:
                        print(f"  Found title (header): {title}")

            # Match bold text (**Title** or __Title__)
            elif line.startswith('**') and line.endswith('**'):
                title = line.strip('*').strip()
                if title and title.upper() != "NONE" and len(title) > 3:
                    titles.append(title)
                    if self.verbose:
                        print(f"  Found title (bold): {title}")

            elif line.startswith('__') and line.endswith('__'):
                title = line.strip('_').strip()
                if title and title.upper() != "NONE" and len(title) > 3:
                    titles.append(title)
                    if self.verbose:
                        print(f"  Found title (bold): {title}")

        return titles

    def _extract_with_ai_fallback(self, markdown: str) -> List[str]:
        """Use AI (llm or ollama) to extract titles from markdown text"""
        prompt = """Extract ONLY the task titles from this document.
Each page has a BOLD title at the top and regular text notes below.
Return only the titles, one per line.
If a page has no title, skip it.

Document:
""" + markdown

        try:
            if self.use_llm:
                result = subprocess.run(
                    ["llm", prompt],
                    capture_output=True,
                    text=True,
                    check=True
                )
                output = result.stdout.strip()
            elif self.use_ollama:
                result = subprocess.run(
                    ["ollama", "run", "llama3.2", prompt],
                    capture_output=True,
                    text=True,
                    check=True
                )
                output = result.stdout.strip()
            else:
                return []

            # Parse titles from output
            titles = [line.strip() for line in output.split('\n') if line.strip()]
            return titles

        except subprocess.CalledProcessError as e:
            if self.verbose:
                print(f"AI extraction failed: {e}")
            return []
        except FileNotFoundError:
            if self.verbose:
                print(f"AI tool not found (llm or ollama)")
            return []


class ThingsMatcher:
    """Fuzzy matching using Levenshtein distance"""

    @staticmethod
    def find_matches(
        query: str,
        tasks: List[Task],
        threshold: float = 0.8,
        max_candidates: int = 5
    ) -> List[Match]:
        """Find fuzzy matches for query in tasks"""
        if not query:
            return []

        # Normalize query
        normalized_query = ThingsMatcher.normalize(query)

        # Calculate distances for all tasks
        matches = []
        for task in tasks:
            normalized_title = ThingsMatcher.normalize(task.title)

            # Levenshtein distance
            distance = Levenshtein.distance(normalized_query, normalized_title)

            # Calculate similarity score (0-1, where 1 is identical)
            max_length = max(len(normalized_query), len(normalized_title))
            score = 1.0 - (distance / max_length) if max_length > 0 else 0.0

            matches.append(Match(task.uuid, task.title, score, distance))

        # Sort by score descending
        matches.sort(key=lambda m: m.score, reverse=True)

        # Filter by threshold
        high_confidence = [m for m in matches if m.score >= threshold]

        if len(high_confidence) >= 1:
            return high_confidence
        else:
            # No high-confidence matches, return top N candidates
            return matches[:max_candidates]

    @staticmethod
    def normalize(text: str) -> str:
        """Normalize text for matching"""
        if not text:
            return ""
        # Convert to lowercase, replace punctuation with spaces, normalize whitespace
        text = text.lower()
        text = re.sub(r'[^\w\s]', ' ', text)
        text = re.sub(r'\s+', ' ', text)
        return text.strip()


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
        """Fetch all active tasks from database"""
        cursor = conn.cursor()
        cursor.execute("""
            SELECT uuid, title, notes
            FROM TMTask
            WHERE type = 0
              AND status = 0
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
    parser.add_argument("--max-candidates", type=int, default=5,
                       help="Max candidates to show (default: 5)")
    parser.add_argument("--use-llm", action="store_true",
                       help="Use llm CLI for extraction")
    parser.add_argument("--use-ollama", action="store_true",
                       help="Use ollama for extraction")

    args = parser.parse_args()

    # Validate arguments
    if not args.test and not args.pdf_file:
        parser.error("PDF file required unless using --test mode")

    # Connect to database
    if args.verbose:
        print("Connecting to Things database..." if not args.test else "Using test database...")

    try:
        conn = ThingsDatabase.connect(test_mode=args.test)
        tasks = ThingsDatabase.fetch_tasks(conn)
    except Exception as e:
        print(f"Error accessing database: {e}", file=sys.stderr)
        sys.exit(1)

    if args.verbose:
        print(f"Loaded {len(tasks)} tasks")
        if args.test:
            print("\nTest database contains:")
            for task in tasks:
                print(f"  - {task.title}")
            print()

    # Extract titles from PDF or use test queries
    if args.pdf_file:
        extractor = PdfExtractor(
            use_llm=args.use_llm,
            use_ollama=args.use_ollama,
            verbose=args.verbose
        )

        try:
            titles = extractor.extract_titles(args.pdf_file)
        except Exception as e:
            print(f"Error extracting from PDF: {e}", file=sys.stderr)
            sys.exit(1)

        if not titles:
            print("No titles extracted from PDF", file=sys.stderr)
            sys.exit(1)

        if args.verbose:
            print(f"\nExtracted {len(titles)} title(s):")
            for title in titles:
                print(f"  - {title}")
            print()
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
            print("Using test queries:")
            for title in titles:
                print(f"  - {title}")
            print()

    # Match each title
    for i, title in enumerate(titles):
        if len(titles) > 1 and args.verbose:
            print(f"\n{'='*60}")
            print(f"Title {i+1}: \"{title}\"")
            print('='*60)

        matches = ThingsMatcher.find_matches(
            title,
            tasks,
            threshold=args.threshold,
            max_candidates=args.max_candidates
        )

        display_matches(matches, title, args.threshold, args.verbose)

        if len(titles) > 1:
            print()


def display_matches(matches: List[Match], query: str, threshold: float, verbose: bool):
    """Display match results"""
    if not matches:
        print("No matches found")
        return

    high_confidence = [m for m in matches if m.score >= threshold]

    if len(high_confidence) == 1:
        # Single high-confidence match
        match = high_confidence[0]
        print(f"things:///show?id={match.uuid}")
        if verbose:
            print(f"  {int(match.score * 100)}% - \"{match.title}\"")
    elif len(high_confidence) > 1:
        # Multiple high-confidence matches
        print("Multiple high-confidence matches:")
        for match in high_confidence:
            print(f"  things:///show?id={match.uuid} ({int(match.score * 100)}% - \"{match.title}\")")
    else:
        # No high-confidence matches
        print("No high-confidence matches. Top candidates:")
        for match in matches:
            print(f"  things:///show?id={match.uuid} ({int(match.score * 100)}% - \"{match.title}\")")


if __name__ == "__main__":
    main()
