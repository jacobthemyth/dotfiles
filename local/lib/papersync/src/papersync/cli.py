import click

from papersync import __version__


@click.group()
@click.version_option(__version__, prog_name="papersync")
def main() -> None:
    """Print Things items to index cards and scan them back."""


if __name__ == "__main__":
    main()
