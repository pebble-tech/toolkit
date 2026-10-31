---
"@pebbletech/infra": minor
---

A product's failures that its error tracker cannot see now reach someone, with no new code beyond one ARN.

- `ApiFunction` creates one CloudWatch alarm, `<product>-<env>-<kind>-errors`, on the function's Lambda `Errors`: a crash before the handler runs, a timeout, an out-of-memory kill, a runtime failure. Defaults: one error in 300 seconds sets it off, and a function with no traffic stays `OK`. `alarm: { topicArn, threshold, period }` sets it; `alarm: false` creates none. Without `topicArn` the alarm notifies no one. On prod it is protected and retained like every other child.
- `Worker` turns Workers observability on; `headSamplingRate` (0 to 1, default 1) sets how many requests it records.
- `DeployRole` (staging and prod) may create, read, tag and delete CloudWatch alarms named `<product>-<env>-*`, and read every alarm's configuration in the account.
- The account bootstrap (`bootstrap/`) creates one SNS topic per account, `pebble-<stg|prd>-alarms`, emailing the address in its `alarmEmail` config, and exports `alarmTopicArn`.
- New export: `ApiFunctionAlarm`. Nothing was removed or renamed; a 0.3.x caller that passes nothing new gets the alarm with no action.

Before bumping, in this order:

1. Re-apply the product's `infra/bootstrap` `staging` and `prod` stacks, so each deploy role can create the alarm. Without it the first release fails on `cloudwatch:PutMetricAlarm`.
2. Apply the account bootstrap's `stg` and `prd` stacks with `alarmEmail` set (`bootstrap/README.md`, "Add the alarm topic to an applied stack"), and click the link in AWS's confirmation email: until then the subscription is pending and nothing is delivered.
3. Store each account's `alarmTopicArn` as a secret of the GitHub environments that deploy there, add it to the entries module, and pass it to each `ApiFunction` as `alarm: { topicArn }`.
4. Expect one new resource per `ApiFunction` in the release's preview: `aws:cloudwatch/metricAlarm:MetricAlarm <name>-errors`, plus an update to each `Worker`'s script for observability.
