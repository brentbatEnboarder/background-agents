"""Deployment-scoped identity shared by Modal resources."""

import os
import re

DEPLOYMENT_NAME = os.environ.get("OPEN_INSPECT_DEPLOYMENT_NAME", "").strip()
if DEPLOYMENT_NAME and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", DEPLOYMENT_NAME):
    raise ValueError("OPEN_INSPECT_DEPLOYMENT_NAME must be a lowercase provider-safe slug")

_SUFFIX = f"-{DEPLOYMENT_NAME}" if DEPLOYMENT_NAME else ""

APP_NAME = f"open-inspect{_SUFFIX}"
LLM_SECRET_NAME = f"llm-api-keys{_SUFFIX}"
GITHUB_APP_SECRET_NAME = f"github-app{_SUFFIX}"
INTERNAL_API_SECRET_NAME = f"internal-api{_SUFFIX}"
