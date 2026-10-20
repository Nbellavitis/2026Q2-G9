# -*- coding: utf-8 -*-
"""
Diagrama de arquitectura de Queue (TP3), con la convención de AWS: AWS Cloud, la región y los
servicios conectados entre sí. Lo de afuera de AWS (el navegador, GitHub Actions, Gmail) queda
afuera del borde. Cada nodo es un recurso del Terraform de infra/terraform.

    python3 docs/diagrams/arquitectura.py      # escribe arquitectura.svg al lado de este archivo
    node docs/diagrams/render.mjs              # y lo exporta a arquitectura.png
"""
import json
import os

OUT = os.path.dirname(os.path.abspath(__file__))

INK = "#232f3e"
MUTED = "#5a6b73"
CLOUD = "#232f3e"
REGION = "#00a4a6"
REQ = "#6b4fbb"     # pedidos del navegador
SYNC = "#0f7a72"    # escrituras y lecturas de datos
BUS = "#c7511f"     # eventos y colas
OPS = "#3b4a54"     # despliegue y operación
ALERT = "#b0202f"
FONT = "DejaVu Sans, Verdana, Geneva, sans-serif"

W, H = 1990, 1330
ICON = 52


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Svg:
    def __init__(self, icons):
        self.icons = icons
        self.parts = []

    def add(self, s):
        self.parts.append(s)

    def box(self, x, y, w, h, stroke, fill="none", dash=None, width=2):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{stroke}" '
                 f'stroke-width="{width}"{d}/>')

    def text(self, x, y, t, size=13, fill=INK, anchor="start", weight="normal"):
        self.add(f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" fill="{fill}" '
                 f'text-anchor="{anchor}" font-weight="{weight}">{esc(t)}</text>')

    def group(self, x, y, w, h, color, label, icon=None, dash=None, fill="none"):
        """Un grupo de AWS: borde, ícono en la esquina y el nombre al lado."""
        self.box(x, y, w, h, color, fill, dash)
        if icon:
            self.add(f'<rect x="{x}" y="{y}" width="30" height="30" fill="{color}"/>')
            self.add(icon(x, y))
        self.text(x + (38 if icon else 10), y + 20, label, 13, color, weight="bold")

    def node(self, key, cx, cy, title, *lines, color=INK):
        """Un servicio: el ícono centrado en (cx, cy) y su nombre debajo."""
        self.add(f'<image href="{self.icons[key]}" x="{cx - ICON / 2}" y="{cy - ICON / 2}" '
                 f'width="{ICON}" height="{ICON}"/>')
        self.text(cx, cy + ICON / 2 + 17, title, 12.5, color, anchor="middle", weight="bold")
        for i, line in enumerate(lines):
            self.text(cx, cy + ICON / 2 + 33 + 14 * i, line, 10.5, MUTED, anchor="middle")

    def mail(self, cx, cy, title, *lines):
        """Un buzón de email externo (no es un servicio de AWS, así que no lleva ícono de AWS)."""
        x, y = cx - 26, cy - 18
        self.add(f'<rect x="{x}" y="{y}" width="52" height="36" rx="4" fill="#ffffff" stroke="{INK}" '
                 f'stroke-width="2"/><path d="M{x} {y} L{cx} {cy + 4} L{x + 52} {y}" fill="none" '
                 f'stroke="{INK}" stroke-width="2"/>')
        self.text(cx, cy + 40, title, 12.5, INK, anchor="middle", weight="bold")
        for i, line in enumerate(lines):
            self.text(cx, cy + 56 + 14 * i, line, 10.5, MUTED, anchor="middle")

    def line(self, points, color, dash=None, arrow=True, width=1.8):
        d = "M" + " L".join(f"{x} {y}" for x, y in points)
        da = f' stroke-dasharray="{dash}"' if dash else ""
        m = f' marker-end="url(#m{color[1:]})"' if arrow else ""
        self.add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}"{da}{m}/>')

    def chip(self, x, y, t, color, size=10.5):
        w = len(t) * size * 0.58 + 12
        self.add(f'<rect x="{x - w / 2:.0f}" y="{y - size - 2}" width="{w:.0f}" height="{size + 7}" '
                 f'rx="4" fill="#ffffff" stroke="{color}" stroke-width="1"/>')
        self.text(x, y, t, size, color, anchor="middle", weight="bold")

    def render(self):
        markers = "".join(
            f'<marker id="m{c[1:]}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
            f'markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
            for c in (REQ, SYNC, BUS, OPS, ALERT, INK)
        )
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
                f'role="img" aria-label="Arquitectura de Queue en AWS">'
                f'<defs>{markers}</defs><rect width="{W}" height="{H}" fill="#ffffff"/>')
        return head + "".join(self.parts) + "</svg>"


