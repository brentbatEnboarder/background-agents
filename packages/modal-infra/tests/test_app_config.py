"""Deployment names isolate Modal resources within a shared workspace."""

import importlib.util
from pathlib import Path

import pytest


def load_app_config(monkeypatch, deployment_name: str | None):
    if deployment_name is None:
        monkeypatch.delenv("OPEN_INSPECT_DEPLOYMENT_NAME", raising=False)
    else:
        monkeypatch.setenv("OPEN_INSPECT_DEPLOYMENT_NAME", deployment_name)

    path = Path(__file__).parents[1] / "src/app_config.py"
    spec = importlib.util.spec_from_file_location("isolated_app_config", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_namespaces_modal_resources_by_deployment(monkeypatch) -> None:
    config = load_app_config(monkeypatch, "enboarder-cs")

    assert config.APP_NAME == "open-inspect-enboarder-cs"
    assert config.LLM_SECRET_NAME == "llm-api-keys-enboarder-cs"
    assert config.GITHUB_APP_SECRET_NAME == "github-app-enboarder-cs"
    assert config.INTERNAL_API_SECRET_NAME == "internal-api-enboarder-cs"


def test_preserves_default_names_without_a_deployment(monkeypatch) -> None:
    config = load_app_config(monkeypatch, None)

    assert config.APP_NAME == "open-inspect"
    assert config.LLM_SECRET_NAME == "llm-api-keys"
    assert config.GITHUB_APP_SECRET_NAME == "github-app"
    assert config.INTERNAL_API_SECRET_NAME == "internal-api"


def test_rejects_unsafe_deployment_name(monkeypatch) -> None:
    with pytest.raises(ValueError, match="lowercase provider-safe slug"):
        load_app_config(monkeypatch, "CS/production")
