from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class Item(BaseModel):
    source: str
    ref: str
    title: str
    notes: str = ""


class BoxResult(BaseModel):
    fill: float
    checked: bool
    uncertain: bool


class Change(BaseModel):
    kind: Literal["update", "create"]
    source: str
    ref: str | None = None
    title: str
    complete: bool = False
    marks: list[str] = Field(default_factory=list)
    append_notes: str | None = None
    notes: str | None = None
    boxes: dict[str, BoxResult] = Field(default_factory=dict)
    pages: list[int] = Field(default_factory=list)


class PlanError(BaseModel):
    page: int
    message: str


class Plan(BaseModel):
    papersync_plan: Literal[1] = 1
    created: datetime
    inputs: list[str]
    changes: list[Change]
    errors: list[PlanError]

    def to_json(self) -> str:
        return self.model_dump_json(indent=2)

    @classmethod
    def from_json(cls, text: str) -> "Plan":
        return cls.model_validate_json(text)


def scanned_block(text: str, day: date) -> str:
    quoted = "\n".join(f"> {line}" for line in text.splitlines())
    return f"\n\n## Scanned {day.isoformat()}\n\n{quoted}"
