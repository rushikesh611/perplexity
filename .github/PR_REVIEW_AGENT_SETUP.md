# PR Review Agent — setup

## What this is

A GitHub Actions workflow that reviews every PR the way a senior engineer
would: correctness, security, maintainability, and whether the PR
description actually matches the diff. It posts one comment per PR (and
updates it on every new commit), and if it finds a concrete fix, it proposes
a patch you can approve with a `/apply-fix` comment — it never pushes code
without that explicit approval.

The agent's behavior lives entirely in `.github/agents/pr-review-agent.md`
(plain markdown, same shape as the personas in
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)) — edit
that file to change what it looks for or how strict it is, no code changes
needed.

## Files

```
.github/
├── agents/
│   └── pr-review-agent.md       # the agent's persona + output contract
├── workflows/
│   └── pr-review-agent.yml      # triggers: PR open/sync, and /apply-fix comments
├── scripts/
│   ├── review.py                # calls OpenRouter, posts the review comment
│   └── apply_fix.py             # applies the approved patch on request
└── PR_REVIEW_AGENT_SETUP.md     # this file
```

This is the Python variant — same behavior and same `pr-review-agent.md`
persona as the Node version, just implemented with `requests` instead of
`fetch`. The workflow installs Python 3.12 and `pip install requests` as a
step; no `requirements.txt` needed for a two-script setup like this, but
feel free to add one if you'd rather pin the `requests` version.

Copy the `.github/agents/`, `.github/workflows/pr-review-agent.yml`, and
`.github/scripts/` paths into your repo as-is.

## 1. Get a free OpenRouter API key

1. Sign up at [openrouter.ai](https://openrouter.ai) (no card needed for
   free models).
2. Create an API key under **Settings → Keys**.
3. By default the workflow uses `openrouter/free` — OpenRouter's own router
   that picks a free model per-request and supports structured JSON output.
   No model name to keep up to date yourself.
   - To pin a specific free model instead, set a repo variable
     `OPENROUTER_MODEL` (Settings → Secrets and variables → Actions →
     Variables) to something like `qwen/qwen3-coder:free` — check
     [openrouter.ai/models?max_price=0](https://openrouter.ai/models?max_price=0)
     for the current free list, since it rotates.
   - Free-tier limits are roughly 20 requests/minute and 50–1,000
     requests/day depending on account history — plenty for PR review on a
     normal repo, but worth knowing if you have a very high PR volume.

## 2. Add the secret

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**

- Name: `OPENROUTER_API_KEY`
- Value: the key from step 1

`GITHUB_TOKEN` is provided automatically by Actions — nothing to set up
there, just make sure workflow permissions allow it to comment and push (see
below).

## 3. Check repo workflow permissions

**Settings → Actions → General → Workflow permissions** — set to
**"Read and write permissions"**. The workflow's own `permissions:` block
also declares `contents: write`, `pull-requests: write`, `issues: write`
explicitly, but the repo-level setting must allow it too.

## 4. How it behaves

- **On PR open / new commit:** posts (or updates) one comment with a
  verdict, findings split into must-fix/suggestion/nit, a dedicated security
  section, and a check on whether the PR description matches the diff.
- **If it finds a safe, scoped fix** for a must-fix or security issue, it
  includes a suggested patch in a collapsible section and asks you to
  comment `/apply-fix` to have it applied.
- **`/apply-fix`:** only works for repo owners/members/collaborators (checked
  via GitHub's `author_association`, no separate allowlist to maintain). It
  applies the most recent suggested patch to the PR branch, commits, and
  pushes. If the branch has moved on and the patch no longer applies
  cleanly, it says so instead of guessing.
- **Forked PRs:** `GITHUB_TOKEN` can't push to a contributor's fork, so
  `/apply-fix` on a fork PR will tell you to apply the diff manually instead
  of silently failing.

## 5. Customizing the review

Everything about *what* the agent checks for and *how* it phrases findings
is in `.github/agents/pr-review-agent.md` — it's the system prompt, not
code. Common tweaks:

- Add a "Project conventions" section listing your repo's specific
  standards (e.g. required error-handling pattern, forbidden libraries).
- Narrow `Review Axes` if you want it security-only, or add a fifth axis
  (e.g. performance) for perf-sensitive repos.
- Adjust the `verdict` rule at the bottom if you want a stricter or looser
  bar for `request_changes`.

## Limitations to know about

- Free models are smaller than frontier models — treat findings as a strong
  first pass, not a replacement for human review, especially on
  security-critical changes.
- The diff and file contents sent to the model are capped (60k chars for
  the diff, 4k per file, 12 files) to stay within free-tier context and
  rate limits — very large PRs will get a partial review, and the comment
  says so when that happens. Prefer smaller PRs; this cap is also good
  practice for the same review-quality reasons the agent itself flags.
- The model occasionally returns malformed JSON despite the schema
  instructions; `review.mjs` will fail that run rather than post a garbled
  comment — check the Action log and re-run if it happens.
