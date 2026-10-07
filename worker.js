// github-issue-monitoring — turns Sentry signals into GitHub issues.
//   email: Sentry alert mail routed via Cloudflare Email Routing (e.g. sentry@alerts.example.com)
//   fetch: Sentry internal-integration webhook POST /webhook
// Config:  GH_REPO (var, "owner/repo" — issues are filed here), ISSUE_LABEL (optional var, default "sentry")
// Secrets: GITHUB_TOKEN (issues:write on GH_REPO), SENTRY_CLIENT_SECRET (optional, verifies webhooks)

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

async function verifySignature(request, secret, raw) {
  const sig = request.headers.get("sentry-hook-signature");
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === sig;
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
