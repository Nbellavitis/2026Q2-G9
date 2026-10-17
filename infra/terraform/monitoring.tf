# Las alarmas de todo el sistema avisan acá. Con `email_alertas`, además llegan por email (hay que
# confirmar la suscripción desde el link que manda AWS).

resource "aws_sns_topic" "alerts" {
  name = format("%s-alerts", var.project)
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count = var.email_alertas == null ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.email_alertas
}
