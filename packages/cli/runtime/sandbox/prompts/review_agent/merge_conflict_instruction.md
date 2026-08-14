Resolve merge conflicts for PR #{{pr_number}} ({{pr_url}}) on branch {{pr_head_ref}}.
This PR already passed ReviewAgent ({{review_score}}/10) but GitHub reports it is not mergeable due to conflicts.
Use the prepared PR-head checkout or in-progress rebase state as authoritative. Resolve conflict markers, preserve intended behavior, and run focused tests.
Do not checkout, switch, reset, merge, rebase, stage, commit, or push. Deterministic orchestration owns branch and rebase operations; SourceControlManager alone updates {{pr_head_ref}}.
Do not create a new PR.
