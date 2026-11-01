"""Applies the patch the PR Review Agent suggested, once a collaborator
comments "/apply-fix" on the PR. Triggered by the `apply-fix` job in
pr-review-agent.yml, which already restricts this to OWNER/MEMBER/
COLLABORATOR comment authors.

Requires: GITHUB_TOKEN, REPO ("owner/repo"), PR_NUMBER, COMMENT_AUTHOR
Python 3.10+, `pip install requests`.
"""

import base64
import os
import re
import subprocess
import sys

import requests

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
REPO = os.environ.get("REPO")
PR_NUMBER = os.environ.get("PR_NUMBER")
COMMENT_AUTHOR = os.environ.get("COMMENT_AUTHOR", "someone")

if not all([GITHUB_TOKEN, REPO, PR_NUMBER]):
    print("Missing required environment variables.", file=sys.stderr)
    sys.exit(1)

OWNER, REPO_NAME = REPO.split("/")
GH_API = "https://api.github.com"
COMMENT_MARKER = "<!-- pr-review-agent -->"
PATCH_RE = re.compile(r"<!-- pr-review-agent-patch\n([\s\S]*?)\npr-review-agent-patch -->")


def gh_headers():
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def gh_json(path):
    res = requests.get(f"{GH_API}{path}", headers=gh_headers())
    res.raise_for_status()
    return res.json()


def post_comment(body):
    requests.post(
        f"{GH_API}/repos/{OWNER}/{REPO_NAME}/issues/{PR_NUMBER}/comments",
        headers=gh_headers(),
        json={"body": body},
    )


def run(cmd):
    print(f"$ {cmd}")
    return subprocess.run(
        cmd, shell=True, check=True, capture_output=True, text=True
    )


def main():
    pr = gh_json(f"/repos/{OWNER}/{REPO_NAME}/pulls/{PR_NUMBER}")

    if (pr.get("head", {}).get("repo") or {}).get("full_name") != REPO:
        post_comment(
            f"{COMMENT_MARKER}\n⚠️ @{COMMENT_AUTHOR} This PR's branch is on a fork. "
            f"The bot's `GITHUB_TOKEN` can't push there — apply the patch from the "
            f"review comment manually."
        )
        return

    comments = gh_json(f"/repos/{OWNER}/{REPO_NAME}/issues/{PR_NUMBER}/comments?per_page=100")
    review_comment = next(
        (
            c
            for c in reversed(comments)
            if COMMENT_MARKER in (c.get("body") or "") and PATCH_RE.search(c.get("body") or "")
        ),
        None,
    )

    if not review_comment:
        post_comment(
            f"{COMMENT_MARKER}\n⚠️ @{COMMENT_AUTHOR} No pending suggested patch found "
            f"on this PR — nothing to apply."
        )
        return

    match = PATCH_RE.search(review_comment["body"])
    patch = base64.b64decode(match.group(1)).decode("utf-8")
    with open("/tmp/pr-agent.patch", "w", encoding="utf-8") as fh:
        fh.write(patch)

    branch = pr["head"]["ref"]
    run('git config user.name "pr-review-agent[bot]"')
    run('git config user.email "pr-review-agent[bot]@users.noreply.github.com"')
    run(f"git remote set-url origin https://x-access-token:{GITHUB_TOKEN}@github.com/{REPO}.git")
    run(f"git fetch origin {branch}")
    run(f"git checkout {branch}")

    try:
        run("git apply --whitespace=fix /tmp/pr-agent.patch")
    except subprocess.CalledProcessError as err:
        print(err.stdout, err.stderr, file=sys.stderr)
        post_comment(
            f"{COMMENT_MARKER}\n❌ @{COMMENT_AUTHOR} The suggested patch no longer "
            f"applies cleanly (the branch has probably changed since the review "
            f"ran). Re-run the review by pushing a new commit, then try "
            f"`/apply-fix` again."
        )
        return  # don't fail the whole workflow run over a stale patch

    run("git add -A")
    run(
        f'git commit -m "fix: apply PR review agent suggestions" '
        f'-m "Approved by @{COMMENT_AUTHOR} via /apply-fix"'
    )
    run(f"git push origin {branch}")

    post_comment(f"{COMMENT_MARKER}\n✅ @{COMMENT_AUTHOR} Applied the suggested patch to `{branch}`.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Error: {exc}", file=sys.stderr)
        post_comment(f"{COMMENT_MARKER}\n❌ @{COMMENT_AUTHOR} Applying the patch failed: `{str(exc)[:300]}`")
        sys.exit(1)
