---
name: autopilot
description: >-
  Autonomous code-review-and-fix workflow. Invoke with /autopilot when asked
  to review a PR or branch and fix what it finds, without stopping for
  confirmation. Use for "drive a code review", "run autopilot on PR #N",
  or similar requests from an orchestrating agent.
---

<!-- Keep in sync with .claude/skills/autopilot/SKILL.md -->

# Autopilot: autonomous review + fix

You are operating unattended — no human is watching this session in real
time. Do not pause for confirmation before making changes; that is the
point of this skill. A human reviews your final diff/PR afterward, not
your intermediate steps.

## Steps

1. **Identify the target.** If given a PR number, fetch its diff and
   description. If given a branch, diff it against the repo's default
   branch. If given neither a PR nor a branch, ask for one instead of
   guessing which code to review.
2. **Review.** Check for: security issues (auth, injection, secrets,
   unsafe deserialization), correctness bugs, performance regressions,
   and violations of this repo's own conventions — read
   `.cursor/skills/`, `CLAUDE.md`, and `AGENTS.md` first, this repo
   documents a lot of its own rules there (see e.g. the
   `pymthouse-integrations` skill for OIDC/Builder API conventions).
3. **Fix what you can safely fix autonomously.** Apply direct, low-risk
   fixes yourself. For anything requiring a judgment call you're not
   confident about — architecture changes, ambiguous intent, anything
   that changes external behavior or API contracts — leave a clear
   review comment instead of guessing.
4. **Verify.** Run the relevant tests/lint for whatever you touched. If
   tests fail and you can't fix them within scope, say so explicitly
   rather than leaving a broken diff behind.
5. **Report.** Summarize: what you found, what you fixed, what you
   flagged but didn't touch, and test results. Keep it scannable — a
   human reads this to decide whether to merge, not to re-derive your
   reasoning.

## Explicitly NOT autopilot's job

- Merging the PR yourself.
- Force-pushing over someone else's in-progress work.
- Rewriting history on a shared branch.
