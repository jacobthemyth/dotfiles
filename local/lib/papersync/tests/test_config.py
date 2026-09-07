from pathlib import Path

from papersync.config import config_dir, load_config, state_dir


def test_defaults_when_file_missing(tmp_path: Path) -> None:
    cfg = load_config(tmp_path / "missing.toml")
    assert cfg.render.size == "auto"
    assert cfg.render.boxes == ["A", "B", "C", "D"]
    assert cfg.things.actions == {}


def test_parses_actions(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text('[render]\nsize = "3x5"\n[things.actions]\ntoday = { when = "today" }\n')
    cfg = load_config(p)
    assert cfg.render.size == "3x5"
    assert cfg.things.actions["today"].when == "today"


def test_xdg_dirs(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("XDG_CONFIG_HOME", "/x/cfg")
    monkeypatch.setenv("XDG_STATE_HOME", "/x/state")
    assert config_dir() == Path("/x/cfg/papersync")
    assert state_dir() == Path("/x/state/papersync")
