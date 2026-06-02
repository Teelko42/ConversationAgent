variable "name" { type = string }
variable "location" { type = string }
variable "resource_group_name" { type = string }
variable "vnet_cidr" { type = string }

# In Azure a subnet is regional (spans all zones in the region), so zone-spread is a
# property of the resources placed in it — not of the subnet. We carve three tiers:
#   public  (App Gateway / Front Door origin / NAT)
#   app     (Container Apps environment — delegated)
#   data    (PostgreSQL Flexible Server VNet injection — delegated)
resource "azurerm_virtual_network" "this" {
  name                = "${var.name}-vnet"
  location            = var.location
  resource_group_name = var.resource_group_name
  address_space       = [var.vnet_cidr]
}

resource "azurerm_subnet" "public" {
  name                 = "${var.name}-public"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.vnet_cidr, 8, 0)]
}

resource "azurerm_subnet" "app" {
  name                 = "${var.name}-app"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.vnet_cidr, 4, 1)] # /20 — Container Apps wants room

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "data" {
  name                 = "${var.name}-data"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet(var.vnet_cidr, 8, 32)]

  delegation {
    name = "postgres-flexible"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# TODO(MAN-F04-001): NAT Gateway on the public subnet + private endpoints / service
# endpoints (Blob/Cosmos/Key Vault) so vendor egress stays off the public internet
# (team-08 §1.3). Redis VNet injection arrives with the Premium SKU.

output "vnet_id" { value = azurerm_virtual_network.this.id }
output "public_subnet_id" { value = azurerm_subnet.public.id }
output "app_subnet_id" { value = azurerm_subnet.app.id }
output "data_subnet_id" { value = azurerm_subnet.data.id }
