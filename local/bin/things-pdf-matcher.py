#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.8"
# dependencies = [
#     "docling",
#     "rapidfuzz",
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
    - rapidfuzz (automatically installed via uv)

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
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple, Dict, Any

try:
    from rapidfuzz import fuzz, process
except ImportError:
    print("Error: rapidfuzz not installed", file=sys.stderr)
    print("Install with: pip install rapidfuzz", file=sys.stderr)
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


@dataclass
class ExtractedTitle:
    """Represents an extracted title with metadata"""
    text: str
    page: int
    confidence: str  # 'high', 'medium', 'low'
    method: str      # 'structure', 'heuristic', 'header'
    font_size: Optional[float] = None
    is_bold: Optional[bool] = None


class PdfExtractor:
    """Extracts task titles from scanned PDF using docling (OCR)"""

    def __init__(self, verbose: bool = False, debug: bool = False):
        self.verbose = verbose
        self.debug = debug
        self.converter = DocumentConverter()

    def extract_titles(self, pdf_path: str, tasks: Optional[List[Task]] = None) -> List[str]:
        """Extract bold titles from scanned PDF using multiple strategies"""
        if not os.path.exists(pdf_path):
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")

        if self.verbose:
            print(f"Processing scanned PDF with docling: {pdf_path}")
            print("(This may take a while on first run while downloading models...)")

        # Convert PDF with docling
        result = self.converter.convert(pdf_path)

        if self.verbose:
            print("PDF converted successfully")

        # Get structured document representation
        doc_dict = result.document.export_to_dict()

        if self.debug:
            self._debug_document_structure(doc_dict)

        # Strategy 1: Extract from document structure (bold text, font sizes)
        titles_from_structure = self._extract_from_structure(doc_dict)

        if self.debug:
            print(f"\n[DEBUG] Extracted {len(titles_from_structure)} titles from structure")
            for title in titles_from_structure:
                print(f"  - {title.text} (page {title.page}, {title.method}, confidence={title.confidence})")

        # Strategy 2: Apply heuristics to detect title-like text
        titles_from_heuristics = self._extract_with_heuristics(doc_dict)

        if self.debug:
            print(f"\n[DEBUG] Extracted {len(titles_from_heuristics)} titles from heuristics")
            for title in titles_from_heuristics:
                print(f"  - {title.text} (page {title.page}, {title.method}, confidence={title.confidence})")

        # Merge and deduplicate
        all_extracted = self._merge_extracted_titles(titles_from_structure, titles_from_heuristics)

        if self.debug:
            print(f"\n[DEBUG] After merge: {len(all_extracted)} unique titles")

        # Validate against known tasks if provided (filter false positives)
        if tasks:
            validated = self._validate_against_tasks(all_extracted, tasks)
            if self.debug:
                filtered_count = len(all_extracted) - len(validated)
                if filtered_count > 0:
                    print(f"\n[DEBUG] Filtered out {filtered_count} low-confidence items (likely notes)")
        else:
            validated = all_extracted

        # Extract just the text
        titles = [t.text for t in validated]

        if self.verbose:
            print(f"\nExtracted {len(titles)} title(s)")

        return titles

    def _debug_document_structure(self, doc_dict: Dict[str, Any]):
        """Print document structure for debugging"""
        print("\n[DEBUG] Document Structure:")
        print("=" * 60)

        # Show main structure keys
        print(f"Keys: {list(doc_dict.keys())}")

        # Show page count
        if 'pages' in doc_dict:
            print(f"Pages: {len(doc_dict['pages'])}")

        # Show first few text elements with labels
        if 'texts' in doc_dict:
            print(f"\nTotal text elements: {len(doc_dict['texts'])}")
            print("\nFirst 10 text elements:")
            for i, elem in enumerate(doc_dict['texts'][:10]):
                text = elem.get('text', '')[:80]
                label = elem.get('label', '')
                prov = elem.get('prov', [])
                page = prov[0].get('page_no', 0) if prov else 0
                print(f"  {i+1}. [page {page}, label={label}] {text}")

        print("=" * 60)

    def _extract_from_structure(self, doc_dict: Dict[str, Any]) -> List[ExtractedTitle]:
        """Extract titles from docling's structured document representation"""
        titles = []

        # Docling uses 'texts' array with 'label' field
        if 'texts' in doc_dict:
            for item in doc_dict['texts']:
                text = item.get('text', '').strip()
                if not text or len(text) < 4:
                    continue

                # Get label and page info
                label = item.get('label', '')
                prov = item.get('prov', [])
                page_no = prov[0].get('page_no', 0) if prov else 0

                # Look for section headers (these are titles)
                if label == 'section_header':
                    titles.append(ExtractedTitle(
                        text=text,
                        page=page_no,
                        confidence='high',
                        method='structure',
                        is_bold=True
                    ))
                    if self.debug:
                        print(f"[DEBUG] Found section_header on page {page_no}: {text}")

        return titles

    def _extract_with_heuristics(self, doc_dict: Dict[str, Any]) -> List[ExtractedTitle]:
        """Apply heuristics to detect title-like text patterns"""
        titles = []

        # Get all text content from 'texts' array
        all_text = doc_dict.get('texts', [])

        # Group by pages
        pages = {}
        for item in all_text:
            text = item.get('text', '').strip()
            label = item.get('label', '')
            prov = item.get('prov', [])
            page_num = prov[0].get('page_no', 0) if prov else 0

            if page_num not in pages:
                pages[page_num] = []
            pages[page_num].append({
                'text': text,
                'label': label,
                'prov': prov
            })

        # Analyze each page for title patterns
        for page_num, items in pages.items():
            # Look for standalone short text at top of page
            for i, item in enumerate(items):
                text = item['text']

                if not text or len(text) < 4:
                    continue

                # Skip if already extracted as structure
                if item['label'] == 'section_header':
                    continue

                # Heuristic: Short line (< 150 chars), followed by longer text or blank
                is_short = len(text) < 150
                is_top_of_page = i < 3

                # Check if followed by longer text (explanation/notes)
                has_explanation = False
                if i + 1 < len(items):
                    next_text = items[i + 1]['text']
                    if next_text and len(next_text) > len(text) * 1.5:
                        has_explanation = True

                # Title-like: short, at top, followed by explanation
                if is_short and (is_top_of_page or has_explanation):
                    # Additional check: looks like a task title
                    # (starts with capital, has verb/noun words, etc.)
                    if self._looks_like_title(text):
                        confidence = 'high' if is_top_of_page else 'medium'
                        titles.append(ExtractedTitle(
                            text=text,
                            page=page_num,
                            confidence=confidence,
                            method='heuristic'
                        ))

        return titles

    def _looks_like_title(self, text: str) -> bool:
        """Check if text looks like a task title using heuristics"""
        # Too short or too long
        if len(text) < 4 or len(text) > 200:
            return False

        # Should start with capital or special char (like emoji, #, etc)
        if not (text[0].isupper() or not text[0].isalpha()):
            return False

        # Probably not a title if it ends with these
        if text.endswith((':', ',', ';')):
            return False

        # Common title patterns (verb at start, action words, etc)
        title_patterns = [
            r'^(Add|Fix|Update|Review|Implement|Create|Delete|Remove|Test|Deploy|Build|Research|Read|Buy|Clean|Write)',
            r'^[A-Z]{2,}:',  # URGENT:, TODO:, etc
            r'\d+',          # Contains numbers (versions, IDs, etc)
        ]

        for pattern in title_patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return True

        # Default: if it's reasonably short and starts with capital, likely a title
        return len(text) < 100

    def _merge_extracted_titles(self, *title_lists: List[ExtractedTitle]) -> List[ExtractedTitle]:
        """Merge and deduplicate extracted titles from multiple strategies"""
        seen_texts = {}
        merged = []

        # Flatten all lists
        all_titles = []
        for title_list in title_lists:
            all_titles.extend(title_list)

        # Sort by page, then confidence
        confidence_order = {'high': 0, 'medium': 1, 'low': 2}
        all_titles.sort(key=lambda t: (t.page, confidence_order.get(t.confidence, 3)))

        # Deduplicate
        for title in all_titles:
            # Normalize for comparison
            normalized = title.text.lower().strip()

            # If we've seen very similar text, skip
            if normalized in seen_texts:
                # Keep the higher confidence one
                existing = seen_texts[normalized]
                if confidence_order.get(title.confidence, 3) < confidence_order.get(existing.confidence, 3):
                    # Replace with higher confidence
                    merged.remove(existing)
                    merged.append(title)
                    seen_texts[normalized] = title
                continue

            seen_texts[normalized] = title
            merged.append(title)

        return merged

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
                print(f"[DEBUG] Filtered out (low match): {title.text} (best match: {best_match.score if best_match else 0:.0%})")

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

        matches = []

        # Strategy 1: Token sort ratio (handles word reordering)
        for task in tasks:
            score = fuzz.token_sort_ratio(query.lower(), task.title.lower()) / 100.0
            matches.append((task, score, 'token_sort'))

        # Strategy 2: Partial ratio (finds best substring match)
        for task in tasks:
            score = fuzz.partial_ratio(query.lower(), task.title.lower()) / 100.0
            matches.append((task, score, 'partial'))

        # Strategy 3: Token set ratio (handles extra/missing words)
        for task in tasks:
            score = fuzz.token_set_ratio(query.lower(), task.title.lower()) / 100.0
            matches.append((task, score, 'token_set'))

        # Group by task and take max score
        task_scores = {}
        for task, score, method in matches:
            if task.uuid not in task_scores or score > task_scores[task.uuid][1]:
                task_scores[task.uuid] = (task, score, method)

        # Convert to Match objects
        match_objects = [
            Match(task.uuid, task.title, score)
            for task, score, method in task_scores.values()
        ]

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


