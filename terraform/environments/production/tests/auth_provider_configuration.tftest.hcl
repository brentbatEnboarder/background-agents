mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "test-source-hash"
      }
    }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token             = "test-cloudflare-token"
  cloudflare_account_id            = "test-account"
  cloudflare_worker_subdomain      = "test-account"
  github_app_id                    = "1"
  github_app_private_key           = "test-private-key"
  github_app_installation_id       = "1"
  anthropic_api_key                = "test-anthropic-key"
  token_encryption_key             = "test-token-key"
  repo_secrets_encryption_key      = "test-repo-key"
  provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
  nextauth_secret                  = "test-browser-auth-secret-with-32-characters"
  deployment_name                  = "auth-provider-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  project_root = "../../../"

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "github_only" {
  command = plan

  assert {
    condition     = module.modal_app[0].app_name == "open-inspect-auth-provider-test"
    error_message = "The Modal app name must be namespaced by deployment_name."
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["MODAL_APP_NAME"] == module.modal_app[0].app_name
    error_message = "The control plane must use the exact deployment-specific Modal app name."
  }

  assert {
    condition = (
      var.web_platform == "cloudflare" &&
      var.app_name == "Enboarder CS Agent" &&
      var.modal_environment == "cs" &&
      var.modal_environment_web_suffix == "cs" &&
      !var.enable_slack_bot &&
      !var.enable_github_bot &&
      !var.enable_linear_bot &&
      !var.enable_control_plane_cron_triggers &&
      !var.enable_durable_object_bindings &&
      !var.enable_service_bindings
    )
    error_message = "The CS foundation must default to Cloudflare, the CS Modal environment, and disabled optional bots and cron triggers."
  }

  assert {
    condition     = local.github_oauth_enabled && !local.google_enabled
    error_message = "GitHub-only credentials must enable only GitHub."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "GITHUB_CLIENT_ID") &&
      !contains(module.control_plane_worker.plain_text_binding_names, "GOOGLE_CLIENT_ID") &&
      contains(module.control_plane_worker.secret_binding_names, "GITHUB_CLIENT_SECRET") &&
      !contains(module.control_plane_worker.secret_binding_names, "GOOGLE_CLIENT_SECRET")
    )
    error_message = "The control plane must bind only the enabled GitHub OAuth credential pair."
  }

  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "PROVIDER_ACCOUNTS_ENCRYPTION_KEY")
    error_message = "The control plane must bind the provider account credential encryption key."
  }

  assert {
    condition = (
      length(module.control_plane_worker.durable_object_binding_names) == 0 &&
      length(module.control_plane_worker.service_binding_names) == 0 &&
      module.control_plane_worker.migration_present &&
      !strcontains(local_file.web_app_wrangler_production[0].content, "CONTROL_PLANE_WORKER")
    )
    error_message = "Phase one must emit the Durable Object migration without Durable Object or service bindings, including the web Worker binding."
  }

  assert {
    condition     = nonsensitive(local.effective_provider_accounts_encryption_key) == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
    error_message = "An operator-provided provider account key must remain unchanged."
  }
}

run "phase_two_bindings" {
  command = plan

  variables {
    enable_durable_object_bindings = true
    enable_service_bindings        = true
    enable_slack_bot               = true
    slack_bot_token                = "test-slack-token"
    slack_signing_secret           = "test-slack-signing-secret"
    slack_app_id                   = "A123"
    slack_team_id                  = "T123"
    slack_allowed_user_ids         = "U123"
    slack_allowed_channel_ids      = "C123"
  }

  assert {
    condition = (
      length(module.control_plane_worker.durable_object_binding_names) == 1 &&
      module.control_plane_worker.durable_object_binding_names[0] == "SESSION" &&
      length(module.control_plane_worker.service_binding_names) == 1 &&
      module.control_plane_worker.service_binding_names[0] == "SLACK_BOT" &&
      strcontains(local_file.web_app_wrangler_production[0].content, "CONTROL_PLANE_WORKER") &&
      !module.control_plane_worker.migration_present
    )
    error_message = "Phase two must enable the Durable Object and web service bindings without replaying the initial migration."
  }
}

run "phase_one_omits_configured_service_bindings" {
  command = plan

  variables {
    enable_slack_bot          = true
    slack_bot_token           = "test-slack-token"
    slack_signing_secret      = "test-slack-signing-secret"
    slack_app_id              = "A123"
    slack_team_id             = "T123"
    slack_allowed_user_ids    = "U123"
    slack_allowed_channel_ids = "C123"
  }

  assert {
    condition = (
      length(module.control_plane_worker.durable_object_binding_names) == 0 &&
      length(module.control_plane_worker.service_binding_names) == 0 &&
      module.control_plane_worker.migration_present &&
      !strcontains(local_file.web_app_wrangler_production[0].content, "CONTROL_PLANE_WORKER")
    )
    error_message = "Phase one must omit configured service targets until the binding gates are enabled."
  }
}

run "reject_blank_app_name" {
  command = plan

  variables {
    app_name = "   "
  }

  expect_failures = [var.app_name]
}

