"""PR Review Agent — gathers PR context, asks a free OpenRouter model for a
structured review, and posts/updates a single comment on the PR.

Requires: GITHUB_TOKEN, OPENROUTER_API_KEY, REPO ("owner/repo"), PR_NUMBER
Python 3.10+, `pip install requests`.
"""

import base64
import json
import os
import re
import sys

import requests

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
REPO = os.environ.get("REPO")
PR_NUMBER = os.environ.get("PR_NUMBER")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openrouter/free")

if not all([GITHUB_TOKEN, OPENROUTER_API_KEY, REPO, PR_NUMBER]):
    print("Missing required environment variables.", file=sys.stderr)
    sys.exit(1)

OWNER, REPO_NAME = REPO.split("/")
GH_API = "https://api.github.com"
COMMENT_MARKER = "<!-- pr-review-agent -->"
MAX_DIFF_CHARS = 60_000
MAX_FILE_CHARS = 4_000
MAX_FILES_IN_CONTEXT = 12


def gh_headers(accept="application/vnd.github+json"):
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": accept,
        "X-GitHub-Api-Version": "2022-11-28",
    }


def gh_json(path):
    res = requests.get(f"{GH_API}{path}", headers=gh_headers())
    res.raise_for_status()
    return res.json()


def get_pr_diff():
    res = requests.get(
        f"{GH_API}/repos/{OWNER}/{REPO_NAME}/pulls/{PR_NUMBER}",
        headers=gh_headers("application/vnd.github.v3.diff"),
    )
    res.raise_for_status()
    return res.text


def truncate(text, max_len):
    if len(text) <= max_len:
        return text, False
    return text[:max_len] + "\n... [truncated]", True


def get_changed_file_contents(files, head_sha):
    picked = [f for f in files if f["status"] != "removed"][:MAX_FILES_IN_CONTEXT]
    results = []
    for f in picked:
        try:
            data = gh_json(
                f"/repos/{OWNER}/{REPO_NAME}/contents/{f['filename']}?ref={head_sha}"
            )
            if data.get("encoding") == "base64" and data.get("content"):
                content = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
                text, truncated = truncate(content, MAX_FILE_CHARS)
                results.append({"path": f["filename"], "content": text, "truncated": truncated})
        except Exception:
            # Binary, too large, or renamed — skip, the diff still covers it.
            continue
    return results


def load_persona():
    with open(".github/agents/pr-review-agent.md", "r", encoding="utf-8") as fh:
        raw = fh.read()
    # Strip YAML frontmatter between the first pair of --- lines.
    return re.sub(r"^---\n[\s\S]*?\n---\n", "", raw).strip()


def extract_json(text):
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\n?", "", cleaned)
    cleaned = re.sub(r"```$", "", cleaned).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("No JSON object found in model response")
    return json.loads(cleaned[start : end + 1])


# Free "reasoning" models count their thinking tokens against max_tokens. If
# the budget runs out mid-thought the API returns finish_reason="length" with
# empty content. So: ask for low reasoning effort first, then retry with a
# bigger budget and reasoning switched off, then with a bigger budget and no
# hints at all (some models ignore or reject the reasoning parameter).
ATTEMPTS = [
    {"max_tokens": 8000, "reasoning": {"effort": "low"}},
    {"max_tokens": 16000, "reasoning": {"enabled": False}},
    {"max_tokens": 16000},
]


def _post_to_model(system_prompt, user_prompt, extra):
    return requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": f"https://github.com/{REPO}",
            "X-Title": "PR Review Agent",
        },
        json={
            "model": OPENROUTER_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
            **extra,
        },
        timeout=180,
    )


def call_model(system_prompt, user_prompt):
    last_error = None
    for attempt, extra in enumerate(ATTEMPTS, start=1):
        try:
            res = _post_to_model(system_prompt, user_prompt, extra)
            if res.status_code >= 400:
                raise RuntimeError(f"HTTP {res.status_code}: {res.text[:300]}")
            data = res.json()
            choice = (data.get("choices") or [{}])[0]
            content = (choice.get("message") or {}).get("content")
            if not content:
                usage = data.get("usage") or {}
                raise ValueError(
                    f"empty content (model={data.get('model')}, "
                    f"finish_reason={choice.get('finish_reason')}, "
                    f"completion_tokens={usage.get('completion_tokens')})"
                )
            return extract_json(content)
        except (ValueError, RuntimeError, requests.RequestException) as exc:
            last_error = exc
            print(f"Attempt {attempt}/{len(ATTEMPTS)} failed: {exc}", file=sys.stderr)
    raise RuntimeError(
        f"All {len(ATTEMPTS)} model attempts failed. Last error: {last_error}. "
        "Try pinning a non-reasoning free model via the OPENROUTER_MODEL repo variable."
    )


SEVERITY_EMOJI = {
    "must_fix": "🔴",
    "suggestion": "🟡",
    "nit": "⚪",
    "critical": "🔴",
    "high": "🟠",
    "medium": "🟡",
    "low": "⚪",
}


