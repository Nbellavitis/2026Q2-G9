provider "aws" {
  region = var.region

  # Todo recurso que lo admita sale con estos tags, sin repetirlos en cada uno.
  default_tags {
    tags = local.tags
  }
}

# El mismo provider sin tags, solo para las identidades de SES: el Learner Lab no permite
# ses:TagResource, y crear una identidad con tags la manda en la misma llamada (CreateEmailIdentity),
# así que la falta de ese permiso hace fallar la creación entera.
provider "aws" {
  alias  = "sin_tags"
  region = var.region
}
