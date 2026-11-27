---
'@pebbletech/infra': minor
---

Custom and apex production domains for `VercelProject`, a project-scoped Vercel token, and the product id `pebbletech`.

- `productionDomains` (on `prod` only) binds hostnames outside the stage shape, such as `new.pebbletech.my` or the
  apex `pebbletech.my`, to production: a project domain each, an unproxied CNAME in a zone of ours (Cloudflare
  flattens it on the apex; `zoneName` is checked against `zoneId`'s zone), an opt-in `_vercel.<zone>` TXT record made
  from Vercel's challenge (`verificationTxt`), and the `clientDnsRecords` and `verification` outputs for a client's
  zone. Resource names carry the hostname, so adding or removing one leaves the others in place.
  A production domain's zone is a stage zone (`STAGE_ZONES`, plus the stage domain's own) or a client's, never a name
  inside a stage zone. With `verificationTxt` on and no challenge listed (unverified, or already verified), the preview
  fails rather than make an empty record; the record is retained and not protected, so turning the flag off leaves it
  in the zone. `Stage.assertCustomHostname` is the new rule; `assertOwnsHostname`, and everything a program that does not pass the
  new options registers, are unchanged (pinned by compat goldens captured from 0.7.0).
- `cnameTarget` fixes every CNAME's target and skips the `getDomainConfig` lookup. A `VercelProject` takes its own
  Vercel provider through the component's `providers` option, so a stack with a marketing and a CMS project can give
  each its own project-scoped token. `runProgram` registrations now name their `provider`.
- `assertProduct` reserves only the id `pebble`, not every id that starts with it. `pebble-*` names belong to shared
  infrastructure, and a product id has no hyphen, so only `pebble` itself could name one: `pebbletech` (names
  `pebbletech-prod-*`) is a product like any other.

The toolkit repo also ships reusable `site-build` and `site-deploy` workflows for a site's previews and staging
deploys; see the README's "Site deploy workflows".
