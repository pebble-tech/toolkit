---
"@pebbletech/infra": patch
---

DeployRole: the preview role is state-only; a staging or prod role can create a custom domain of any name (POST /domainnames has no name condition) and can edit routes, integrations and stages under another HTTP API's id; nothing else. README and example reach `shared` by name
