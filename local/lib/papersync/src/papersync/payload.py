from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

SCHEME = "papersync:///"
NEW_REF = "new"
SUPPORTED_VERSIONS = {1}


class PayloadError(ValueError):
    pass


@dataclass(frozen=True)
class Payload:
    version: int
    source: str
    ref: str
    size: str
    boxes: int
    page: int = 1
    pages: int = 1

    @property
    def is_new(self) -> bool:
        return self.ref == NEW_REF

    def to_url(self) -> str:
        url = (
            f"{SCHEME}v{self.version}/{self.source}/{self.ref}?size={self.size}&boxes={self.boxes}"
        )
        if self.pages > 1:
            url += f"&page={self.page}&pages={self.pages}"
        return url

    @classmethod
    def parse(cls, text: str) -> "Payload":
        if not text.startswith(SCHEME):
            raise PayloadError(f"not a papersync URL: {text!r}")
        parts = urlsplit(text)
        segments = parts.path.strip("/").split("/")
        if len(segments) != 3 or not segments[0].startswith("v"):
            raise PayloadError(f"expected /v<n>/<source>/<ref>: {text!r}")
        try:
            version = int(segments[0][1:])
        except ValueError as exc:
            raise PayloadError(f"bad version in {text!r}") from exc
        if version not in SUPPORTED_VERSIONS:
            raise PayloadError(f"unsupported template version v{version}")
        query = {k: v[-1] for k, v in parse_qs(parts.query).items()}
        try:
            size = query["size"]
            boxes = int(query["boxes"])
            page = int(query.get("page", "1"))
            pages = int(query.get("pages", "1"))
        except (KeyError, ValueError) as exc:
            raise PayloadError(f"bad query in {text!r}: {exc}") from exc
        return cls(version, segments[1], segments[2], size, boxes, page, pages)