def render_findings(findings, empty_text):
    if not findings:
        return empty_text
    lines = []
    for f in findings:
        loc = f.get("file", "")
        if f.get("line"):
            loc += f":{f['line']}"
        emoji = SEVERITY_EMOJI.get(f.get("severity"), "•")
        lines.append(
            f"- {emoji} **{f.get('severity')}** `{loc}` ({f.get('category')}) — {f.get('issue')}\n"
            f"  → {f.get('suggestion')}"
        )
    return "\n".join(lines)


def render_comment(review, model, diff_truncated):
    verdict_label = {
        "approve": "✅ Approve",
        "comment": "💬 Comment",
        "request_changes": "❌ Request changes",
    }.get(review.get("verdict"), review.get("verdict"))

    body = f"{COMMENT_MARKER}\n## 🤖 PR Review Agent\n\n"
    body += f"**Verdict:** {verdict_label}\n\n"
    body += f"{review.get('summary', '')}\n\n"

    if diff_truncated:
        body += (
            f"> ⚠️ The diff was too large to review in full — this review only "
            f"covers the first {MAX_DIFF_CHARS:,} characters of the diff.\n\n"
        )

    body += f"### Findings\n{render_findings(review.get('findings'), 'No correctness/maintainability issues found.')}\n\n"
    body += f"### Security\n{render_findings(review.get('security_findings'), 'No security issues found.')}\n\n"

    body += "### PR description\n"
    dc = review.get("description_check") or {}
    if dc.get("matches_changes"):
        body += f"✅ Matches the diff. {dc.get('feedback', '')}\n\n"
    else:
        body += f"⚠️ {dc.get('feedback', 'Description may not match the changes.')}\n\n"
    if dc.get("suggested_description"):
        body += f"<details><summary>Suggested description</summary>\n\n{dc['suggested_description']}\n\n</details>\n\n"

    patch = review.get("suggested_patch")
    if patch:
        body += "### Suggested patch\n"
        body += (
            "Comment `/apply-fix` on this PR to have the agent apply this patch "
            "to the PR branch (requires write access to this repo).\n\n"
        )
        body += f"<details><summary>Show patch</summary>\n\n```diff\n{patch}\n```\n\n</details>\n\n"
        encoded = base64.b64encode(patch.encode("utf-8")).decode("ascii")
        body += f"<!-- pr-review-agent-patch\n{encoded}\npr-review-agent-patch -->\n"

    body += f"\n---\n*Reviewed by `{model}` via OpenRouter. This is an automated review — use judgment.*"
    return body


def upsert_comment(body):
    comments = gh_json(f"/repos/{OWNER}/{REPO_NAME}/issues/{PR_NUMBER}/comments?per_page=100")
    existing = next((c for c in comments if COMMENT_MARKER in (c.get("body") or "")), None)

    if existing:
        url = f"{GH_API}/repos/{OWNER}/{REPO_NAME}/issues/comments/{existing['id']}"
        res = requests.patch(url, headers=gh_headers(), json={"body": body})
    else:
        url = f"{GH_API}/repos/{OWNER}/{REPO_NAME}/issues/{PR_NUMBER}/comments"
        res = requests.post(url, headers=gh_headers(), json={"body": body})
    res.raise_for_status()


def main():
    pr = gh_json(f"/repos/{OWNER}/{REPO_NAME}/pulls/{PR_NUMBER}")
    head_sha = pr["head"]["sha"]

    files = gh_json(f"/repos/{OWNER}/{REPO_NAME}/pulls/{PR_NUMBER}/files?per_page=100")
    raw_diff = get_pr_diff()
    diff, diff_truncated = truncate(raw_diff, MAX_DIFF_CHARS)
    file_contents = get_changed_file_contents(files, head_sha)

    persona = load_persona()

    files_summary = "\n".join(
        f"- {f['status']}: {f['filename']} (+{f['additions']}/-{f['deletions']})" for f in files
    )
    context_blocks = ""
    if file_contents:
        context_blocks = "## Current contents of changed files (for writing a valid patch)\n" + "\n\n".join(
            f"### {f['path']}{' (truncated)' if f['truncated'] else ''}\n```\n{f['content']}\n```"
            for f in file_contents
        )

    user_prompt = "\n\n".join(
        part
        for part in [
            f"## PR Title\n{pr['title']}",
            f"## PR Description\n{pr.get('body') or '(no description provided)'}",
            f"## Changed files ({len(files)})\n{files_summary}",
            f"## Diff{' (truncated)' if diff_truncated else ''}\n```diff\n{diff}\n```",
            context_blocks,
        ]
        if part
    )

    review = call_model(persona, user_prompt)
    body = render_comment(review, OPENROUTER_MODEL, diff_truncated)
    upsert_comment(body)

    print(f"Posted review. Verdict: {review.get('verdict')}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
