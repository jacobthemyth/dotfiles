from pydantic import BaseModel, Field

from papersync.config import Action, ThingsConfig
from papersync.model import Change

TAG_PREFIX = "papersync:meta:"


def default_tag(label: str) -> str:
    return f"{TAG_PREFIX}{label}"


class ThingsUpdate(BaseModel):
    completed: bool = False
    canceled: bool = False
    tags: list[str] = Field(default_factory=list)
    when: str | None = None
    deadline: str | None = None
    list: str | None = None


def resolve(change: Change, cfg: ThingsConfig) -> tuple[ThingsUpdate, list[str]]:
    upd = ThingsUpdate(completed=change.complete)
    owners: dict[str, str] = {}
    warnings: list[str] = []
    for label in change.marks:
        action = cfg.actions.get(label) or Action(tags=[default_tag(label)])
        for tag in action.tags:
            if tag not in upd.tags:
                upd.tags.append(tag)
        for field in ("when", "deadline", "list", "completed", "canceled"):
            value = getattr(action, field)
            if value is None:
                continue
            if field in owners:
                warnings.append(
                    f"'{label}' overrides {field}={getattr(upd, field)} set by '{owners[field]}'"
                )
            owners[field] = label
            setattr(upd, field, value)
    return upd, warnings
