import os
import tomllib
from pathlib import Path

from pydantic import BaseModel, Field


class Action(BaseModel):
    tags: list[str] = Field(default_factory=list)
    when: str | None = None
    deadline: str | None = None
    list: str | None = None
    completed: bool | None = None
    canceled: bool | None = None


class RenderConfig(BaseModel):
    size: str = "auto"
    overflow: str = "fail"
    boxes: list[str] = Field(default_factory=lambda: ["A", "B", "C", "D"])
    output_dir: str = "."
    open: bool = True
    tag: bool = True


class ThingsConfig(BaseModel):
    actions: dict[str, Action] = Field(default_factory=dict)


class Config(BaseModel):
    render: RenderConfig = Field(default_factory=RenderConfig)
    things: ThingsConfig = Field(default_factory=ThingsConfig)


def _xdg(var: str, default: str) -> Path:
    return Path(os.environ.get(var) or Path.home() / default) / "papersync"


def config_dir() -> Path:
    return _xdg("XDG_CONFIG_HOME", ".config")


def state_dir() -> Path:
    return _xdg("XDG_STATE_HOME", ".local/state")


def load_config(path: Path | None = None) -> Config:
    path = path or config_dir() / "config.toml"
    if not path.exists():
        return Config()
    with path.open("rb") as fh:
        return Config.model_validate(tomllib.load(fh))
