---
'@pebbletech/infra': minor
---

`VercelProject` pins the project's Node version, and the README says how to remove a protected prod resource.

- The `shared` project pins Node: `project.nodeVersion`, typed `NodeVersion` (`'18.x' | '20.x' | '22.x' | '24.x'`, the
  values `@pulumiverse/vercel` 5.21.1 accepts), default `24.x`. Before, the project had none and Vercel gave a new
  project its own default. The default applies to an existing project on its next `shared` `up`, and takes effect with
  its next deployment. A product that pinned Node with a transformation can drop the transformation.
- README "Remove a protected prod resource": the `pulumi state unprotect` and `pulumi state delete` steps, then the
  release, then `vercel env rm … --project <product>-web`. Prod and shared children stay protected.
- README "Verify a Vercel domain": the `_vercel` TXT record Vercel may ask for is still a hand step after the first
  `staging` or `prod` release that binds the domain.
