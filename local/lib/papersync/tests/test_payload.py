import pytest

from papersync.payload import Payload, PayloadError


def test_single_page_url() -> None:
    p = Payload(version=1, source="things", ref="ABC", size="3x5", boxes=1)
    assert p.to_url() == "papersync:///v1/things/ABC?size=3x5&boxes=1"


def test_paginated_url_and_parse() -> None:
    p = Payload(version=1, source="things", ref="ABC", size="letter", boxes=2, page=2, pages=3)
    url = p.to_url()
    assert url == "papersync:///v1/things/ABC?size=letter&boxes=2&page=2&pages=3"
    assert Payload.parse(url) == p


def test_new_card() -> None:
    p = Payload.parse("papersync:///v1/things/new?size=3x5&boxes=1")
    assert p.is_new and p.page == 1 and p.pages == 1


@pytest.mark.parametrize(
    "bad",
    [
        "https://example.com",
        "papersync:///v9/things/ABC?size=3x5&boxes=1",
        "papersync:///v1/things/ABC?boxes=1",
        "papersync:///v1/things/ABC?size=3x5&boxes=x",
        "papersync:///v1/things?size=3x5&boxes=1",
    ],
)
def test_rejects(bad: str) -> None:
    with pytest.raises(PayloadError):
        Payload.parse(bad)


def test_longest_payload_fits_qr_version_5() -> None:
    p = Payload(version=1, source="things", ref="A" * 22, size="letter", boxes=1, page=10, pages=12)
    assert len(p.to_url().encode()) <= 84
