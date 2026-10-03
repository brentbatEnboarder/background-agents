output "worker_name" {
  description = "The name of the deployed worker"
  value       = cloudflare_worker.this.name
}

output "worker_id" {
  description = "The ID of the worker"
  value       = cloudflare_worker.this.id
}

output "version_id" {
  description = "The ID of the current worker version"
  value       = cloudflare_worker_version.this.id
}

output "deployment_id" {
  description = "The ID of the deployment"
  value       = cloudflare_workers_deployment.this.id
}

output "worker_url" {
  description = "The workers.dev URL for the worker: https://<worker_name>.<worker_subdomain>.workers.dev"
  value       = "https://${cloudflare_worker.this.name}.${var.worker_subdomain}.workers.dev"
}

output "custom_domain" {
  description = "The custom domain for the worker (if configured)"
  value       = var.custom_domain != null ? cloudflare_workers_custom_domain.this[0].hostname : null
}

output "plain_text_binding_names" {
  description = "Names of configured plain-text bindings."
  value       = [for binding in var.plain_text_bindings : binding.name]
}

output "plain_text_bindings" {
  description = "Configured plain-text bindings as a name => value map, so a configuration test can assert the value a binding actually carries."
  value       = { for binding in var.plain_text_bindings : binding.name => binding.value }
}

output "secret_binding_names" {
  description = "Names of configured secret bindings; secret values are not exposed."
  value       = nonsensitive([for binding in var.secrets : binding.name])
}

output "durable_object_binding_names" {
  description = "Names of effective Durable Object bindings."
  value       = var.enable_durable_object_bindings ? [for binding in var.durable_objects : binding.binding_name] : []
}

output "service_binding_names" {
  description = "Names of effective service bindings."
  value       = var.enable_service_bindings ? [for binding in var.service_bindings : binding.binding_name] : []
}

output "migration_present" {
  description = "Whether this Worker version emits a Durable Object migration."
  value       = (length(var.durable_objects) > 0 || length(var.deleted_classes) > 0) && (!var.enable_durable_object_bindings || length(var.deleted_classes) > 0)
}
