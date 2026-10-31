import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';

import { MissingDomainError } from './errors.js';
import { boundedRole } from './iam.js';
import type { PermissionsBoundaryArn, Stage } from './stage.js';

/** HTTP API integrations give up at 30 s; the function must finish first. */
export const MAX_API_TIMEOUT_SECONDS = 29;

export interface ApiDomain {
  /** `stage.hostname('api', apex)`; must have the stage's hostname shape. */
  hostname: string;
  /** Cloudflare zone that holds the hostname (certificate validation and the CNAME). */
  zoneId: pulumi.Input<string>;
}

/**
 * The CloudWatch alarm on the function's `Errors` metric: what Lambda counts as a failed invocation (a crash before the
 * handler runs, a timeout, an out-of-memory kill, a runtime failure). A handled error answered with a 500 is not one.
 */
export interface ApiFunctionAlarm {
  /**
   * SNS topic the alarm notifies, e.g. the account bootstrap's `alarmTopicArn` output. Without it the alarm still
   * changes state in CloudWatch but notifies no one.
   */
  topicArn?: pulumi.Input<string>;
  /** Errors in one period that set the alarm off. Default 1. */
  threshold?: number;
  /** Seconds per evaluation period, a multiple of 60. Default 300. */
  period?: number;
}

export interface ApiFunctionArgs {
  stage: Stage;
  /** A directory or `.zip` the product's build produced (esbuild); the component does not bundle. */
  code: string;
  /** Defaults to `index.handler`. */
  handler?: string;
  environment?: Record<string, pulumi.Input<string>>;
  /** MB, default 1024. */
  memory?: number;
  /** Seconds, default and maximum 29 (anything higher is clamped). */
  timeout?: number;
  /** Default 30. */
  logRetentionDays?: number;
  /** Required: the API is reachable only through it. */
  domain: ApiDomain;
  /**
   * Defaults to `stage.permissionsBoundaryArn()`. Passing `DeployRole.boundaryArn` is allowed; it must resolve to
   * the same policy, `<product>-<deploy env>-boundary` in the current account, or the program fails.
   */
  permissionsBoundary?: PermissionsBoundaryArn;
  /** Name part after `<product>-<env>-`, default `api`. */
  kind?: string;
  /** The errors alarm, `<product>-<env>-<kind>-errors`; on by default. `false` creates none. */
  alarm?: ApiFunctionAlarm | false;
}

/**
 * A Lambda (`nodejs22.x`) behind an HTTP API on a custom domain: the default execute-api endpoint is off, the
 * certificate is regional and DNS-validated in Cloudflare, the function role carries the permissions boundary, and a
 * CloudWatch alarm watches the function's errors.
 */
export class ApiFunction extends pulumi.ComponentResource {
  readonly functionName: string;
  readonly functionArn: pulumi.Output<string>;
  readonly apiId: pulumi.Output<string>;
  readonly hostname: string;
  readonly url: string;

