# Deploying Queue

Everything is deployed by Terraform from GitHub Actions, into an AWS Academy Learner Lab account.
Nothing is created by hand and nothing runs from a laptop: the workflow in
[`.github/workflows/terraform.yml`](../.github/workflows/terraform.yml) plans on every push to the
pull request, applies after someone approves it, and destroys when the pull request gets the
`destroy` label.

This page is the operator's guide. What each module, resource, local and variable does, and why,
goes in `infra/terraform/README.md`, which Phase 7 of the [ROADMAP](../ROADMAP.md) writes; until
then, each module has its own README, and the resource files are commented.

---

## Once per repository

The workflow runs on a pull request, because the delivery's pull request is not merged before it is
graded, and GitHub only offers "Run workflow" for workflows already on the default branch. The pull
request has to come from a **branch of the same repository**: a fork does not receive the secrets.

| Setting | Where | Why |
|---|---|---|
| Environment `aws-lab`, with required reviewers | Settings → Environments | The Apply and Destroy jobs run in it, so they wait for an approval |
| Label `destroy` | Issues → Labels | Adding it to the pull request starts the Destroy job |
| Secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Settings → Secrets and variables → Actions | The lab's credentials (next section) |
| Variables `SMTP_SENDER_EMAIL` and `ALERT_EMAIL` (optional) | Settings → Secrets and variables → Actions → *Variables* tab | Customer emails through Gmail, and alarm emails (below). Variables, not secrets: an address is not a secret |
| Secret `GMAIL_APP_PASSWORD` (with `SMTP_SENDER_EMAIL`) | Settings → Secrets and variables → Actions | The Gmail account's app password (below). Set once; it does not expire with the lab session |

Nothing else is required. The Terraform state lives in a bucket the pipeline creates the first time
it runs in an account, `tfstate-q-<account>-<region>`, versioned and private, with S3's native
locking. It is not destroyed with the rest, so a later apply in the same account finds its state.

---

## Every lab session

The lab's credentials are session credentials and expire when the session does. At the start of each
session, before running anything:

1. Start the lab, open **AWS Details** and copy the three values from **AWS CLI**.
2. Set them as the repository secrets, one by one, so they are never written to a file or a shell
   history:

   ```bash
   gh secret set AWS_ACCESS_KEY_ID
   ```

   ```bash
   gh secret set AWS_SECRET_ACCESS_KEY
   ```

   ```bash
   gh secret set AWS_SESSION_TOKEN
   ```

   Each one prompts for the value.

