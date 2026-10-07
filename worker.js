// github-issue-monitoring — turns Sentry signals and GitHub Actions failures into GitHub issues.
//   email: Sentry alert mail routed via Cloudflare Email Routing (e.g. sentry@alerts.example.com)
//   fetch: Sentry internal-integration webhook POST /webhook
//          GitHub webhook (workflow_run events) POST /github
// Config:  GH_REPO (var, "owner/repo" — issues are filed here), ISSUE_LABEL (optional var, default "sentry"),
//          CI_ISSUE_LABEL (optional var, default "ci-failure")
// Secrets: GITHUB_TOKEN (issues:write on GH_REPO), SENTRY_CLIENT_SECRET (optional, verifies webhooks),
//          GH_WEBHOOK_SECRET (optional, verifies GitHub webhooks)

const ISSUE_RE = /https:\/\/[a-z0-9.-]*sentry\.io\/(?:organizations\/[a-z0-9-]+\/)?issues\/(\d+)\/?/g;

async function gh(env, path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-issue-monitoring",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} ${path}: ${await r.text()}`);
  return r.json();
}

async function createIssue(env, body) {
  try {
    return await gh(env, `/repos/${env.GH_REPO}/issues`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    // repo may not have the label — retry once without it rather than dropping the issue
    if (body.labels && String(e).includes("422")) {
      const { labels, ...rest } = body;
      return await gh(env, `/repos/${env.GH_REPO}/issues`, { method: "POST", body: JSON.stringify(rest) });
    }
    throw e;
  }
}

async function ensureIssue(env, { issueId, permalink, title, source }) {
  if (!env.GH_REPO) throw new Error("GH_REPO is not set");
  const q = encodeURIComponent(`repo:${env.GH_REPO} is:issue ${issueId} in:body`);
  const found = await gh(env, `/search/issues?q=${q}`);
  if (found.total_count > 0) return { skipped: true, existing: found.items[0].html_url };
  const issue = await createIssue(env, {
    title: `[Sentry] ${title}`.slice(0, 240),
    body: `Sentry issue: ${permalink}\nSource: ${source}`,
    labels: [env.ISSUE_LABEL || "sentry"],
  });
  return { created: issue.html_url };
}

function linksOf(text) {
  return [...text.matchAll(ISSUE_RE)].map((m) => ({ issueId: m[1], permalink: m[0] }));
}

async function hmacHex(secret, raw) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifySignature(request, secret, raw) {
  const sig = request.headers.get("sentry-hook-signature");
  return sig ? (await hmacHex(secret, raw)) === sig : false;
}

const CI_CONCLUSIONS = ["failure", "timed_out", "action_required", "startup_failure"];

async function handleGitHub(request, env) {
  const raw = await request.text();
  if (env.GH_WEBHOOK_SECRET) {
    const sig = request.headers.get("x-hub-signature-256") || "";
    if (sig !== `sha256=${await hmacHex(env.GH_WEBHOOK_SECRET, raw)}`) {
      return new Response("bad signature", { status: 401 });
    }
  }
  if (request.headers.get("x-github-event") !== "workflow_run") return new Response("ignored");
  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const wr = payload.workflow_run;
  if (payload.action !== "completed" || !wr || !CI_CONCLUSIONS.includes(wr.conclusion)) {
    return new Response("ignored");
  }
  const repo = (payload.repository && payload.repository.full_name) || "?";
  const branch = wr.head_branch || "?";
  const key = `ci:${repo}#${wr.workflow_id}@${branch}`;
  try {
    if (!env.GH_REPO) throw new Error("GH_REPO is not set");
    const q = encodeURIComponent(`repo:${env.GH_REPO} is:issue is:open "${key}" in:body`);
    const found = await gh(env, `/search/issues?q=${q}`);
    if (found.total_count > 0) return Response.json({ skipped: true, existing: found.items[0].html_url });
    const issue = await createIssue(env, {
      title: `[CI] ${repo}: ${wr.name} ${wr.conclusion} on ${branch}`.slice(0, 240),
      body: [
        `GitHub Actions **${wr.name}** finished with **${wr.conclusion}** in \`${repo}\`.`,
        "",
        `- Run: ${wr.html_url}`,
        `- Branch: \`${branch}\``,
        `- Commit: ${wr.head_sha}`,
        `- Trigger: ${wr.event}${wr.actor ? ` by ${wr.actor.login}` : ""}`,
        "",
        `Key: ${key}`,
      ].join("\n"),
      labels: [env.CI_ISSUE_LABEL || "ci-failure"],
    });
    return Response.json({ created: issue.html_url });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}

export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).text();
    const unfolded = raw.replace(/=\r?\n/g, "");
    const decoded = unfolded.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const subject = (decoded.match(/^Subject:\s*(.+)$/im) || [])[1] || message.headers.get("subject") || "(no subject)";
    console.log(JSON.stringify({ from: message.from, to: message.to, subject }));
    const hits = linksOf(decoded);
    if (!hits.length) {
      console.log("no sentry issue link — ignored");
      return;
    }
    for (const h of new Map(hits.map((h) => [h.issueId, h])).values()) {
      try {
        const r = await ensureIssue(env, { ...h, title: subject.replace(/^re:\s*/i, "").trim(), source: `email from ${message.from}` });
        console.log(JSON.stringify(r));
      } catch (e) {
        console.error(String(e));
      }
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/github" && request.method === "POST") return handleGitHub(request, env);
    if (url.pathname !== "/webhook" || request.method !== "POST") return new Response("not found", { status: 404 });
    const raw = await request.text();
    if (env.SENTRY_CLIENT_SECRET && !(await verifySignature(request, env.SENTRY_CLIENT_SECRET, raw))) {
      return new Response("bad signature", { status: 401 });
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
    if (request.headers.get("sentry-hook-resource") !== "issue" || payload.action !== "created") {
      return new Response("ignored");
    }
    const issue = payload.data && payload.data.issue;
    if (!issue) return new Response("no issue", { status: 400 });
    const issueId = String(issue.id);
    const permalink = issue.permalink || issue.web_url || `issue ${issueId}`;
    try {
      const r = await ensureIssue(env, { issueId, permalink, title: issue.title || `Sentry issue ${issueId}`, source: "webhook" });
      return Response.json(r);
    } catch (e) {
      return new Response(String(e), { status: 502 });
    }
  },
};
