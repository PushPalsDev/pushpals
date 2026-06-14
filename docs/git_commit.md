# Git Commit Workflow

Use this workflow for committing directly to `main` in this repository.

## Standard Flow

1. Confirm the working tree and current branch.

```powershell
git status --short --branch
```

2. Stage the intended files only.

```powershell
git add <paths>
```

3. Commit with a focused message.

```powershell
git commit -m "type(scope): concise summary"
```

4. Sync with remote using rebase, not a merge commit.

```powershell
git pull --rebase
```

5. Push the committed work.

```powershell
git push
```

## Notes

- Keep commits scoped: do not include unrelated local edits, logs, caches, `node_modules`, runtime outputs, or temporary files.
- Run the relevant tests/checks before committing when the change is not documentation-only.
- If `git pull --rebase` reports conflicts, resolve them, rerun relevant tests/checks, and continue the rebase before pushing.
- If `git pull --rebase` reports local changes, either finish/stage them intentionally or stash them before retrying the pull.
- On Windows, if pulling or pushing fails with a certificate-store error, retry the same command with Schannel:

```powershell
git -c http.sslBackend=schannel pull --rebase
git -c http.sslBackend=schannel push
```

