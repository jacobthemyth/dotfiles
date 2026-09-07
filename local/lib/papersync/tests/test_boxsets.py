from pathlib import Path

from papersync.boxsets import BoxSetRegistry


def test_assigns_and_reuses_ids(tmp_path: Path) -> None:
    reg = BoxSetRegistry(tmp_path / "boxsets.toml")
    assert reg.id_for(["A", "B"]) == 1
    assert reg.id_for(["waiting", "today"]) == 2
    assert reg.id_for(["A", "B"]) == 1
    assert reg.labels_for(2) == ["waiting", "today"]
    assert reg.labels_for(9) is None


def test_persists_across_instances(tmp_path: Path) -> None:
    path = tmp_path / "boxsets.toml"
    BoxSetRegistry(path).id_for(["A"])
    again = BoxSetRegistry(path)
    assert again.labels_for(1) == ["A"]
    assert again.id_for(["B"]) == 2
    text = path.read_text()
    assert text.count("[[sets]]") == 2 and 'labels = ["A"]' in text


def test_never_rewrites_existing_set(tmp_path: Path) -> None:
    path = tmp_path / "boxsets.toml"
    path.write_text('[[sets]]\nid = 1\nlabels = ["A"]\ncreated = "2026-01-01T00:00:00Z"\n')
    reg = BoxSetRegistry(path)
    reg.id_for(["B"])
    assert path.read_text().startswith(
        '[[sets]]\nid = 1\nlabels = ["A"]\ncreated = "2026-01-01T00:00:00Z"\n'
    )
