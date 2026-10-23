# pebble-aws-bootstrap

The shared AWS bootstrap: one Pulumi stack per account (`stg` for pbt-stg, `prd` for pbt-prd) that creates what every
product's `DeployRole` from `@pebbletech/infra` expects to exist. Kong applies it by hand with SSO, once per account.
Nothing in it belongs to a product.

| Resource | stg (pbt-stg) | prd (pbt-prd) |
|---|---|---|
| GitHub Actions OIDC provider | `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`, adopted from SST's bootstrap | same |
| Pulumi state bucket | `pebble-stg-pulumi-state` | `pebble-prd-pulumi-state` |
| Bucket encryption key | `alias/pebble-stg-pulumi-state` | `alias/pebble-prd-pulumi-state` |
| State secrets keys | `alias/pebble-stg-pulumi-preview`, `alias/pebble-stg-pulumi-staging`, `alias/pebble-stg-pulumi-shared` | `alias/pebble-prd-pulumi-prod` |

- The bucket is versioned, blocks all public access, encrypts with SSE-KMS under its own key (S3 Bucket Keys on), and
  deletes a superseded state file 30 days after it was replaced. Principals in the account may use the bucket key only
  through S3, so a deploy role's S3 permissions (its own state path) decide what it can read.
- Each state secrets key is left to the account's IAM policies. A product's deploy role for `preview`, `staging` or
  `prod` may use only its own env's key. `shared` is for stacks applied by hand, such as this one; deploy roles cannot
  use it.
- The key alias and bucket names come from `@pebbletech/infra` (`stateKeyAlias`, `stateBucketName`), the same
  functions `DeployRole` uses. A test fails if the two ever disagree.
- Every resource is protected and retained: `pulumi destroy` refuses, and removing a resource from the program leaves
  it in AWS.
- The program pins the AWS provider to the stack's `accountId`, so credentials for the wrong account fail before
  anything changes.

## Before you start

- AWS CLI v2 with an SSO profile for each account on the `pbt` SSO session. If `aws configure list-profiles` has no
  `pbt-stg` (or `pbt-prd`), add it with `aws configure sso --profile pbt-stg`: session `pbt`, the pbt-stg account,
  role `AdministratorAccess`, region `ap-southeast-1`.
- Pulumi CLI 3.271 or later (`pulumi version`).
- Node 24 and corepack. From the repository root, install and build (Pulumi runs the compiled `bootstrap/dist/`):

  ```sh
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
  ```

## Apply pbt-stg

Run every command from `bootstrap/`, in one shell.

1. Log in and check you are in pbt-stg:

   ```sh
   cd bootstrap
   aws sso login --sso-session pbt
   export AWS_PROFILE=pbt-stg
   aws sts get-caller-identity
   ```

   The `Account` it prints is the pbt-stg account id.

2. Create the stack on a local backend. The state bucket does not exist yet, so the first apply keeps its state on
   this machine and moves it into the bucket afterwards (step 6). Pick a passphrase and keep it until step 6 is done;
   it protects the local state only.

   ```sh
   export PULUMI_CONFIG_PASSPHRASE='<a passphrase>'
   pulumi login --local
   pulumi stack init stg
   pulumi config set accountId "$(aws sts get-caller-identity --query Account --output text)"
   ```

