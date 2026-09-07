import getpass
from collections.abc import Callable
from typing import Any

import keyring

SERVICE = "papersync"
ACCOUNT = "things-auth-token"


def get_token(prompt: Callable[[str], str] = getpass.getpass, store: Any = keyring) -> str:
    token = store.get_password(SERVICE, ACCOUNT)
    if token:
        return token
    token = prompt(
        "Things URL scheme auth token (Things > Settings > General > Enable Things URLs > Manage): "
    ).strip()
    if not token:
        raise SystemExit("no token entered")
    store.set_password(SERVICE, ACCOUNT, token)
    return token


def set_token(token: str, store: Any = keyring) -> None:
    store.set_password(SERVICE, ACCOUNT, token.strip())
