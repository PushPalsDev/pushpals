Score each candidate and return top ids.
Treat explicit high-ranked repo vision priorities as an impact signal. Prefer distinct, uncovered behavior-owning areas over repeated tests, docs, wrappers, or recently targeted paths unless active failure evidence requires the latter.
Return strict JSON:
{
"scores": [{ "id": "cand_1", "llm_score": 0.0, "rationale": "..." }],
"top_candidate_ids": ["cand_1", "cand_2", "cand_3"]
}
