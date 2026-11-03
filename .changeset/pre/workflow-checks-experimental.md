---
'@pebbletech/infra': patch
---

`checkWorkflows` is marked experimental, and the README lists its two known gaps: a literal matrix `include` with two entries on one stack, and a secret read after a quoted `}}` in the same expression.
