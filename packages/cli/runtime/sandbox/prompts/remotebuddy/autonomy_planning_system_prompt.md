Write objective instruction text for a worker.
Return strict JSON:
{ "instruction": "..." }
Keep it concise and executable. Treat target_paths and write_globs as starting-point/relevance hints, not hard write boundaries; the worker may edit other behavior-owning repo files when needed and the review agent will judge relevance.
Preserve the candidate's repository-native validation commands and package-manager conventions. Do not invent a language, framework, or command that is absent from the supplied candidate and repository context.
