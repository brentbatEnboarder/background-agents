# Customer Success Terraform State Backend Configuration
# Uses a CS-only Cloudflare R2 bucket (S3-compatible storage)
#
# Prerequisites:
# 1. Create R2 bucket: wrangler r2 bucket create open-inspect-cs-terraform-state
# 2. Generate a CS-only R2 API token with read/write permissions for that bucket
# 3. Export the CS-only credentials as AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
# 4. Export AWS_ENDPOINT_URL_S3 for the account R2 endpoint and AWS_REGION=auto.
# 5. Run terraform init -reconfigure. Do not pass credentials through -backend-config;
#    Terraform caches backend arguments in local metadata and saved plans.

terraform {
  backend "s3" {
    bucket = "open-inspect-cs-terraform-state"
    key    = "production/terraform.tfstate"
    region = "auto"

    # R2 supports the conditional object operations used by S3 lockfiles. This must
    # still be verified against the CS bucket before the first provider-backed plan.
    use_lockfile = true

    # All sensitive/account-specific values are supplied through AWS_* environment
    # variables so Terraform does not persist credentials as backend arguments.

    # Required for R2 compatibility
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
