---
description: Regenerate Playwright visual baselines after reviewing every diff — refuses on a genuine regression, updates only the confirmed scope, then proves the visual suite green.
argument-hint: [spec path, test title, or snapshot name — defaults to the whole visual project]
---

Invoke the **update-baselines** skill (`skills/update-baselines/SKILL.md`) with this scope: ${ARGUMENTS:-the whole visual project}