def prompt_user_selection(matches: List[Match], query: str) -> Optional[Match]:
    """Prompt user to select from multiple matches"""
    print(f"\nMultiple matches found for \"{query}\":")
    for i, match in enumerate(matches, 1):
        print(f"  {i}. {match.title} ({int(match.score * 100)}%)")

    while True:
        try:
            response = input(f"Select match (1-{len(matches)}, s to skip): ").strip().lower()

            if response == 's':
                return None

            choice = int(response)
            if 1 <= choice <= len(matches):
                return matches[choice - 1]
            else:
                print(f"Please enter a number between 1 and {len(matches)}, or 's' to skip")
        except ValueError:
            print(f"Please enter a number between 1 and {len(matches)}, or 's' to skip")
        except (EOFError, KeyboardInterrupt):
            print()
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

        display_matches(matches, title, args.threshold, args.verbose, args.non_interactive)

        if len(titles) > 1:
            print()


def display_matches(matches: List[Match], query: str, threshold: float, verbose: bool, non_interactive: bool):
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
        if non_interactive:
            # Use best match
            match = high_confidence[0]
            print(f"things:///show?id={match.uuid}")
            if verbose:
                print(f"  {int(match.score * 100)}% - \"{match.title}\" (best of {len(high_confidence)} matches)")
        else:
            # Interactive selection
            selected = prompt_user_selection(high_confidence, query)
            if selected:
                print(f"things:///show?id={selected.uuid}")
            else:
                print("Skipped")
    else:
        # No high-confidence matches
        print("No high-confidence matches. Top candidates:")
        for match in matches:
            print(f"  things:///show?id={match.uuid} ({int(match.score * 100)}% - \"{match.title}\")")


if __name__ == "__main__":
    main()
