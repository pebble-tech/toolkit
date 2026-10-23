/**
 * Run a Pulumi program against a fake engine and get back every resource it registered, with the options the SDK
 * sent (protect, retainOnDelete, import id, parent). For product tests of an `infra/` program; no cloud calls.
 */
import * as pulumi from '@pulumi/pulumi';

export interface Registration {
  type: string;
  name: string;
  urn: string;
  /** URN of the parent resource; empty for the stack's direct children. */
  parent: string;
  custom: boolean;
  protect: boolean;
  retainOnDelete: boolean;
  /** The `import` option: an existing cloud resource this one adopts. */
  importId: string;
  /** Inputs as the provider would receive them, secrets unwrapped. */
  inputs: Record<string, any>;
  /** Top-level input keys whose value is, or contains, a secret. */
  secretInputs: string[];
  /** What `registerOutputs` sent, for component resources. */
  outputs?: Record<string, any>;
}

const ACCOUNT = '123456789012';
const REGION = 'ap-southeast-1';

/** Computed outputs a real provider would return, keyed by type token. Everything else echoes its inputs. */
function computed(type: string, name: string, inputs: Record<string, any>): Record<string, unknown> {
  const physical = String(inputs.name ?? name);
  switch (type) {
    case 'aws:iam/role:Role':
      return { arn: `arn:aws:iam::${ACCOUNT}:role/${physical}` };
    case 'aws:iam/policy:Policy':
      return { arn: `arn:aws:iam::${ACCOUNT}:policy/${physical}` };
    case 'aws:lambda/function:Function':
      return {
        arn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${physical}`,
        invokeArn: `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/arn:aws:lambda:${REGION}:${ACCOUNT}:function:${physical}/invocations`,
      };
    case 'aws:apigatewayv2/api:Api':
      return {
        apiEndpoint: `https://${name}.execute-api.${REGION}.amazonaws.com`,
        executionArn: `arn:aws:execute-api:${REGION}:${ACCOUNT}:${name}`,
      };
    case 'aws:acm/certificate:Certificate':
      return {
        arn: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/${name}`,
        domainValidationOptions: [
          {
            domainName: inputs.domainName,
            resourceRecordName: `_validation.${inputs.domainName}.`,
            resourceRecordType: 'CNAME',
            resourceRecordValue: `_validation.acm-validations.aws.`,
          },
        ],
      };
    case 'aws:apigatewayv2/domainName:DomainName':
      return {
        domainNameConfiguration: {
          ...inputs.domainNameConfiguration,
          targetDomainName: `d-${name}.execute-api.${REGION}.amazonaws.com`,
        },
      };
    case 'aws:cloudwatch/logGroup:LogGroup':
      return { arn: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${physical}` };
    case 'random:index/randomPassword:RandomPassword':
      return { result: `mock-password-${name}` };
    case 'vercel:index/projectProtectionBypass:ProjectProtectionBypass':
      return { secret: `mock-bypass-${name}` };
    default:
      return {};
  }
}

