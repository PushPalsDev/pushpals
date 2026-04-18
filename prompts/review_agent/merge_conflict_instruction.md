Resolve merge conflicts for PR #{{pr_number}} ({{pr_url}}) on branch {{pr_head_ref}}.
This PR already passed ReviewAgent ({{review_score}}/10) but GitHub reports it is not mergeable due to conflicts.
Rebase {{pr_head_ref}} onto {{pr_base_ref}}, resolve all conflicts, keep intended behavior, run relevant tests, and push updates to the same branch.
If the worker sandbox already prepared an isolated branch or in-progress rebase state, use that current repo state as authoritative instead of re-deriving branch topology.
Do not create a new PR; update only the existing PR branch.
