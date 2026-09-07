from click.testing import CliRunner

from papersync.cli import main


def test_version() -> None:
    result = CliRunner().invoke(main, ["--version"])
    assert result.exit_code == 0
    assert "papersync" in result.output
