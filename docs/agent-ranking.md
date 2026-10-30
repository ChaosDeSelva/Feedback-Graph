# Agent relevance scores

Agent context prints raw embedding similarity followed by the task rank (`match 0.91/0.84`). Both are clamped to 0–1; neither is a probability that the item applies. Every vector-ranked miss, fact and document carries a rank, even when it equals similarity. File-linked misses are structural evidence and have no invented embedding score.

For the standard semantic embedder, facts must pass both the existing 0.78 raw-similarity floor and a 0.80 weighted-rank floor before they are served. The fact rank combines similarity, stored everyday relevance and proximity to named files/services. The 0.80 threshold comes from the 0.6.8 field report; it is not a universal embedding calibration. Explicit lower-scale embedder calibrations retain their configured floor instead of inheriting the cosine-only threshold. Misses retain their existing similarity gate and proximity rank; documents have no separate weighting, so their rank equals similarity.

A task naming its own PR excludes that PR's lessons, misses and documents from independent context. Answers report the excluded PR numbers. Structural file evidence remains available for other PRs and sessions.

Ask prioritizes exact named paths and basename matches before token-ranked siblings and includes the actual symbols of those files within its existing hit budget. A known file is not described as absent merely because its symbol names differ from the question.


The weighted .80 gate applies to semantic misses and document chunks as well as facts, including linked-project results. Raw similarity must still meet .78 (or the explicitly calibrated embedder floor). Ranks are shown to three decimal places so a value just below .80 cannot look like an accepted .80. A fact tied to the exact file explicitly named by the task keeps its raw-floor match even when relevance weighting puts it below .80; this exception does not extend to sibling or unrelated files. PR exclusion uses explicit task PR identities or an explicitly named commit, never the checkout's unrelated HEAD. Text such as “PR1 of 2” is not a PR identity.
