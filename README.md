# Q (Queue)

Cloud queue-management platform for restaurants, shops and any other counter where people wait.
A customer scans a QR code, joins the line with minimal data, and follows their turn from their own
phone instead of standing in it. Staff run the line from a panel.

ITBA 82.08 Cloud Computing - TP, Grupo 9. This repository implements the MVP of *Funcionalidades 1-5*
of the "Queue" proposal.

**Status: serverless, deployed by Terraform from GitHub Actions** (Tercera Entrega). The static site
and the REST API share one API Gateway; the functions are TypeScript Lambdas over DynamoDB, with
Cognito for staff accounts, SNS/SQS for everything asynchronous, and a WebSocket API for live
updates. The previous delivery (Spring Boot on EC2 behind a load balancer, with RDS) is kept in
[`tp2/`](tp2/) and in git history. For the Tercera Entrega, read the [Terraform guide](infra/terraform/README.md)
and the [deployment procedure](docs/deployment.md). [`ROADMAP.md`](ROADMAP.md) tracks delivery work;
[`AVANCE-ENTREGA-3.md`](AVANCE-ENTREGA-3.md) is a chronological log whose older entries describe earlier states.

![Architecture of Queue on AWS](docs/diagrams/arquitectura.png)

## MVP coverage

| Proposal | Where it lives |
|---|---|
| **1. Acceso e ingreso mediante QR** | `GET /public/queues/{id}/qr` renders the code; `POST /public/queues/{id}/entries` joins with a name plus one contact channel. |
| **2. Seguimiento de la espera** | `GET /public/tickets/{token}`, then pushed over the WebSocket: position, people ahead, estimated wait, recomputed on every movement. |
| **3. Notificaciones del turno** | Configurable proximity thresholds (by position and by minutes), the "it's your turn" alert, and an audited notification history, by email. In the Learner Lab the emails go out through Gmail's SMTP server, because the lab denies SES (see [Notification emails](#notification-emails)). |
| **4. Gestion de la fila por el comercio** | Staff board, call / serve / no-show / cancel, pause and resume, lanes by party size, and queue + establishment metrics. |
| **5. Abandono y periodo de gracia** | `DELETE /public/tickets/{token}` frees the place; a configurable grace period plus four no-show policies decide what happens to someone who does not show up. |
| **Idiomas** | English and Spanish, following the browser. The locale is stored with the entry, so notification emails arrive in the same language as the page the customer joined from. |

## Stack

**Functions** — TypeScript on Node 22, one bundle per Lambda built with esbuild, AWS SDK v3,
Vitest with Testcontainers (DynamoDB Local).

**AWS** — API Gateway (REST for the site and the API, WebSocket for live updates), Lambda, DynamoDB
(single table plus a connections table, Streams), Cognito, SNS FIFO, SQS, Secrets Manager, S3,
CloudWatch. Notification emails through Gmail's SMTP server (SES where the account allows it).

**Infrastructure** — Terraform, run only from GitHub Actions: plan on every push to the pull
request, apply after an approval, destroy with a label.

**Frontend** — Next.js 16 (App Router, static export) · React 19 · TypeScript · Tailwind CSS 4.
No component library and no data-fetching library: the API client, the live-resource hook and the
design system are all first-party and small.

## Layout

```
functions/            the Lambdas
  src/handlers/       one file per function - each is its own bundle
  src/domain/         the queue rules: no AWS in here
  src/persistence/    DynamoDB: keys, items, optimistic writes
  src/api/            request parsing and response views
  test/               unit tests, and integration tests against DynamoDB Local
infra/terraform/      the whole deployment: modules/, scripts/buckets.sh, seed/
frontend/             Next.js SPA, exported as static files
  src/app/            routes (see below)
  src/components/     design-system primitives
  src/lib/            API client, Cognito, live-resource hook, formatters
.github/workflows/    the pipeline: validate, build, plan, apply, destroy
docs/                 architecture, domain model, API reference, deployment, frontend notes
tp2/                  the TP2 delivery as it was: CloudFormation template, diagram, runbook
```

