New batch {{batch_index}}/{{batch_count}}:
{{batch_chunk}}

Current packed memory:
{{current_memory}}

Update the packed memory with maximal fidelity. Requirements:
- Preserve concrete instructions, constraints, IDs, file paths, env vars, and error text.
- Keep conflicting details if present; do not silently discard.
- Keep output under {{memory_char_budget}} characters.
- Output only packed memory plain text.