  constructor(name: string, args: ApiFunctionArgs, opts?: pulumi.ComponentResourceOptions) {
    const { stage } = args;
    if (!args.domain?.hostname || !args.domain.zoneId) {
      throw new MissingDomainError(
        'an ApiFunction needs domain.hostname and domain.zoneId; the API has no other address'
      );
    }
    stage.requireKind('an API function', ['preview', 'staging', 'prod']);
    stage.assertOwnsHostname(args.domain.hostname);
    super('pebbletech:index:ApiFunction', name, {}, opts);

    const child = (extra?: pulumi.CustomResourceOptions) => stage.childOptions(this, extra);
    const functionName = stage.name(args.kind ?? 'api');
    const { hostname, zoneId } = args.domain;
    const tags = stage.tags;

    const role = boundedRole(
      `${name}-role`,
      {
        stage,
        roleName: functionName,
        service: 'lambda.amazonaws.com',
        ...(args.permissionsBoundary === undefined ? {} : { permissionsBoundary: args.permissionsBoundary }),
      },
      child()
    );
    const basicExecution = new aws.iam.RolePolicyAttachment(
      `${name}-basic-execution`,
      { role: role.name, policyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
      child()
    );
    const logGroup = new aws.cloudwatch.LogGroup(
      `${name}-logs`,
      { name: `/aws/lambda/${functionName}`, retentionInDays: args.logRetentionDays ?? 30, tags },
      child()
    );

    const environment = args.environment ?? {};
    const fn = new aws.lambda.Function(
      name,
      {
        name: functionName,
        runtime: 'nodejs22.x',
        handler: args.handler ?? 'index.handler',
        code: new pulumi.asset.FileArchive(args.code),
        role: role.arn,
        memorySize: args.memory ?? 1024,
        timeout: Math.max(1, Math.min(args.timeout ?? MAX_API_TIMEOUT_SECONDS, MAX_API_TIMEOUT_SECONDS)),
        loggingConfig: { logFormat: 'Text', logGroup: logGroup.name },
        ...(Object.keys(environment).length > 0 ? { environment: { variables: environment } } : {}),
        tags,
      },
      child({ dependsOn: [basicExecution, logGroup] })
    );

    if (args.alarm !== false) {
      const alarm = args.alarm ?? {};
      new aws.cloudwatch.MetricAlarm(
        `${name}-errors`,
        {
          name: stage.name(args.kind ?? 'api', 'errors'),
          alarmDescription: `${functionName} failed invocations: a crash before the handler runs, a timeout, an out-of-memory kill or a runtime failure`,
          namespace: 'AWS/Lambda',
          metricName: 'Errors',
          dimensions: { FunctionName: fn.name },
          statistic: 'Sum',
          period: alarm.period ?? 300,
          evaluationPeriods: 1,
          threshold: alarm.threshold ?? 1,
          comparisonOperator: 'GreaterThanOrEqualToThreshold',
          // Lambda publishes Errors only for periods with invocations. A quiet function has no data, which stays OK.
          treatMissingData: 'notBreaching',
          alarmActions: alarm.topicArn === undefined ? [] : [alarm.topicArn],
          tags,
        },
        child()
      );
    }

    const api = new aws.apigatewayv2.Api(
      `${name}-api`,
      { name: functionName, protocolType: 'HTTP', disableExecuteApiEndpoint: true, tags },
      child()
    );
    const integration = new aws.apigatewayv2.Integration(
      `${name}-integration`,
      {
        apiId: api.id,
        integrationType: 'AWS_PROXY',
        integrationUri: fn.invokeArn,
        payloadFormatVersion: '2.0',
        timeoutMilliseconds: 30_000,
      },
      child()
    );
    new aws.apigatewayv2.Route(
      `${name}-route`,
      { apiId: api.id, routeKey: '$default', target: pulumi.interpolate`integrations/${integration.id}` },
      child()
    );
    const apiStage = new aws.apigatewayv2.Stage(
      `${name}-stage`,
      { apiId: api.id, name: '$default', autoDeploy: true, tags },
      child()
    );
    new aws.lambda.Permission(
      `${name}-invoke`,
      {
        action: 'lambda:InvokeFunction',
        function: fn.name,
        principal: 'apigateway.amazonaws.com',
        sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
      },
      child()
    );

    // Regional certificate: an HTTP API custom domain needs it in the API's own region, not us-east-1.
    const certificate = new aws.acm.Certificate(
      `${name}-certificate`,
      { domainName: hostname, validationMethod: 'DNS', tags },
      child()
    );
    const validation = certificate.domainValidationOptions.apply((options) => {
      const option = options[0];
      if (!option) throw new Error(`ACM returned no DNS validation record for ${hostname}`);
      return option;
    });
    const validationRecord = new cloudflare.DnsRecord(
      `${name}-certificate-validation`,
      {
        zoneId,
        name: validation.resourceRecordName.apply(withoutTrailingDot),
        type: validation.resourceRecordType,
        content: validation.resourceRecordValue.apply(withoutTrailingDot),
        ttl: 1,
        proxied: false,
      },
      child()
    );
    const validated = new aws.acm.CertificateValidation(
      `${name}-certificate-validated`,
      { certificateArn: certificate.arn, validationRecordFqdns: [validationRecord.name] },
      child()
    );
    const domainName = new aws.apigatewayv2.DomainName(
      `${name}-domain`,
      {
        domainName: hostname,
        domainNameConfiguration: {
          certificateArn: validated.certificateArn,
          endpointType: 'REGIONAL',
          securityPolicy: 'TLS_1_2',
        },
        tags,
      },
      child()
    );
    new aws.apigatewayv2.ApiMapping(
      `${name}-mapping`,
      { apiId: api.id, domainName: domainName.domainName, stage: apiStage.name },
      child()
    );
    new cloudflare.DnsRecord(
      `${name}-cname`,
      {
        zoneId,
        name: hostname,
        type: 'CNAME',
        content: domainName.domainNameConfiguration.targetDomainName,
        ttl: 1,
        proxied: false,
      },
      child()
    );

    this.functionName = functionName;
    this.functionArn = fn.arn;
    this.apiId = api.id;
    this.hostname = hostname;
    this.url = `https://${hostname}`;
    this.registerOutputs({
      functionName,
      functionArn: this.functionArn,
      apiId: this.apiId,
      hostname,
      url: this.url,
    });
  }
}

function withoutTrailingDot(value: string): string {
  return value.replace(/\.$/, '');
}
