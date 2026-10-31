# pebble-aws-bootstrap

The shared AWS bootstrap: one Pulumi stack per account (`stg` for pbt-stg, `prd` for pbt-prd) that creates what every
product's `DeployRole` from `@pebbletech/infra` expects to exist, and the topic every product's alarms notify. Kong
applies it by hand with SSO, once per account. Nothing in it belongs to a product.

| Resource | stg (pbt-stg) | prd (pbt-prd) |
|---|---|---|
| GitHub Actions OIDC provider | `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`, adopted from SST's bootstrap | same |
| Pulumi state bucket | `pebble-stg-pulumi-state` | `pebble-prd-pulumi-state` |
| Bucket encryption key | `alias/pebble-stg-pulumi-state` | `alias/pebble-prd-pulumi-state` |
| State secrets keys | `alias/pebble-stg-pulumi-preview`, `alias/pebble-stg-pulumi-staging` | `alias/pebble-prd-pulumi-prod` |
| Alarm topic, emailing `alarmEmail` | `pebble-stg-alarms` | `pebble-prd-alarms` |

- The bucket is versioned, blocks all public access, encrypts with SSE-KMS under its own key (S3 Bucket Keys on), and
  deletes a superseded state file 30 days after it was replaced. Principals in the account may use the bucket key only
  through S3, so a deploy role's S3 permissions (its own state path) decide what it can read.
- Each state secrets key is left to the account's IAM policies. A product's deploy role for `preview`, `staging` or
  `prod` may use only its own env's key. There is no `shared` key: a product's `shared` stack is applied by its
  staging deploy role, so it uses the staging key. This stack's own secrets use the staging key on stg and the prod
  key on prd.
- The key alias and bucket names come from `@pebbletech/infra` (`stateKeyAlias`, `stateBucketName`), the same
  functions `DeployRole` uses. A test fails if the two ever disagree.
- Every resource but the email subscription is protected and retained: `pulumi destroy`, or a change that would
  delete or replace one, fails; after `pulumi state unprotect` a delete still leaves the resource in AWS and only drops
  it from the state. The subscription is neither, so a new `alarmEmail` replaces it and unsubscribes the old address.
- The alarm topic is where products' CloudWatch alarms send notifications: each product passes the `alarmTopicArn`
  output to its `ApiFunction`s (`alarm: { topicArn }`). It emails the `alarmEmail` address, which AWS asks to confirm
  first: the subscription stays pending, and nothing is delivered, until the address owner clicks the link in AWS's
  confirmation email. The topic is not encrypted and keeps SNS's default access policy, under which CloudWatch alarms
  in the same account may publish. Encrypting it would need a customer-managed KMS key whose policy lets
  `cloudwatch.amazonaws.com` use it; with the AWS-managed `alias/aws/sns` key, alarms fail to publish and nobody is
  told. A notification carries an alarm's name, state and reason, nothing secret. The topic is in the stack's
  `aws:region`; an alarm notifies a topic in its own region.
- The program pins the AWS provider to the stack's `accountId`, so credentials for the wrong account fail before
  anything changes. The account id is stored as an encrypted config value: this repository is public, and a test
  fails if a committed stack file holds it in plain text.

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
   pulumi config set --secret accountId "$(aws sts get-caller-identity --query Account --output text)"
   pulumi config set --secret alarmEmail '<the address that receives alarm emails>'
   ```

   `--secret` stores the account id and the address in `Pulumi.stg.yaml` as ciphertext under the passphrase. Step 6
   re-encrypts them under the KMS key before anything is committed. The program refuses the committed placeholder
   (`set-me`) and anything else that is not an email address.

3. Preview. `Pulumi.stg.yaml` has `oidc.import: true`, so the existing OIDC provider is adopted, not created:

   ```sh
   pulumi preview
   ```

   Expect one `import` (`github-actions`, the OIDC provider) and only `create` for the rest: the AWS provider, the bucket
   and its four settings, the bucket key, the preview and staging keys with their aliases, and the alarm topic and its
   email subscription. No update, no replace, no delete, no warning. If it is anything else, stop (see [When the preview is not what you expect](#when-the-preview-is-not-what-you-expect)).

4. Apply:

   ```sh
   pulumi up
   ```

5. Run it a second time:

   ```sh
   pulumi up
   ```

   Expect no changes. The provider is in the stack's state under the same ID the import option names, so Pulumi
   manages it like any other resource and does not import it again. Pulumi's docs say to remove the `import` option
   once the resource is imported, so turn the flag off and check again:

   ```sh
   pulumi config set --path oidc.import false
   pulumi preview
   ```

   Expect no changes again. Both values of `oidc.import` are valid in a committed stack file; the tests check that
   the program imports exactly when the flag is on.

6. Move the stack's state into the bucket it created, and its secrets (the account id) to the staging key:

   ```sh
   pulumi stack export --file /tmp/pebble-aws-bootstrap-stg.json
   pulumi login 's3://pebble-stg-pulumi-state/bootstrap?region=ap-southeast-1'
   pulumi stack init stg
   pulumi stack import --file /tmp/pebble-aws-bootstrap-stg.json
   pulumi stack change-secrets-provider 'awskms://alias/pebble-stg-pulumi-staging?region=ap-southeast-1'
   unset PULUMI_CONFIG_PASSPHRASE
   pulumi config get accountId
   pulumi preview
   ```

   `stack init` reuses the passphrase salt in `Pulumi.stg.yaml`, so the account id's passphrase ciphertext still
   decrypts with the same `PULUMI_CONFIG_PASSPHRASE`. `change-secrets-provider` then decrypts every secret, in the
   stack file and in the state, and encrypts it again under a data key from the KMS key: `Pulumi.stg.yaml` now names
   the KMS key, carries the encrypted data key, and holds the account id as new ciphertext. With the passphrase
   unset, `pulumi config get accountId` prints the pbt-stg account id (decrypted through KMS), and the preview shows no
   changes.

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

   The outputs are `oidcProviderArn`, `stateBucket`, `keyAliasArns` and `alarmTopicArn`. `Pulumi.stg.yaml` now holds
   the region and the import flag (off) in plain text, the KMS secrets provider, the encrypted data key, and the
   account id and alarm address as ciphertext only. Check before committing: `grep -A1 -e accountId -e alarmEmail
   Pulumi.stg.yaml` shows `secure: v1:…` for both, never digits or an address.

9. Confirm the subscription: AWS has emailed the address a link (subject "AWS Notification - Subscription
   Confirmation"). Until its owner clicks it, the subscription is pending and alarms email no one.
   `aws sns list-subscriptions-by-topic --topic-arn "$(pulumi stack output alarmTopicArn)"` shows
   `PendingConfirmation` as the subscription ARN until then.

## Apply pbt-prd

The same nine steps with these substitutions:

| In the stg steps | For prd |
|---|---|
| `AWS_PROFILE=pbt-stg` | `AWS_PROFILE=pbt-prd` |
| stack `stg`, `Pulumi.stg.yaml` | stack `prd`, `Pulumi.prd.yaml` |
| `s3://pebble-stg-pulumi-state/bootstrap?region=ap-southeast-1` | `s3://pebble-prd-pulumi-state/bootstrap?region=ap-southeast-1` |
| `awskms://alias/pebble-stg-pulumi-staging?region=ap-southeast-1` | `awskms://alias/pebble-prd-pulumi-prod?region=ap-southeast-1` |
| `/tmp/pebble-aws-bootstrap-stg.json` | `/tmp/pebble-aws-bootstrap-prd.json` |