def cloud_icon(x, y):
    return (f'<path d="M{x + 8} {y + 21} a5 5 0 0 1 1-10 a7 7 0 0 1 13-1 a5 5 0 0 1 2 11 z" '
            f'fill="none" stroke="#ffffff" stroke-width="1.8"/>')


def region_icon(x, y):
    return (f'<path d="M{x + 15} {y + 5} a6 6 0 0 1 6 6 c0 5 -6 13 -6 13 c0 0 -6 -8 -6 -13 a6 6 0 0 1 6 -6 z" '
            f'fill="none" stroke="#ffffff" stroke-width="1.8"/><circle cx="{x + 15}" cy="{y + 11}" r="2" fill="#ffffff"/>')


def build(icons):
    s = Svg(icons)
    h = ICON / 2

    s.text(30, 40, "Queue · arquitectura en AWS (TP3)", 22, weight="bold")
    s.text(30, 63, "Serverless · desplegada con Terraform desde GitHub Actions · AWS Academy Learner Lab · Grupo 9",
           13, MUTED)

    # ------------------------------------------------------------ bordes
    s.group(250, 90, 1470, 1125, CLOUD, "AWS Cloud", icon=cloud_icon)
    s.group(275, 135, 1420, 1060, REGION, "Región us-east-1 (N. Virginia)  ·  sin VPC", icon=region_icon,
            dash="8 5")

    # ------------------------------------------------------------ afuera de AWS
    s.node("user", 130, 470, "Navegador", "cliente y staff")
    s.node("gha", 130, 960, "GitHub Actions", "validate · plan · apply", "destroy · smoke test", color=OPS)
    s.node("tf", 130, 1120, "Terraform", "estado en S3 tfstate", color=OPS)
    s.mail(1850, 820, "Gmail SMTP", "smtp.gmail.com:465", "avisos a clientes")
    s.mail(1850, 1100, "Email del equipo", "alarmas")

    # ------------------------------------------------------------ entrada
    s.node("cognito", 400, 230, "Cognito", "user pool + cliente web")
    s.node("lambda", 620, 230, "λ cognito-pre-signup", "confirma el alta")
    s.node("lambda", 860, 230, "λ seed", "datos de demo (al aplicar)")
    s.node("apigw", 400, 450, "API Gateway REST", "stage prod · throttling")
    s.node("s3", 400, 640, "S3 spa", "sitio estático (privado)")
    s.node("apigw", 400, 800, "API Gateway WebSocket", "$connect · $disconnect · ping")

    # ------------------------------------------------------------ cómputo y datos
    s.node("lambda", 620, 380, "λ staff", "panel · llamados · métricas")
    s.node("lambda", 620, 520, "λ public", "anotarse · ticket · QR")
    s.node("lambda", 620, 800, "λ ws-connections", "valida el ticket en q-main")
    s.node("ddb", 860, 450, "DynamoDB q-main", "colas · entradas · eventos", "miembros · avisos · PITR")
    s.node("ddb", 860, 800, "DynamoDB q-connections", "sockets abiertos · GSI byQueue", "TTL · sin Streams")

    # ------------------------------------------------------------ eventos
    s.node("ddbstream", 1040, 450, "DynamoDB Streams", "NEW_AND_OLD_IMAGES")
    s.node("lambda", 1225, 450, "λ stream-publisher", "filtro kind = EVENT")
    s.node("sns", 1420, 450, "SNS FIFO", "q-queue-events")
    s.node("sqs", 1040, 650, "SQS FIFO q-push", "orden por cola")
    s.node("sqs", 1300, 650, "SQS q-lifecycle", "delay = gracia")
    s.node("sqs", 1560, 650, "SQS q-notifications", "filtro por type")
    s.node("lambda", 1040, 830, "λ broadcaster", "lee q-main y q-connections")
    s.node("lambda", 1300, 830, "λ lifecycle", "vence gracias · libera")
    s.node("lambda", 1560, 830, "λ notifier", "decide y marca en q-main")
    s.node("secrets", 1560, 975, "Secrets Manager", "q-smtp (si hay SMTP)")

    # ------------------------------------------------------------ transversales
    row = 1110
    s.node("s3", 400, row, "S3 artifacts", "zips de las λ · versionado", color=OPS)
    s.node("s3", 560, row, "S3 logs", "access logs de spa", "y artifacts", color=OPS)
    s.node("s3", 720, row, "S3 tfstate", "estado + lockfile", color=OPS)
    s.node("iam", 880, row, "IAM LabRole", "rol de las λ y de", "API Gateway → S3", color=OPS)
    s.node("cw", 1040, row, "CloudWatch Logs", "logs de las 9 λ", color=OPS)
    s.node("sqs", 1200, row, "SQS DLQs", "3 colas + stream-failures", color=ALERT)
    s.node("cw", 1360, row, "CloudWatch Alarms", "DLQ · cola atrasada", "fallas del stream", color=ALERT)
    s.node("sns", 1520, row, "SNS q-alerts", "email (si hay ALERT_EMAIL)", color=ALERT)

    # ------------------------------------------------------------ pedidos del navegador
    s.line([(130 + h, 455), (400 - h, 240)], REQ)
    s.chip(232, 380, "staff: registro y login", REQ)
    s.line([(130 + h, 470), (400 - h, 450)], REQ)
    s.chip(250, 452, "HTTPS", REQ)
    s.line([(130 + h, 485), (400 - h, 790)], REQ)
    s.chip(250, 640, "wss", REQ)

    s.line([(400, 450 - h), (400, 230 + h + 40)], REQ)
    s.chip(400, 345, "authorizer: valida el JWT", REQ)
    s.line([(400 + h, 230), (620 - h, 230)], REQ)
    s.chip(510, 222, "trigger", REQ)
    s.line([(400, 450 + h + 40), (400, 640 - h)], REQ)
    s.chip(400, 590, "GET / (LabRole)", REQ)
    s.line([(400 + h, 440), (620 - h, 385)], REQ)
    s.chip(510, 398, "/api/v1/* (JWT)", REQ)
    s.line([(400 + h, 460), (620 - h, 515)], REQ)
    s.chip(527, 502, "/api/v1/public/*", REQ)
    s.line([(400 + h, 800), (620 - h, 800)], REQ)
    # staff da de alta miembros con la API de administración de Cognito
    s.line([(600, 380 - h), (400 + h, 243)], REQ)
    s.chip(540, 318, "alta de miembros", REQ)

    # ------------------------------------------------------------ datos
    s.line([(620 + h, 385), (860 - h, 440)], SYNC)
    s.line([(620 + h, 515), (860 - h, 460)], SYNC)
    s.line([(860, 230 + h + 40), (860, 450 - h)], SYNC)
    s.line([(620 + h, 800), (860 - h, 800)], SYNC)

    # ------------------------------------------------------------ eventos
    s.line([(860 + h, 450), (1040 - h, 450)], BUS)
    s.line([(1040 + h, 450), (1225 - h, 450)], BUS)
    s.line([(1225 + h, 450), (1420 - h, 450)], BUS)
    s.chip(1322, 442, "grupo = cola", BUS)
    s.line([(1240, 450 + h + 40), (1300, 650 - h)], BUS)
    s.chip(1253, 545, "CALLED · CLOSED", BUS)
    s.line([(1420, 450 + h + 40), (1420, 600), (1040, 600), (1040, 650 - h)], BUS)
    s.line([(1445, 450 + h + 40), (1560, 650 - h)], BUS)
    s.line([(1040, 650 + h + 40), (1040, 830 - h)], BUS)
    s.line([(1300, 650 + h + 40), (1300, 830 - h)], BUS)
    s.line([(1560, 650 + h + 40), (1560, 830 - h)], BUS)

    # lifecycle se reprograma si la gracia supera los 15 minutos de delay de SQS
    s.line([(1300 + h, 830), (1375, 830), (1375, 655), (1300 + h, 655)], BUS)
    s.chip(1375, 745, "reprograma", BUS)

    # los consumidores escriben en q-main
    s.line([(1300 - h, 815), (1190, 815), (1190, 580), (900, 580), (870, 450 + h + 52)], SYNC)
    s.line([(1560 - h, 845), (1470, 845), (1470, 580), (1190, 580)], SYNC, arrow=False)
    s.chip(1035, 572, "escriben en q-main", SYNC)

    # broadcaster: lee las conexiones y empuja por la API de gestión del WebSocket
    s.line([(1040 - h, 830), (860 + h, 805)], SYNC)
    s.line([(1040, 830 + h + 40), (1040, 935), (300, 935), (300, 812), (400 - h, 812)], BUS)
    s.chip(700, 927, "push por @connections", BUS)

    # notifier
    s.line([(1560, 830 + h + 40), (1560, 975 - h)], SYNC)
    s.line([(1560 + h, 820), (1850 - 26, 820)], BUS)
    s.chip(1758, 812, "SMTP sobre TLS", BUS)

    # alarmas
    s.line([(1200 + h, row), (1360 - h, row)], ALERT)
    s.line([(1360 + h, row), (1520 - h, row)], ALERT)
    s.line([(1520 + h, row), (1850 - 26, row)], ALERT)

    # infraestructura: el pipeline crea los buckets y corre Terraform, que sube el código de las λ
    s.line([(130 + h, 960), (275, 960)], OPS)
    s.chip(205, 952, "buckets.sh", OPS)
    s.line([(130, 960 + h + 40), (130, 1120 - h)], OPS)
    s.chip(130, 1067, "terraform apply", OPS)
    s.line([(130 + h, 1118), (400 - h, 1110)], OPS)
    s.chip(215, 1106, "zips de las λ", OPS)
    s.line([(400, 1110 - h), (400, 975), (620, 975), (620, 800 + h + 40)], OPS)
    s.chip(510, 967, "código de las 9 λ", OPS)

    # ------------------------------------------------------------ leyenda
    lx, ly = 1738, 1188
    s.box(lx, ly, 244, 132, INK, "#ffffff", width=1)
    s.text(lx + 12, ly + 20, "Conexiones", 12, INK, weight="bold")
    legend = [
        (REQ, None, "pedido del usuario"),
        (SYNC, None, "lectura o escritura de datos"),
        (BUS, None, "evento o mensaje"),
        (ALERT, None, "alarma"),
        (OPS, None, "pipeline e infraestructura"),
    ]
    for i, (color, dash, label) in enumerate(legend):
        y = ly + 42 + 19 * i
        s.line([(lx + 12, y - 4), (lx + 52, y - 4)], color, dash=dash)
        s.text(lx + 62, y, label, 11, INK)

    # ------------------------------------------------------------ notas
    notes = [
        "Sin VPC: todo es servicio regional administrado (multi-AZ); las funciones lo usan por HTTPS, autorizadas por IAM con LabRole.",
        "Los 3 buckets de la app los crea el pipeline (scripts/buckets.sh) porque un SCP del lab bloquea aws_s3_bucket; Terraform configura el resto.",
        "SES: Terraform declara identidades opcionales (count), pero el Learner Lab lo niega; los avisos salen por Gmail con la contraseña en Secrets Manager.",
    ]
    for i, n in enumerate(notes):
        s.text(30, 1250 + 20 * i, n, 12, MUTED)
    return s.render()


def main():
    with open(os.path.join(OUT, "icons.json")) as f:
        icons = json.load(f)
    path = os.path.join(OUT, "arquitectura.svg")
    with open(path, "w") as f:
        f.write(build(icons))
    print(path)


if __name__ == "__main__":
    main()
