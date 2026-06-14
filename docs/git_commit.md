# Git Commit Workflow

Use this workflow for committing directly to `main` in this repository.

## Standard Flow

1. Confirm the working tree and current branch.

```powershell
git status --short --branch
```

2. Sync with remote using rebase, not a merge commit.

```powershell
git pull --rebase
```

3. Stage the intended files only.

```powershell
git add <paths>
```

4. Commit with a focused message.

```powershell
git commit -m "type(scope): concise summary"
```

5. Push to `main`.

```powershell
git push origin main
```

## Notes

- Keep commits scoped: do not include unrelated local edits, logs, caches, `node_modules`, runtime outputs, or temporary files.
- Run the relevant tests/checks before committing when the change is not documentation-only.
- If `git pull --rebase` reports local changes, either finish/stage them intentionally or stash them before retrying the pull.
- On Windows, if pushing fails with a certificate-store error, retry the same push with Schannel:

```powershell
git -c http.sslBackend=schannel push origin main
```

