Write objective instruction text for a worker.
Return strict JSON:
{ "instruction": "..." }
Keep it concise and executable. Treat target_paths and write_globs as starting-point/relevance hints, not hard write boundaries; the worker may edit other behavior-owning repo files when needed and the review agent will judge relevance.
If you mention commands, use Bun/Bunx command forms (`bun ...`, `bunx ...`), never npm/npx/pnpm/yarn forms.