/** Mocks that answer the invokes this package's components make. */
export const defaultMocks: pulumi.runtime.Mocks = {
  newResource(args) {
    return {
      id: args.id || `${args.name}-id`,
      state: { ...args.inputs, ...computed(args.type, args.name, args.inputs) },
    };
  },
  call(args) {
    switch (args.token) {
      case 'aws:index/getCallerIdentity:getCallerIdentity':
        return { accountId: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:user/mock`, userId: 'mock' };
      case 'aws:index/getRegion:getRegion':
        return { name: REGION, region: REGION };
      case 'aws:index/getPartition:getPartition':
        return { partition: 'aws', dnsSuffix: 'amazonaws.com' };
      case 'vercel:index/getDomainConfig:getDomainConfig':
        return { ...args.inputs, recommendedCname: 'cname.vercel-dns.com', recommendedIpv4s: [], misconfigured: false };
      default:
        return args.inputs;
    }
  },
};

const { specialSigKey, specialSecretSig } = pulumi.runtime;

function isSecretValue(value: unknown): value is { value: unknown } {
  return typeof value === 'object' && value !== null && (value as any)[specialSigKey] === specialSecretSig;
}

/** Replaces secret wrappers with their values; reports whether any were found. */
function unwrap(value: unknown): { value: unknown; secret: boolean } {
  if (isSecretValue(value)) return { value: unwrap(value.value).value, secret: true };
  if (Array.isArray(value)) {
    const items = value.map(unwrap);
    return { value: items.map((item) => item.value), secret: items.some((item) => item.secret) };
  }
  if (typeof value === 'object' && value !== null) {
    let secret = false;
    const object: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const unwrapped = unwrap(item);
      object[key] = unwrapped.value;
      secret ||= unwrapped.secret;
    }
    return { value: object, secret };
  }
  return { value, secret: false };
}

function unwrapInputs(raw: Record<string, unknown>): { inputs: Record<string, any>; secretInputs: string[] } {
  const inputs: Record<string, any> = {};
  const secretInputs: string[] = [];
  for (const [key, item] of Object.entries(raw)) {
    const unwrapped = unwrap(item);
    inputs[key] = unwrapped.value;
    if (unwrapped.secret) secretInputs.push(key);
  }
  return { inputs, secretInputs };
}

type Callback = (error: unknown, response?: any) => void;
interface MonitorShape {
  registerResource(request: any, callback: Callback): void;
  registerResourceOutputs(request: any, callback: Callback): void;
}

export interface RunOptions {
  project: string;
  stack: string;
  mocks?: pulumi.runtime.Mocks;
}

/**
 * Sets mocks for `project`/`stack`, runs `program`, waits for every registration to finish, and returns them.
 * Rejects with the program's first unhandled rejection, as `pulumi preview` would fail with it.
 * Runs must not overlap: Pulumi's runtime is global to the process.
 */
export async function runProgram<T>(
  options: RunOptions,
  program: () => T | Promise<T>
): Promise<{ result: T; resources: Registration[] }> {
  await pulumi.runtime.setMocks(options.mocks ?? defaultMocks, options.project, options.stack, false);
  const monitor = pulumi.runtime.getMonitor() as unknown as MonitorShape;
  const resources: Registration[] = [];
  const byUrn = new Map<string, Registration>();

  const register = monitor.registerResource.bind(monitor);
  monitor.registerResource = (request, callback) => {
    const registration: Registration = {
      type: request.getType(),
      name: request.getName(),
      urn: '',
      parent: request.getParent(),
      custom: request.getCustom(),
      protect: request.getProtect() ?? false,
      retainOnDelete: request.getRetainondelete() ?? false,
      importId: request.getImportid(),
      ...unwrapInputs(pulumi.runtime.deserializeProperties(request.getObject())),
    };
    register(request, (error, response) => {
      if (!error && response) {
        registration.urn = response.getUrn();
        byUrn.set(registration.urn, registration);
        resources.push(registration);
      }
      callback(error, response);
    });
  };

  const registerOutputs = monitor.registerResourceOutputs.bind(monitor);
  monitor.registerResourceOutputs = (request, callback) => {
    const registration = byUrn.get(request.getUrn());
    if (registration)
      registration.outputs = unwrapInputs(pulumi.runtime.deserializeProperties(request.getOutputs())).inputs;
    registerOutputs(request, callback);
  };

  // Pulumi's language host fails the program on an unhandled rejection, e.g. a guardrail thrown inside an apply.
  // Collect them for the run instead of letting the test runner report each one, and fail the run with the first.
  const rejections: unknown[] = [];
  const listeners = process.listeners('unhandledRejection');
  const collect = (reason: unknown) => rejections.push(reason);
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', collect);
  let outcome: { result: T } | { error: unknown };
  try {
    outcome = { result: await program() };
  } catch (error) {
    outcome = { error };
  }
  // Also on a throw: registrations already started must finish against this monitor, not the next run's.
  await pulumi.runtime.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', collect);
  for (const listener of listeners) process.on('unhandledRejection', listener);
  if ('error' in outcome) throw outcome.error;
  if (rejections.length > 0) throw rejections[0];
  return { result: outcome.result, resources };
}

/** Resolves an Output's value the way an `apply` would see it. Test-only: a real program uses apply. */
export function valueOf<T>(output: pulumi.Input<T>): Promise<T> {
  return new Promise((resolve) => pulumi.output(output).apply((value) => resolve(value as T)));
}
