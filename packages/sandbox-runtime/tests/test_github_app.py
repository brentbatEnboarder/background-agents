from unittest.mock import Mock

import httpx
import pytest

from sandbox_runtime.auth.github_app import get_installation_token


@pytest.mark.parametrize("payload", [{"token": 123}, [], None])
def test_get_installation_token_rejects_non_string_json_token(
    monkeypatch: pytest.MonkeyPatch, payload: object
) -> None:
    response = Mock()
    response.json.return_value = payload
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=None)
    client.post.return_value = response
    monkeypatch.setattr(httpx, "Client", Mock(return_value=client))

    with pytest.raises(ValueError, match="GitHub installation token response"):
        get_installation_token("jwt", "installation")

    response.raise_for_status.assert_called_once_with()
