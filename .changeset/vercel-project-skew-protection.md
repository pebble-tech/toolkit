---
'@pebbletech/infra': minor
---

`VercelProject` turns on Vercel Skew Protection for the `shared` project, so an open tab keeps reaching the deployment
it loaded from after a deploy.

- `project.skewProtection`, typed `SkewProtectionMaxAge` (`'30 minutes' | '4 hours' | '12 hours' | '1 day' | '7 days'`,
  the values `@pulumiverse/vercel` 5.21.1 accepts), sets the maximum age. Default `'12 hours'`, Vercel's default on Pro.
  `false` turns it off.
- An existing project gets it on its next `shared` `up`: an update of the project, nothing replaced. The provider sends
  every project setting it manages in that update, so a dashboard change to any of them is reset to the program's
  value.
- README "Skew Protection": a prebuilt deploy (`vercel build`, `vercel deploy --prebuilt`) pins nothing until the build
  sets its own `deploymentId` in `.vercel/output/config.json` (unique per deploy, at most 32 characters, letters, digits,
  `-` and `_`, not starting with `dpl_`); a contract migration waits until every deployment that read the old shape is
  older than the maximum age.
