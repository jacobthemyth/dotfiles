import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE TMTask (uuid TEXT PRIMARY KEY, creationDate REAL, type INTEGER, status INTEGER,
  stopDate REAL, trashed INTEGER, title TEXT, notes TEXT, start INTEGER, startDate INTEGER,
  deadline INTEGER, area TEXT, project TEXT);
CREATE TABLE TMTag (uuid TEXT PRIMARY KEY, title TEXT);
CREATE TABLE TMTaskTag (tasks TEXT NOT NULL, tags TEXT NOT NULL);
"""


def make_db(path: Path) -> Path:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    rows = [
        ("P1", 1.0, 1, 0, None, 0, "Project One", "", 1, None, None, None, None),
        ("T1", 2.0, 0, 0, None, 0, "FOO", "", 0, None, None, None, None),
        ("T2", 3.0, 0, 0, None, 0, "BAR", "BAZ", 1, None, None, None, "P1"),
        ("T3", 4.0, 0, 0, None, 0, "Someday thing", "", 2, None, None, None, None),
        ("T4", 5.0, 0, 3, 6.0, 0, "Done thing", "", 1, None, None, None, None),
        ("T5", 6.0, 0, 0, None, 1, "Trashed", "", 0, None, None, None, None),
        (
            "T6",
            7.0,
            0,
            0,
            None,
            0,
            "Dated",
            "",
            1,
            (2026 << 16) | (9 << 12) | (7 << 7),
            (2026 << 16) | (9 << 12) | (10 << 7),
            None,
            None,
        ),
    ]
    conn.executemany("INSERT INTO TMTask VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.executemany(
        "INSERT INTO TMTag VALUES (?,?)",
        [("G1", "waiting"), ("G2", "papersync:meta:A"), ("G3", "papersync:scanned")],
    )
    conn.executemany(
        "INSERT INTO TMTaskTag VALUES (?,?)",
        [("T2", "G1"), ("T1", "G2"), ("T1", "G3"), ("T4", "G3"), ("T6", "G3")],
    )
    conn.commit()
    conn.close()
    return path
