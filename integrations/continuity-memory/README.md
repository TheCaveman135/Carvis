# Continuity Memory

Carvis's long-term memory. This integration uses a temporal claim ledger, evidence graph, atomic notes, local reflection, contradiction handling,
and tentative pattern learner. It runs locally with Node's built-in SQLite support.

Existing Carvis memories are imported once with their original source and dates.
Old versions remain available as history. Owner deletions remain deletions after a
restart. Disabled memory keeps existing owner rules active, while stopping learning.
Detected patterns never authorize actions or bypass Home Assistant device guards.