run "reject_empty_deployment_name" {
  command = plan

  variables {
    deployment_name = ""
  }

  expect_failures = [var.deployment_name]
}

run "reject_unsafe_deployment_name" {
  command = plan

  variables {
    deployment_name = "CS/production"
  }

  expect_failures = [var.deployment_name]
}

run "reject_overlong_deployment_name" {
  command = plan

  variables {
    deployment_name = "this-deployment-name-is-more-than-thirty-six-characters"
  }

  expect_failures = [var.deployment_name]
}

run "terraform_generated_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = ""
  }

  override_resource {
    target          = random_bytes.provider_accounts_encryption_key
    override_during = plan
    values = {
      base64 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
    }
  }

  assert {
    condition = (
      nonsensitive(local.effective_provider_accounts_encryption_key) == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" &&
      length(base64decode(nonsensitive(local.effective_provider_accounts_encryption_key))) == 32
    )
    error_message = "Terraform must generate a Base64-encoded 32-byte provider account key."
  }
}

run "reject_malformed_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!="
  }

  expect_failures = [var.provider_accounts_encryption_key]
}

run "reject_31_byte_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZQ=="
  }

  expect_failures = [var.provider_accounts_encryption_key]
}

run "reject_33_byte_provider_account_key" {
  command = plan

  variables {
    provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYw"
  }

  expect_failures = [var.provider_accounts_encryption_key]
}

run "vercel_github_only" {
  command = plan

  variables {
    web_platform     = "vercel"
    vercel_api_token = "test-vercel-token"
    vercel_team_id   = "test-vercel-team"
  }

  assert {
    condition = (
      output.web_app_url == module.web_app[0].production_url &&
      strcontains(
        nonsensitive(output.verification_commands),
        "curl ${module.web_app[0].production_url}"
      )
    )
    error_message = "Web verification must use the effective Vercel production URL."
  }
}

run "google_only" {
  command = plan

  variables {
    github_client_id     = ""
    github_client_secret = ""
    google_client_id     = "google-id"
    google_client_secret = "google-secret"
    allowed_users        = ""
    allowed_emails       = "person@example.com"
  }

  assert {
    condition     = !local.github_oauth_enabled && local.google_enabled
    error_message = "Google-only credentials must enable only Google."
  }

  assert {
    condition = (
      !contains(module.control_plane_worker.plain_text_binding_names, "GITHUB_CLIENT_ID") &&
      contains(module.control_plane_worker.plain_text_binding_names, "GOOGLE_CLIENT_ID") &&
      !contains(module.control_plane_worker.secret_binding_names, "GITHUB_CLIENT_SECRET") &&
      contains(module.control_plane_worker.secret_binding_names, "GOOGLE_CLIENT_SECRET")
    )
    error_message = "The control plane must bind only the enabled Google OAuth credential pair."
  }
}

run "github_and_google" {
  command = plan

  variables {
    google_client_id     = "google-id"
    google_client_secret = "google-secret"
    allowed_emails       = "person@example.com"
  }

  assert {
    condition     = local.github_oauth_enabled && local.google_enabled
    error_message = "Complete GitHub and Google credentials must enable both providers."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "GITHUB_CLIENT_ID") &&
      contains(module.control_plane_worker.plain_text_binding_names, "GOOGLE_CLIENT_ID") &&
      contains(module.control_plane_worker.secret_binding_names, "GITHUB_CLIENT_SECRET") &&
      contains(module.control_plane_worker.secret_binding_names, "GOOGLE_CLIENT_SECRET")
    )
    error_message = "The control plane must bind both enabled OAuth credential pairs."
  }
}

run "no_provider" {
  command = plan

  variables {
    github_client_id     = ""
    github_client_secret = ""
  }

  expect_failures = [terraform_data.sign_in_provider_gate]
}

run "partial_github_pair" {
  command = plan

  variables {
    github_client_id     = "  "
    github_client_secret = "github-secret"
  }

  expect_failures = [var.github_client_id]
}

run "partial_google_pair" {
  command = plan

  variables {
    google_client_id     = "google-id"
    google_client_secret = "  "
  }

  expect_failures = [var.google_client_id]
}

run "google_with_github_only_admission" {
  command = plan

  variables {
    github_client_id     = ""
    github_client_secret = ""
    google_client_id     = "google-id"
    google_client_secret = "google-secret"
  }

  expect_failures = [terraform_data.sign_in_provider_gate]
}

run "combined_with_github_only_admission" {
  command = plan

  variables {
    google_client_id     = "google-id"
    google_client_secret = "google-secret"
  }

  expect_failures = [terraform_data.sign_in_provider_gate]
}

run "anthropic_api_key_blank" {
  command = plan

  variables {
    enable_slack_bot          = true
    slack_bot_token           = "test-slack-token"
    slack_signing_secret      = "test-slack-signing-secret"
    slack_app_id              = "A123"
    slack_team_id             = "T123"
    slack_allowed_user_ids    = "U123"
    slack_allowed_channel_ids = "C123"
    anthropic_api_key         = ""
  }

  expect_failures = [var.anthropic_api_key]
}
