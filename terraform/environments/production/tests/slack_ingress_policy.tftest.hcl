mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = { hash = "test-source-hash" }
    }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  github_app_id               = "1"
  github_app_private_key      = "test-private-key"
  github_app_installation_id  = "1"
  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "slack-ingress-test"
  modal_token_id              = "test-modal-token-id"
  modal_token_secret          = "test-modal-token-secret"
  modal_workspace             = "test-workspace"
  modal_api_secret            = "test-modal-api-secret"
  web_platform                = "cloudflare"
  project_root                = "../../../"
  enable_github_bot           = false
  enable_slack_bot            = true
  slack_bot_token             = "xoxb-test"
  slack_signing_secret        = "test-signing-secret"
  slack_app_id                = "A123"
  slack_team_id               = "T123"
  slack_allowed_user_ids      = "U123,U456"
  slack_allowed_channel_ids   = "C123,G456"
  github_client_id            = "github-id"
  github_client_secret        = "github-secret"
  allowed_users               = "octocat"
}

run "binds_complete_non_secret_ingress_policy" {
  command = plan

  assert {
    condition = alltrue([
      for name in [
        "SLACK_APP_ID",
        "SLACK_TEAM_ID",
        "SLACK_ALLOWED_USER_IDS",
        "SLACK_ALLOWED_CHANNEL_IDS"
      ] : contains(module.slack_bot_worker[0].plain_text_binding_names, name)
    ])
    error_message = "The Slack Worker must receive every ingress policy value as a plain-text binding."
  }

  assert {
    condition = (
      module.slack_bot_worker[0].plain_text_bindings["SLACK_APP_ID"] == var.slack_app_id &&
      module.slack_bot_worker[0].plain_text_bindings["SLACK_TEAM_ID"] == var.slack_team_id &&
      module.slack_bot_worker[0].plain_text_bindings["SLACK_ALLOWED_USER_IDS"] == var.slack_allowed_user_ids &&
      module.slack_bot_worker[0].plain_text_bindings["SLACK_ALLOWED_CHANNEL_IDS"] == var.slack_allowed_channel_ids
    )
    error_message = "The Slack Worker ingress bindings must carry their configured policy values."
  }
}

run "omits_an_unconfigured_default_environment" {
  command = plan

  assert {
    condition     = !contains(module.slack_bot_worker[0].plain_text_binding_names, "SLACK_DEFAULT_ENVIRONMENT_ID")
    error_message = "The Slack Worker must omit the optional default environment binding when it is not configured."
  }
}

run "binds_a_configured_default_environment" {
  command = plan
  variables { slack_default_environment_id = "env_1c1ea5ad50ca4b2b17ed792195cfa8e1" }

  assert {
    condition     = module.slack_bot_worker[0].plain_text_bindings["SLACK_DEFAULT_ENVIRONMENT_ID"] == "env_1c1ea5ad50ca4b2b17ed792195cfa8e1"
    error_message = "The Slack Worker must receive the configured default environment ID."
  }
}

run "rejects_a_malformed_default_environment_id" {
  command = plan
  variables { slack_default_environment_id = "Narration" }
  expect_failures = [var.slack_default_environment_id]
}

run "rejects_missing_app_id" {
  command = plan
  variables { slack_app_id = "" }
  expect_failures = [var.slack_app_id]
}

run "rejects_missing_workspace_id" {
  command = plan
  variables { slack_team_id = "" }
  expect_failures = [var.slack_team_id]
}

run "rejects_malformed_user_allowlist" {
  command = plan
  variables { slack_allowed_user_ids = "U123,,U456" }
  expect_failures = [var.slack_allowed_user_ids]
}

run "rejects_malformed_channel_allowlist" {
  command = plan
  variables { slack_allowed_channel_ids = "marketing_engineering" }
  expect_failures = [var.slack_allowed_channel_ids]
}
