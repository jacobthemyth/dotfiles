from papersync.integrations.things import auth


class FakeStore:
    def __init__(self) -> None:
        self.data: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, account: str) -> str | None:
        return self.data.get((service, account))

    def set_password(self, service: str, account: str, value: str) -> None:
        self.data[(service, account)] = value


def test_prompts_and_stores_when_missing() -> None:
    store = FakeStore()
    token = auth.get_token(prompt=lambda _msg: "  secret \n", store=store)
    assert token == "secret"
    assert store.data[(auth.SERVICE, auth.ACCOUNT)] == "secret"
    assert auth.get_token(prompt=lambda _m: "never", store=store) == "secret"


def test_set_token_overwrites() -> None:
    store = FakeStore()
    auth.set_token("a", store=store)
    auth.set_token("b", store=store)
    assert auth.get_token(prompt=lambda _m: "x", store=store) == "b"