The prd preview in step 3 creates only the prod key and alias, not preview or staging.

## Later runs

```sh
cd bootstrap
aws sso login --sso-session pbt
export AWS_PROFILE=pbt-stg   # or pbt-prd
pulumi login 's3://pebble-stg-pulumi-state/bootstrap?region=ap-southeast-1'   # or pebble-prd-…
pulumi up -s stg             # or prd
```

Rebuild first (`corepack pnpm build` at the root) if the program changed.

## Add the alarm topic to an applied stack

`@pebbletech/infra` 0.4.0 added the alarm topic. On a stack applied before it, once per account, after the
[later-run login](#later-runs) and a rebuild:

```sh
pulumi config set --secret alarmEmail '<the address that receives alarm emails>'
pulumi preview      # expect two creates: the topic and its email subscription; nothing else
pulumi up
pulumi stack output alarmTopicArn
git add Pulumi.stg.yaml   # or Pulumi.prd.yaml; the address is ciphertext only
```

Then confirm the subscription (step 9 above). Each product passes `alarmTopicArn` to its `ApiFunction`s; a product
stores it per GitHub environment (the pbt-stg topic for previews and staging, the pbt-prd topic for production), not
in source, because the ARN holds the account id.

## When the preview is not what you expect

- **`EntityAlreadyExists: Provider with url https://token.actions.githubusercontent.com already exists`** (as a
  `create` failing during `pulumi up`): the provider exists but `oidc.import` is off. AWS allows one provider per URL
  per account. Set `pulumi config set --path oidc.import true` and preview again.
- **The import fails because the provider does not exist** (a fresh account such as pbt-dev): set
  `pulumi config set --path oidc.import false` and the program creates it.
- **A warning on `github-actions` in the preview that its inputs differ from the existing resource**: the existing
  provider differs from the program's URL, audience (`sts.amazonaws.com`) or thumbprints. Pulumi lets the preview
  through with that warning, but `pulumi up` fails the import with an error. Compare with
  `aws iam get-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`.
  Tags are ignored on purpose (Pulumi copies ignored properties from the existing resource before it compares);
  anything else needs a decision before the import.
- **`AWS account ID not allowed`**: the credentials belong to another account than the stack's `accountId`. Check
  `AWS_PROFILE`.
- **A `create` for the bucket fails with `BucketAlreadyExists`**: bucket names are global; someone owns
  `pebble-<stg|prd>-pulumi-state`. Stop: every `DeployRole` derives that name.

## SST's bootstrap still owns the provider

base-app's `infra/bootstrap/sst.config.ts` (SST app `base-app-github-oidc`) created the OIDC provider as
`aws.iam.OpenIdConnectProvider` named `GithubActionsOidc`, and SST's state still lists it. On stg that app uses
`removal: remove`, so `sst remove --stage stg` there would delete the provider this stack now manages, and every
deploy role in the account would stop working. Before retiring SST's bootstrap in either account, drop the provider
from SST's state, from the base-app repository root, with that account's SSO profile:

```sh
pnpm with-env sst state remove GithubActionsOidc --config infra/bootstrap/sst.config.ts --stage stg   # then --stage prd
```

Its URN is `urn:pulumi:<stg|prd>::base-app-github-oidc::aws:iam/openIdConnectProvider:OpenIdConnectProvider::GithubActionsOidc`.
After that, `sst remove` deletes only the old deploy role (`GithubActionsDeploy`, `base-app-monorepo-<stg|prd>-github`).
This step belongs to the base-app cutover, as for the other resources adopted from SST.