### Routes

| Route | Who | What |
|---|---|---|
| `/q/?id={queueId}` | customer | What the QR opens: the queue's live state, then the join form. |
| `/t/?token={ticketToken}` | customer | Their own place in line, pushed live. |
| `/` `/login/` `/register/` | staff | Landing, sign-in and sign-up. |
| `/panel/` | staff | Today's numbers and every queue at a glance. |
| `/panel/queue/?id=` | staff | The live board: call, serve, no-show, pause, close. |
| `/panel/queue/settings/?id=` | owner | Waits, grace period, no-show policy, notification thresholds, lanes. |
| `/panel/queue/qr/?id=` | staff | The QR sheet, laid out for printing. |

Every id travels in the query string: a static export cannot pre-render unknown ids, and the site is
served from S3 through API Gateway with no rewrite rules. Deployed, every path starts with the stage,
`/prod`.

## Deploying it

Everything is deployed by [the pipeline](.github/workflows/terraform.yml) on the pull request, into
an AWS Academy Learner Lab account. In short: load the lab's credentials into the repository secrets,
push, approve the `aws-lab` environment, read the URL in the run summary. Destroy by adding the
`destroy` label. The full procedure, expected results and acceptance checklist are in [docs/deployment.md](docs/deployment.md).
The [Terraform guide](infra/terraform/README.md) maps the assignment requirements to the code,
explains modules, functions and meta-arguments, and records the TP2 corrections.

### Notification emails

**SES was denied in the lab account used for this delivery.** Neither the role the pipeline uses nor `LabRole`, the functions'
role, may verify an address or send (an explicit deny on `ses:SendEmail`, `ses:CreateEmailIdentity`
and `ses:VerifyEmailIdentity`), so SES cannot deliver anything from the lab.

**The workaround is Gmail's SMTP server.** The notifier sends from the group's Gmail account over TLS
(`smtp.gmail.com:465`) with an app password of that account, so emails reach any address, with no
sandbox. To turn it on:

