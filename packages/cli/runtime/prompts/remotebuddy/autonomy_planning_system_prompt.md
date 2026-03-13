Write objective instruction text for a worker.
Return strict JSON:
{ "instruction": "..." }
Keep it concise, executable, and scoped to target_paths and write_globs only.
If you mention commands, use Bun/Bunx command forms (`bun ...`, `bunx ...`), never npm/npx/pnpm/yarn forms.
