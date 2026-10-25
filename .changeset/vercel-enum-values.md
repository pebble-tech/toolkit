---
"@pebbletech/infra": patch
---

`VercelProject` sends `vercelAuthentication.deploymentType` as the Vercel provider validates it: `only_preview_deployments` by default (it sent `onlyPreviewDeployments`, which the provider refuses, so `pulumi preview` of a `shared` stack failed). `PreviewProtection` is now `'only_preview_deployments' | 'standard_protection_new' | 'all_deployments'`. Every other enum-valued input the components set was checked against the real providers and is unchanged; a test now pins each one to the spelling its provider accepts.
