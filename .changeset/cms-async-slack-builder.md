---
'@pebbletech/cms': minor
---

`notifySlackOnCreate` takes an async message builder as well as a sync one, so a notice can look something up (such as
a running count) before it formats. A throw or rejection while building is logged and never fails the create.