3. If a run already failed for lack of credentials, re-run it from the Actions tab ("Re-run all
   jobs"): the jobs read the secrets when they start.

---

## Deploying

Push to the pull request's branch. Each push runs:

| Job | What it does | Needs credentials |
|---|---|---|
| **Validar** | `terraform fmt -check`, `terraform validate`, tflint | No |
| **Compilar** | Typecheck and bundle the functions, run their 132 tests (Docker on the runner provides DynamoDB Local), build the site with the `/prod` base path | No |
| **Plan** | Create the state bucket if missing, `terraform init`, `terraform plan`, comment the plan on the pull request, keep the saved plan for the apply | Yes |
| **Apply** | Waits for the `aws-lab` approval. Creates the three S3 buckets (see below), applies **the saved plan** — exactly what was commented, nothing re-planned — and runs the smoke test | Yes |

To deploy, open the run, check the plan (in the comment on the pull request or in the Plan job), and
**approve the `aws-lab` environment**. A first deployment in an empty account creates 200 resources.

**Why the pipeline creates the buckets.** The lab's service control policy denies
`s3:GetBucketObjectLockConfiguration`, and the AWS provider reads it right after creating any
`aws_s3_bucket`, failing the apply. So the Apply job creates the three buckets with the AWS CLI
(`infra/terraform/scripts/buckets.sh create`), with the names Terraform put in the saved plan's
`bucket_names` output, and Terraform configures everything on them: public access block, ownership,
versioning, policy, access logs, expiration and contents. The names are recorded in the state bucket
before anything is created, so the destroy finds them even if an apply stops halfway.

### What the smoke test checks

After the apply, against the deployed URLs:

* `GET /api/v1/health` answers (retried for up to a minute while the API deployment propagates) —
  the function wrote and read back an item in DynamoDB;
* the home page and `/login/` return HTML, and a path that does not exist returns the site's 404
  page, not S3's XML;
* `config.json` has the Cognito ids;
* a customer joins the demo queue, their ticket is `WAITING`, and leaving with the WebSocket open
  delivers the push (`.github/scripts/smoke-realtime.mjs`).

If any of these fails, the job fails.

### After the apply

The run's summary lists the site, the health check, the demo queue and the demo staff user:

| Output | What |
|---|---|
| `site_url` | The site, `https://<api-id>.execute-api.us-east-1.amazonaws.com/prod/` |
| `health_url` | The health check |
| `demo_queue_url` | The demo queue's join page — what its QR code opens |
| `demo_staff_email` | `demo@queue.example`, a member of the demo establishment |
| `demo_staff_password` | Random, new on every deployment. Sensitive, so it is not printed |
| `websocket_url` | The realtime API |
| `user_pool_id`, `user_pool_client_id` | Cognito, also in `config.json` |
| `main_table_name`, `connections_table_name`, `function_names`, `bucket_names` | For looking things up in the console |

Anyone can register a new staff account on the site, which is the simplest way in. To read the demo
password instead, with the lab's credentials exported in a shell:

```bash
cd infra/terraform && terraform init -backend-config="bucket=tfstate-q-<account>-us-east-1" -backend-config="region=us-east-1"
```

```bash
cd infra/terraform && terraform output -raw demo_staff_password
```

### What the defaults deploy

Apart from the optional email variables, the pipeline passes nothing, so the defaults in
[`variables.tf`](../infra/terraform/variables.tf) apply ([`terraform.tfvars.example`](../infra/terraform/terraform.tfvars.example)
lists them):

* **demo data on** (`cargar_demo`): an establishment with two queues and lanes, and the demo staff
  user;
* **emails simulated** (`smtp_sender_email = null`, `ses_sender_email = null`): the notifier writes
  each email to its CloudWatch log, as `emailSimulado`, instead of sending it;
* **no alarm emails** (`email_alertas = null`): the alarms exist and publish to the `q-alerts` topic,
  with no subscriber;
* stage `prod`, region `us-east-1`, 14 days of logs, 12-hour staff sessions, and the throttling
  limits sized for the lab's Lambda concurrency.

**Alarm emails.** Set the repository variable `ALERT_EMAIL` (Settings → Secrets and variables →
Actions → *Variables*) and run the pipeline: it becomes `email_alertas`, subscribed to the alarms
topic. That is SNS, not SES, and it works in the Learner Lab. SNS emails a subscription confirmation
after the apply; nothing arrives until the link is opened.

**Customer emails go through Gmail's SMTP server.** The Learner Lab denies SES outright: the role
the pipeline uses (`voclabs`) cannot create or verify an identity, through either API version, nor
send; and `LabRole`, the functions' role, has an explicit deny on `ses:SendEmail`,
`ses:CreateEmailIdentity` and `ses:VerifyEmailIdentity`. So the notifier can send from a Gmail
account instead, over TLS to `smtp.gmail.com:465`, to any address:

| Where | Name | Value |
|---|---|---|
| Repository variable | `SMTP_SENDER_EMAIL` | The Gmail address, e.g. the group's `queue.cloud.itba@gmail.com`. Becomes `smtp_sender_email` |
| Repository secret | `GMAIL_APP_PASSWORD` | An app password of that account (Google Account → Security → App passwords; it needs 2-Step Verification). It does **not** expire with the lab session |

Set the secret without it touching a file:

```bash
gh secret set GMAIL_APP_PASSWORD
```

With the variable, Terraform creates an empty secret in Secrets Manager, `q-smtp`, and gives the
notifier its ARN and the sender. After `terraform apply`, the Apply job's **Contraseña SMTP** step
writes the password into it with the AWS CLI: through Terraform it would sit in plain text in the
saved plan, which is a downloadable workflow artifact, and in the state. Until the secret has a
value the notifier simulates, so a missing password never fails a send. With the variable set and
no `GMAIL_APP_PASSWORD`, the step leaves a warning and emails stay simulated.

With SMTP on, the smoke test joins the demo queue with the sender's own address, so each deployment
delivers one real "you have a place" email to that inbox — the proof that sending works.

The workflow still passes `SES_SENDER_EMAIL` and `SES_VERIFIED_RECIPIENTS` to Terraform, for an
account where SES is allowed; **in the Learner Lab, do not set them**: the apply fails creating the
identities.

---

## Destroying

1. Make sure no apply is waiting for approval in another run: approve or cancel it first. Apply and
   Destroy share one concurrency group, and a pending apply holds it.
2. Add the **`destroy`** label to the pull request.
3. Approve the `aws-lab` environment in the run that starts.

The Destroy job does not build anything (a compile error must not keep the account from being
cleaned): it writes an empty bundle per function, runs `terraform destroy -refresh=false`, and then
`buckets.sh delete` empties every version from each recorded bucket and deletes it, the logs bucket
last, retrying while late access logs arrive. The job's log ends with `Destroy complete!` and one
`Vaciando y borrando:` line per bucket.

Remove the label afterwards: the Destroy job starts when the label is *added*, so it has to come off
before it can be added again. The next push plans from an empty state.

`-refresh=false` because refreshing a bucket repeats the read the lab denies. It is safe here because
nothing outside the pipeline changes these resources.

---

## Before stopping the lab

* Destroy, as above, if the deployment is not needed in the next session. Idle, it costs close to
  nothing, but it is not nothing.
* Do not leave an apply waiting for approval: it will block the next session's destroy.
* After the lab stops, pushes still run Validar and Compilar; Plan fails on the expired credentials.
  That is expected and queues nothing.

---

## When something fails

| Symptom | Cause | Fix |
|---|---|---|
| Plan fails at the start with `The security token included in the request is invalid` | The session expired, or a secret was pasted into the wrong one (the access key id has no `/`) | Set the three secrets again and re-run |
| Apply or Destroy stays queued and never starts | Another apply or destroy holds the `terraform-state` concurrency group | Approve or cancel the other run |
| Apply fails with `AccessDenied` on `GetBucketObjectLockConfiguration` | An `aws_s3_bucket` resource is in the state or the configuration | Buckets are created by `buckets.sh`; the `private-bucket` module receives an existing name. If an old run left one in the state, destroy (it skips the refresh) and apply again |
| Smoke test: `La API no respondió` | The API Gateway deployment had not propagated, or the health function failed | Check the `q-public` function's log group; re-run the Apply job |
| The site loads but sign-in fails | `config.json` missing or stale | It is written by Terraform (`site.tf`); re-apply |
| Emails never arrive, and the notifier logs `emailSimulado` | No `SMTP_SENDER_EMAIL`, or no `GMAIL_APP_PASSWORD` (the Contraseña SMTP step warns) | Set both and run the pipeline again |
| Notifications end `FAILED` with `Invalid login` / `EAUTH` in the `q-notifier` log | Wrong app password, or 2-Step Verification turned off on the account | Create a new app password, set `GMAIL_APP_PASSWORD`, re-run the Apply job |
| Apply fails creating `q-smtp`: `scheduled for deletion` | A secret deleted with a recovery window | The resource uses `recovery_window_in_days = 0`; if one was deleted by hand, `aws secretsmanager delete-secret --secret-id q-smtp --force-delete-without-recovery` |
| Apply fails with `AccessDenied` on `ses:CreateEmailIdentity` or `ses:TagResource` | `SES_SENDER_EMAIL` or `SES_VERIFIED_RECIPIENTS` is set, and the lab denies SES | Delete both variables and run the pipeline again |

Lab limits behind these, and the rest of the traps, are in [gotchas.md](gotchas.md).
