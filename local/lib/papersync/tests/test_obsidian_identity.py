import json

import pytest

from papersync.integrations.obsidian import identity as I  # noqa: N812
from papersync.integrations.obsidian.cli import ObsidianCli


def _cli(runner):
    return ObsidianCli("Notes", runner=runner)


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch) -> list[float]:
    """The read-back retry must not put real seconds into the suite."""
    slept: list[float] = []
    monkeypatch.setattr(I, "sleep", slept.append)
    return slept


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


def test_ensure_id_raises_identity_error_when_the_read_back_property_is_missing() -> None:
    """property:set can be a silent no-op; property:read then answers with an error.

    ObsidianCli.call turns that reply into an ObsidianError. It must be
    caught and re-raised as the spec-mandated IdentityError naming the note
    path, not surfaced as a bare CLI error with no path in it.
    """

    def runner(args: list[str]) -> str:
        command = args[1]
        if command == "search":
            return "No matches found."
        if command == "property:set":
            return "Set papersync-id: whatever"
        if command == "property:read":
            return 'Error: Property "papersync-id" not found.'
        raise AssertionError(f"unexpected command {command}")

    with pytest.raises(I.IdentityError, match=r"Notes/Alpha\.md but read back"):
        I.ensure_id(_cli(runner), "Notes/Alpha.md", {})


def test_ensure_id_coerces_a_non_string_existing_value_instead_of_reminting() -> None:
    """A papersync-id that comes back as a number, not a string, must still be reused.

    An all-digit id returned as a number by a lenient JSON/YAML reader must
    not be silently re-minted -- that would replace the note's durable id.
    """
    calls: list[list[str]] = []
    cli = _cli(lambda args: calls.append(args) or "unreachable")
    got = I.ensure_id(cli, "Notes/Alpha.md", {"papersync-id": 123456789012})
    assert got == "123456789012"
    assert calls == []


class _Minting:
    """A fake vault where every candidate id is free unless told otherwise."""

    def __init__(
        self,
        collide_first: int = 0,
        read_back_value: str | None = None,
        read_back_misses: int = 0,
    ) -> None:
        self.collide_first = collide_first
        self.read_back_value = read_back_value
        # How many reads answer as Obsidian does before it has flushed the
        # write: the property is simply not there yet.
        self.read_back_misses = read_back_misses
        self.searched: list[str] = []
        self.written: str = ""
        self.set_calls = 0
        self.read_calls = 0
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
            self.read_calls += 1
            if self.read_calls <= self.read_back_misses:
                return 'Error: Property "papersync-id" not found.'
            self.read_back = self.read_back_value or self.written
            return self.read_back
        raise AssertionError(f"unexpected command {command}")


def test_ensure_id_mints_rather_than_reusing_a_boolean_property() -> None:
    """`papersync-id: false` is not an id, so it must not become the string "False".

    A bool is an int in Python, so a coercion broad enough to rescue a numeric
    id will happily stringify a bool unless it is rejected first.
    """
    minted = _Minting()
    got = I.ensure_id(_cli(minted), "Notes/Alpha.md", {"papersync-id": False})
    assert got == minted.written
    assert len(got) == I.ID_LENGTH
    assert minted.set_calls == 1


def test_the_read_back_retries_until_the_write_becomes_visible() -> None:
    """property:set returns before Obsidian flushes, so the first read can be early.

    A single-shot read-back reported a write as failed and skipped a note that
    did in fact carry the id a moment later.
    """
    minted = _Minting(read_back_misses=2)
    got = I.ensure_id(_cli(minted), "Notes/Alpha.md", {})
    assert got == minted.written
    assert minted.read_calls == 3
    assert minted.set_calls == 1


def test_the_read_back_gives_up_after_the_last_attempt(_no_real_sleep) -> None:
    minted = _Minting(read_back_misses=I.READ_BACK_ATTEMPTS)
    with pytest.raises(I.IdentityError, match="read back"):
        I.ensure_id(_cli(minted), "Notes/Alpha.md", {})
    assert minted.read_calls == I.READ_BACK_ATTEMPTS
    assert len(_no_real_sleep) == I.READ_BACK_ATTEMPTS - 1
