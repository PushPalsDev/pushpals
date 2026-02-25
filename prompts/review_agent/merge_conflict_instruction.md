Resolve merge conflicts for PR #{{pr_number}} ({{pr_url}}) on branch {{pr_head_ref}}.
This PR already passed ReviewAgent ({{review_score}}/10) but GitHub reports it is not mergeable due to conflicts.
Rebase {{pr_head_ref}} onto {{pr_base_ref}}, resolve all conflicts, keep intended behavior, run relevant tests, and push updates to the same branch.
Do not create a new PR; update only the existing PR branch.
