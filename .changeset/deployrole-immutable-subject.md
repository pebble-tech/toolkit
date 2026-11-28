---
'@pebbletech/infra': minor
---

`DeployRole` takes an optional `github.subjectPrefix` for a repo whose GitHub OIDC subject is immutable
(`repo:<org>@<id>/<repo>@<id>`). The role then trusts `<subjectPrefix>:environment:<env>` only. Only that form or
`repo:<org>/<repo>`, with the given `org` and `repo`, is accepted; anything else throws. Unset, the trust policy is
unchanged.
