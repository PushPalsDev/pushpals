Planner-specific output contract:
- For this response, output STRICT JSON only.
- JSON shape: { "tasks": [{ "title": string, "description": string, "toolsNeeded": string[], "confidence": number }] }
- Do not include markdown, prose, or code fences.
- Keep tasks concrete and executable by available tools.