| Where | Name | Value |
|---|---|---|
| Repository variable | `SMTP_SENDER_EMAIL` | The Gmail address emails are sent from |
| Repository secret | `GMAIL_APP_PASSWORD` | An [app password](https://support.google.com/accounts/answer/185833) of that account (it needs 2-Step Verification). Unlike the lab's keys, it does not expire with the session |

With neither set, notifications are simulated: the notifier writes each email to its CloudWatch log,
which the assignment allows.

**It brings back one secret**, the thing the TP2's correction flagged ("falta encriptar"), so it is
handled accordingly: the password lives only in the GitHub secret and, encrypted at rest, in Secrets
Manager. Terraform creates the secret empty; the Apply job writes the value with the AWS CLI after
`terraform apply`, so the password is never in a file, in the repository, in the Terraform plan (a
downloadable workflow artifact) or in its state. The notifier reads it at send time, and Gmail only
sees it over TLS.

Limits: Gmail caps how many emails a personal account sends per day, and bounces land in the
group's inbox. The smoke test joins the demo queue with the sender's own
address, so a deployment can exercise a real send to that inbox. The smoke test does not check mailbox delivery;
verify receipt manually when evaluating SMTP.

## Running the frontend locally

There is no local API: `npm run dev` runs the site against the one deployed in the lab, through a
proxy in `next.config.ts` (the deployed API serves the site from its own origin, so it has no CORS).

```bash
cd frontend
npm ci
cp .env.example .env.local
```

Set `DEV_API_URL` in `.env.local` to the deployed site's URL - "Sitio" in the summary of the last
apply run, or inspect the outputs using the [deployment guide](docs/deployment.md#outputs-and-demo-credentials) - and start it from the same `frontend` directory:

```bash
npm run dev
```

The demo data includes a staff user, `demo@queue.example`. Its password is random and persists
while `random_password.demo` remains unchanged; recreating that resource generates a new one.
Use the [output inspection instructions](docs/deployment.md#outputs-and-demo-credentials) to read it,
or register a new staff account.

## Tests

```bash
cd functions
npm ci
npm test
```

132 tests: unit tests for the domain rules (ordering, estimation, lanes, the selector, metrics) and
the Gmail mailer, and integration tests that run the handlers, the stores, the stream consumers and
the races against a real DynamoDB Local through Testcontainers, so **Docker must be running**. `npm run test:unit` runs
only the first group. The pipeline runs all of them on every push, and after every apply a smoke test
joins the demo queue and checks that the WebSocket push arrives.

```bash
cd infra/terraform && terraform init -backend=false && terraform test
```

The Terraform tests run in plan mode with mocked providers, so they need no AWS: the root one checks
that the whole configuration plans (every `count` and `for_each` is known before the apply) and some
of its decisions, and each module under `infra/terraform/modules/*/tests` checks what that module
promises, its validations included. 16 runs in all; the pipeline runs them in Validar.

## Design notes worth knowing

* **Positions are derived, never stored.** The waiting list sorted by its fractional string order key
  *is* the line, so a shown position can never disagree with reality, and the line never needs
  renumbering.
* **One version per queue.** Every change is a single DynamoDB transaction conditioned on the
  queue's `META.version`; the loser re-reads and decides again. That is what stops two staff
  members from calling the same person.
* **Events are written with the change.** Each operation's events are items in the same
  transaction, so an event exists if and only if the change committed. A stream function publishes
  them to SNS, and pushes, notifications and timers all start from there.
* **Notifications are decided from state, not from events**, and claimed with a conditional write
  per `(entry, type, pass through the line)` to suppress repeat sends after a completed claim.
  SMTP and DynamoDB are separate operations: interruption after sending and before recording `SENT`
  can still duplicate an email. See [failure handling](docs/architecture.md#6-concurrency-and-correctness).
* **Grace expiry is evaluated on a timer and on every read and write**, so state is never stale on
  read and a queue nobody is watching still moves. The first one to apply it wins.
* **SMTP integration credentials.** Cognito replaced the hand-rolled JWT, and
  DynamoDB, SNS, SQS and Secrets Manager are reached with the lab's IAM role. The external integration uses a
  Gmail app password needed for that fallback, kept out of Terraform (see
  [Notification emails](#notification-emails)). The generated demo password is a separate sensitive
  value held in Terraform state and plan artifacts; `sensitive` only masks normal output.

## Documentation

| Document | Covers |
|---|---|
| [infra/terraform/README.md](infra/terraform/README.md) | **IaC delivery:** modules, variables, outputs, functions, meta-arguments and TP2 corrections |
| [docs/architecture.md](docs/architecture.md) | **Architecture.** The components, request lifecycles, data model, concurrency, events, security, and the decision log |
| [docs/domain-model.md](docs/domain-model.md) | Entities and their DynamoDB items, the entry state machine, lanes, grace policies, estimation, notifications and metrics |
| [docs/api-reference.md](docs/api-reference.md) | Every endpoint, error code and payload, plus the WebSocket contract |
| [docs/deployment.md](docs/deployment.md) | The pipeline: credentials, plan, approval, apply, smoke test, destroy |
| [docs/frontend.md](docs/frontend.md) | Frontend implementation notes and the design language |
| [docs/HANDOFF.md](docs/HANDOFF.md) | **Historical session handoff.** Measurements and context from Phase 6; use the Terraform and deployment guides for current instructions |
| [docs/gotchas.md](docs/gotchas.md) | **Read before deploying or deleting anything.** Lab limits, pipeline traps, and the decisions a cleanup would break |
| [arquitectura-serverless.md](arquitectura-serverless.md) | Original serverless proposal (historical, in Spanish). The implemented architecture is described in docs/architecture.md |
| [tp2/](tp2/) | The TP2 delivery: CloudFormation template, diagram and runbook |
