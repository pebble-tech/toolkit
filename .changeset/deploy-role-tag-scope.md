---
'@pebbletech/infra': patch
---

A staging or prod `DeployRole` can now create its product's first HTTP API. Before, `CreateApi` with tags was denied (403) because its tag write, `POST /tags/<api arn>`, had no grant, so only an admin session could create one. The role is also confined to its own product. Every call under `/apis/*` (routes, integrations, stages) needs the API's `product` and `env` tags to be the role's own. Creating an API, stage or custom domain needs the request's tags to be its own. Tags can be written only while creating a resource. Certificates are requested only for the product and env's hostnames, and only the product's own certificates can be tagged. All of this was checked against pbt-stg with a real `ApiFunction` deploy, refresh and destroy as the role. Re-apply each product's `infra/bootstrap` stack to update its roles; existing APIs, stages and domains already carry the tags.
