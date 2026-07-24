# Comparison Policy

Comparison is a decision aid, not an objective probability model. Hard gates run first. Surviving opportunities are assessed in four distinct panels: `demand_and_market`, `solution_and_business`, `evidence_strength`, and `team_fit_and_learning`.

Each panel uses observable anchors and returns `strong`, `medium`, `weak`, `unknown`, or `not_applicable` with supporting/opposing references and limitations. Unknown values remain unknown. Evidence strength controls conclusion ceiling and uncertainty; it does not add attractiveness points. Correlated demand signals are not mechanically summed, and AI-only dimensions are `not_applicable` for non-AI solutions.

Ordering uses pairwise dominance, downside/upside relations, speed to learn, and partial orders. The user-facing output may identify a robust leader group, close-to-indistinguishable candidates, or insufficient evidence for ordering. It never exposes a pseudo-precise global score or success probability.

Policies and profiles are published and versioned. A user or agent may select an available profile through Decision Context but may not reweight individual dimensions during an active Run. G2.4 owns the implementation of comparison and sensitivity calculations.