3. Preview. `Pulumi.stg.yaml` has `oidc.import: true`, so the existing OIDC provider is adopted, not created:

   ```sh
   pulumi preview
   ```

   Expect one `import` (`github-actions`, the OIDC provider) and only `create` for the rest: the AWS provider, the bucket
   and its four settings, the bucket key, and the preview, staging and shared keys with their aliases. No update, no
   replace, no delete. If it is anything else, stop (see [When the preview is not what you expect](#when-the-preview-is-not-what-you-expect)).

4. Apply:

   ```sh
   pulumi up
   ```

5. Run it a second time:

   ```sh
   pulumi up
   ```

   Expect no changes: the provider is now in the stack's state, and the import option matches it. Then turn the
   import off, since there is nothing left to adopt, and check again:

   ```sh
   pulumi config set --path oidc.import false
   pulumi preview
   ```

   Expect no changes again.

6. Move the stack's state into the bucket it created, and its secrets to the `shared` key:

   ```sh
   pulumi stack export --file /tmp/pebble-aws-bootstrap-stg.json
   pulumi login 's3://pebble-stg-pulumi-state/bootstrap?region=ap-southeast-1'
   pulumi stack init stg
   pulumi stack import --file /tmp/pebble-aws-bootstrap-stg.json
   pulumi stack change-secrets-provider 'awskms://alias/pebble-stg-pulumi-shared?region=ap-southeast-1'
   unset PULUMI_CONFIG_PASSPHRASE
   pulumi preview
   ```

   `stack init` reuses the passphrase salt in `Pulumi.stg.yaml`, so it needs the same `PULUMI_CONFIG_PASSPHRASE`.
   After `change-secrets-provider`, `Pulumi.stg.yaml` names the KMS key instead, and the last preview runs without a
   passphrase and shows no changes.

7. Remove the local copy, so nobody applies against it later, then return to the bucket:

   ```sh
   pulumi login --local
   pulumi stack rm stg --force --preserve-config --yes
   pulumi login 's3://pebble-stg-pulumi-state/bootstrap?region=ap-southeast-1'
   rm /tmp/pebble-aws-bootstrap-stg.json
   ```

   `--force` drops only the local state record (the resources stay); `--preserve-config` keeps `Pulumi.stg.yaml`.

8. Read the outputs and commit the stack file:

   ```sh
   pulumi stack output
   git add Pulumi.stg.yaml
   git commit -m "chore(bootstrap): record the pbt-stg stack"
   ```

   The outputs are `oidcProviderArn`, `stateBucket` and `keyAliasArns`. `Pulumi.stg.yaml` now holds the account id,
   the import flag (off), the KMS secrets provider and the encrypted data key. None of them is a secret, but this
   repository is public: the account id becomes public with it.

## Apply pbt-prd

The same eight steps with these substitutions:

| In the stg steps | For prd |
|---|---|
| `AWS_PROFILE=pbt-stg` | `AWS_PROFILE=pbt-prd` |
| stack `stg`, `Pulumi.stg.yaml` | stack `prd`, `Pulumi.prd.yaml` |
| `s3://pebble-stg-pulumi-state/bootstrap?region=ap-southeast-1` | `s3://pebble-prd-pulumi-state/bootstrap?region=ap-southeast-1` |
| `awskms://alias/pebble-stg-pulumi-shared?region=ap-southeast-1` | `awskms://alias/pebble-prd-pulumi-prod?region=ap-southeast-1` |
| `/tmp/pebble-aws-bootstrap-stg.json` | `/tmp/pebble-aws-bootstrap-prd.json` |

The prd preview in step 3 creates only the prod key and alias, not preview, staging or shared.

## Later runs

```sh
cd bootstrap
aws sso login --sso-session pbt
export AWS_PROFILE=pbt-stg   # or pbt-prd
pulumi login 's3://pebble-stg-pulumi-state/bootstrap?region=ap-southeast-1'   # or pebble-prd-…
pulumi up -s stg             # or prd
```

Rebuild first (`corepack pnpm build` at the root) if the program changed.

## When the preview is not what you expect

- **`EntityAlreadyExists: Provider with url https://token.actions.githubusercontent.com already exists`** (as a
  `create` failing during `pulumi up`): the provider exists but `oidc.import` is off. AWS allows one provider per URL
  per account. Set `pulumi config set --path oidc.import true` and preview again.
- **The import fails because the provider does not exist** (a fresh account such as pbt-dev): set
  `pulumi config set --path oidc.import false` and the program creates it.
- **`inputs to import do not match the existing resource`**: the existing provider differs from the program's URL,
  audience (`sts.amazonaws.com`) or thumbprints. Compare with
  `aws iam get-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`.
  Tags are ignored on purpose; anything else needs a decision before the import.
- **`AWS account ID not allowed`**: the credentials belong to another account than the stack's `accountId`. Check
  `AWS_PROFILE`.
- **A `create` for the bucket fails with `BucketAlreadyExists`**: bucket names are global; someone owns
  `pebble-<stg|prd>-pulumi-state`. Stop: every `DeployRole` derives that name.

## SST's bootstrap still owns the provider

base-app's `infra/bootstrap/sst.config.ts` created the OIDC provider, and SST's state still lists it. On stg that app
uses `removal: remove`, so `sst remove --stage stg` there would delete the provider this stack now manages, and every
deploy role in the account would stop working. Before retiring SST's bootstrap in either account, remove the provider
from SST's state first (`sst state remove` for `GithubActionsOidc`), as the cutover does for the other adopted
resources.
