# GitHub Issue Monitoring

*by [Solix](https://github.com/Jesse-Garcia99)*

Turn Sentry alerts and GitHub Actions failures into GitHub issues — no Sentry
Business plan required.

Sentry's native "create GitHub issue" alert action is gated behind
Business/Enterprise plans. This Cloudflare Worker gives you the same result on
any plan:

```
Sentry alert email ──► Email Routing ──► this Worker ──► GitHub issue
(or internal-integration webhook ─────────► POST /webhook ──► same path)
GitHub Actions failure ──► repo/org webhook ──► POST /github ──► same path
```

- Parses Sentry alert emails, extracts the `/issues/` link, files a GitHub issue
- **Deduplicates** — repeat notifications update nothing; the existing issue is found via search
- Optional direct webhook path (Sentry internal integration) with HMAC-SHA256 signature verification
- GitHub `workflow_run` webhook turns Actions failures into issues (HMAC-SHA256 verified)
- Free-tier friendly: Workers + Email Routing cost nothing at this volume

## What you need

- A [Cloudflare](https://cloudflare.com) account with your domain's DNS on it (free)
- A GitHub repo that will receive issues
- A GitHub token with `issues:write` on that repo — a
  [fine-grained PAT](https://github.com/settings/personal-access-tokens/new)
  scoped to **Issues: Read and write** on that one repo is ideal
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler` works — no install needed)

## Setup — about 10 minutes

### 1. Clone and configure

```sh
git clone https://github.com/Jesse-Garcia99/github-issue-monitoring.git
cd github-issue-monitoring
```

Edit `wrangler.toml` — set `GH_REPO` to the repo that should receive issues:

```toml
[vars]
GH_REPO = "acme/api"
```

Optionally set `ISSUE_LABEL` (default `"sentry"`). If the label doesn't exist in
your repo the issue is still created, just unlabeled — create it with
`gh label create sentry` if you want it.

### 2. Deploy

```sh
npx wrangler login
npx wrangler deploy
```

### 3. Add your GitHub token as a secret

```sh
npx wrangler secret put GITHUB_TOKEN
```

Paste your PAT when prompted. Never commit it — secrets stay on Cloudflare's side.

### 4. Give the worker an email address

You need Email Routing on a **subdomain** — enabling it on your apex domain
would replace your existing MX records (e.g. Google Workspace). A subdomain
leaves normal mail untouched.

1. Cloudflare dashboard → your domain → **Email → Email Routing**
2. If prompted, choose to onboard a **subdomain** like `alerts.example.com`
   (or run: `POST /zones/{zone_id}/email/routing/dns {"name":"alerts.example.com"}`)
3. **Routes → Custom addresses → Create** — pick an address like
   `sentry@alerts.example.com`, set the action to **Send to Worker**, and select
   `github-issue-monitoring`

That's the "worker email" — any Sentry mail delivered to it is parsed by this
worker. Prefer a specific custom address over a catch-all.

### 5. Point Sentry at it

Sentry alert rules can only email *verified* addresses on a member account. Two
ways to deliver:

**Option A — secondary email on your Sentry account (recommended)**

1. Sentry → **Settings → Account → Emails** → add `sentry@alerts.example.com`
2. Sentry mails a verification link — it lands in the worker. Watch
   `npx wrangler tail` and open the `confirm-signed-email` link while logged
   into Sentry
3. **Settings → Notifications → Email Routing** → set your project's
   notifications to the new address

**Option B — forward from your existing mailbox**

Add a Gmail filter (Settings → Forwarding + Filters) forwarding `from:sentry.io`
mail to `sentry@alerts.example.com`. Covers every project at once; requires
verifying the forwarding address the same way (code arrives in `wrangler tail`).

Then create an alert rule if you don't have one: **Alerts → Create Alert →
Issues**, condition "When an issue is first seen", action = email yourself —
the mail now reaches the worker via whichever route above.

### 6. Test it

Send a mail containing a fake Sentry link to `sentry@alerts.example.com`
(e.g. `https://your-org.sentry.io/issues/12345/`), then check
**Issues** in your GitHub repo. Sending it again should log `skipped` in
`npx wrangler tail` instead of creating a duplicate.

## Optional: direct webhook instead of email

If your Sentry plan can create **internal integrations** (Settings → Developer
Settings → New Internal Integration, enable the *issue* webhook), point it at:

```
https://<your-worker>.<your-subdomain>.workers.dev/webhook
```

and set the integration's client secret:

```sh
npx wrangler secret put SENTRY_CLIENT_SECRET
```

Requests are HMAC-SHA256 verified via the `sentry-hook-signature` header.
Both transports can run side by side.

## Optional: GitHub Actions failures → issues

Point a GitHub webhook at `https://<your-worker>.<your-subdomain>.workers.dev/github`
and subscribe it to **Workflow runs** only. A repo webhook covers one repo; an
**org webhook** (`Settings → Webhooks` on the org, or
`gh api orgs/ORG/hooks`) covers every repo in it.

```sh
gh api orgs/ORG/hooks -f name=web -F active=true \
  -f "config[url]=https://<worker>.<subdomain>.workers.dev/github" \
  -f "config[content_type]=json" -f "config[secret]=<same value as below>" \
  -f "events[]=workflow_run"
```

Set the matching secret — unsigned requests are accepted if it's unset, so set it:

```sh
npx wrangler secret put GH_WEBHOOK_SECRET
```

A completed run with conclusion `failure`, `timed_out`, `action_required`, or
`startup_failure` files an issue in `GH_REPO` titled
`[CI] owner/repo: <workflow> failure on <branch>`, labeled `ci-failure`
(override with `CI_ISSUE_LABEL`). Other events and conclusions get a `200
ignored` so GitHub's delivery log stays green. The issue body links the failing
run and records the source repo — the token only needs `issues:write` on
`GH_REPO`, not on every monitored repo.

**CI dedup**: before filing, the worker searches
`repo:GH_REPO is:issue is:open "ci:owner/repo#<workflow_id>@<branch>" in:body`.
One open issue per failing workflow+branch; closing it lets the next failure
file a fresh issue.

## How dedup works

Before creating anything, the worker searches `repo:GH_REPO is:issue <sentry-issue-id> in:body`.
Any hit → it logs `skipped` and moves on, so noisy repeated alerts won't spam
your tracker. Closing the GitHub issue does not reopen it; delete the issue if
you want a fresh one.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing happens | `npx wrangler tail` — is the mail even reaching the worker? MX for your subdomain should resolve to `route*.mx.cloudflare.net` |
| Mail arrives, no issue | Look for `no sentry issue link` — the message has no `*.sentry.io/issues/` URL |
| `GitHub 401` | `GITHUB_TOKEN` missing/invalid — re-run `wrangler secret put` |
| `GitHub 404` | `GH_REPO` typo, or the token can't see that repo |

## License

MIT — see [LICENSE](LICENSE). Built by [Solix](https://github.com/Jesse-Garcia99).
