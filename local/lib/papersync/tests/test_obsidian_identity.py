import json

import pytest

from papersync.integrations.obsidian import identity as I  # noqa: N812
from papersync.integrations.obsidian.cli import ObsidianCli


def _cli(runner):
    return ObsidianCli("Notes", runner=runner)


def test_new_id_has_the_right_shape() -> None:
    for _ in range(50):
        value = I.new_id()
        assert len(value) == I.ID_LENGTH
        assert set(value) <= set(I.ALPHABET)


def test_new_id_avoids_the_ambiguous_letters() -> None:
    assert set("ilou") & set(I.ALPHABET) == set()


def test_new_ids_do_not_repeat() -> None:
    assert len({I.new_id() for _ in range(1000)}) == 1000


def test_search_paths_treats_no_matches_as_an_empty_list() -> None:
    """The CLI answers a search with no hits in prose, not JSON, and not an error."""
    cli = _cli(lambda args: "No matches found.")
    assert I.search_paths(cli, "anything") == []


def test_search_paths_returns_only_markdown_paths() -> None:
    cli = _cli(lambda args: json.dumps(["a.md", "b.canvas", {"path": "c.md"}]))
    assert I.search_paths(cli, "q") == ["a.md", "c.md"]


def test_paths_in_reads_bare_and_object_rows_and_drops_non_markdown() -> None:
    assert I.paths_in(["a.md"]) == ["a.md"]
    assert I.paths_in([{"path": "a.md"}]) == ["a.md"]
    assert I.paths_in(["a.md", "b.canvas", {"path": "c.md"}, {"path": "d.canvas"}]) == [
        "a.md",
        "c.md",
    ]


def test_find_queries_by_property_value() -> None:
    seen: list[list[str]] = []

    def runner(args: list[str]) -> str:
        seen.append(args)
        return json.dumps(["Notes/Alpha.md"])

    assert I.find(_cli(runner), "k7m2q9xr4tb8") == ["Notes/Alpha.md"]
    assert 'query=["papersync-id":"k7m2q9xr4tb8"]' in seen[0]
    assert "format=json" in seen[0]


def test_ensure_id_reuses_an_existing_property_without_writing() -> None:
    calls: list[list[str]] = []
    cli = _cli(lambda args: calls.append(args) or "unreachable")
    got = I.ensure_id(cli, "Notes/Alpha.md", {"papersync-id": "abcdefghjkmn"})
    assert got == "abcdefghjkmn"
    assert calls == []


def test_ensure_id_ignores_an_empty_property_and_mints() -> None:
    minted = _Minting()
    got = I.ensure_id(_cli(minted), "Notes/Alpha.md", {"papersync-id": ""})
    assert got == minted.written
    assert minted.set_calls == 1


def test_ensure_id_mints_sets_and_reads_back() -> None:
    minted = _Minting()
    got = I.ensure_id(_cli(minted), "Notes/Alpha.md", {})
    assert len(got) == I.ID_LENGTH
    assert minted.set_calls == 1
    assert minted.searched  # collision check ran before the write
    assert minted.read_back == got


def test_ensure_id_retries_when_the_first_candidate_collides() -> None:
    minted = _Minting(collide_first=1)
    got = I.ensure_id(_cli(minted), "Notes/Alpha.md", {})
    assert got == minted.written
    assert len(minted.searched) == 2
    assert minted.set_calls == 1


def test_ensure_id_gives_up_after_five_collisions() -> None:
    minted = _Minting(collide_first=I.MINT_ATTEMPTS)
    with pytest.raises(I.IdentityError, match="after 5 attempts"):
        I.ensure_id(_cli(minted), "Notes/Alpha.md", {})
    assert minted.set_calls == 0


def test_ensure_id_raises_when_the_write_does_not_stick() -> None:
    minted = _Minting(read_back_value="something-else")
    with pytest.raises(I.IdentityError, match="read back"):
        I.ensure_id(_cli(minted), "Notes/Alpha.md", {})


class _Minting:
    """A fake vault where every candidate id is free unless told otherwise."""

    def __init__(self, collide_first: int = 0, read_back_value: str | None = None) -> None:
        self.collide_first = collide_first
        self.read_back_value = read_back_value
        self.searched: list[str] = []
        self.written: str = ""
        self.set_calls = 0
        self.read_back: str = ""

    def __call__(self, args: list[str]) -> str:
        command = args[1]
        params = dict(a.split("=", 1) for a in args[2:] if "=" in a)
        if command == "search":
            self.searched.append(params["query"])
            if len(self.searched) <= self.collide_first:
                return json.dumps(["Someone/Else.md"])
            return "No matches found."
        if command == "property:set":
            self.set_calls += 1
            self.written = params["value"]
            return f"Set papersync-id: {params['value']}"
        if command == "property:read":
            self.read_back = self.read_back_value or self.written
            return self.read_back
        raise AssertionError(f"unexpected command {command}")
