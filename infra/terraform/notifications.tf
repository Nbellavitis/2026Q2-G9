# SES para los avisos a clientes. La cuenta del Learner Lab queda en el sandbox de SES: solo puede
# mandar desde y hacia direcciones verificadas. Crear una identidad le manda a esa dirección un email
# de AWS con un link que hay que abrir.
#
# Sin remitente, o hacia alguien no verificado, el notifier escribe el email en sus logs en lugar de
# mandarlo: un envío simulado, que la consigna permite.

resource "aws_sesv2_email_identity" "sender" {
  count = var.ses_sender_email == null ? 0 : 1

  email_identity = var.ses_sender_email
}

# Las direcciones del grupo, para recibir los avisos de verdad mientras se prueba.
resource "aws_sesv2_email_identity" "recipients" {
  for_each = toset([for email in var.ses_verified_recipients : lower(email) if lower(email) != lower(var.ses_sender_email == null ? "" : var.ses_sender_email)])

  email_identity = each.value
}
