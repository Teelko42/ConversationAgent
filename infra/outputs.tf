output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "vnet_id" {
  value = module.network.vnet_id
}

output "eventhub_name" {
  value = module.eventbus.eventhub_name
}

output "postgres_fqdn" {
  value = module.datastores.postgres_fqdn
}

output "container_app_environment_id" {
  value = module.compute.environment_id
}
