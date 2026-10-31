// A fake `pulumi` CLI for the pebble-infra tests: the commands the CLI runs, against a DIY backend kept as files under
// $FAKE_S3/<bucket>/<path>/.pulumi (the layout Pulumi's S3 backend writes), so the fake `aws` sees the same objects.
// Where Pulumi's behaviour is uncertain it takes the stricter side, as stack.test.ts's in-memory fake does: a locked stack
// refuses up, destroy and stack rm; destroy refuses pending operations; stack rm leaves its .json.bak behind.
//
// $FAKE_LOG gets one JSON line per call (argv, cwd, env, stdin). $FAKE_PLAN is a JSON array: each `up` takes the first
// step for it ({ result: 'ok' | 'template1' | 'fail' | 'interrupt', resources?, pending?, outputs?, wholeSecret? }),
// each `destroy` the first with `command: 'destroy'` ({ result: 'fail', message? }).
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
appendFileSync(
  process.env.FAKE_LOG,
  `${JSON.stringify({ tool: 'pulumi', args, cwd: process.cwd(), env: process.env, stdin })}\n`
);

const fail = (message, code = 255) => {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
};
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const project = /^name:\s*(\S+)/m.exec(readFileSync('Pulumi.yaml', 'utf8'))[1];
const backend = new URL(process.env.PULUMI_BACKEND_URL);
const root = join(process.env.FAKE_S3, backend.hostname, backend.pathname, '.pulumi');
const stackFile = (stack) => join(root, 'stacks', project, `${stack}.json`);
const lockDir = (stack) => join(root, 'locks', 'organization', project, stack);
const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const load = (stack) => (existsSync(stackFile(stack)) ? JSON.parse(readFileSync(stackFile(stack), 'utf8')) : undefined);
const save = (stack, deployment) =>
  write(stackFile(stack), JSON.stringify({ version: 3, checkpoint: { stack, latest: deployment } }));
const locked = (stack) => existsSync(lockDir(stack)) && readdirSync(lockDir(stack)).length > 0;
const history = (stack, kind) =>
  write(join(root, 'history', project, stack, `${stack}-${randomUUID()}.${kind}.json`), '{}');
const urn = (stack, type, name) => `urn:pulumi:${stack}::${project}::${type}::${name}`;
const resource = (stack, type, index) => ({
  urn: urn(stack, type, `r${index}`),
  custom: !type.startsWith('pebbletech:'),
  type,
});
/** What a preview program holds after a complete `up`: the Stage, the Database and their children. */
const DATABASE_CLOSURE = [
  'pulumi:pulumi:Stack',
  'pebbletech:index:Stage',
  'pebbletech:index:Database',
  'pulumi:providers:postgresql',
  'pulumi:providers:random',
  'random:index/randomPassword:RandomPassword',
  'postgresql:index/role:Role',
  'postgresql:index/grantRole:GrantRole',
  'postgresql:index/database:Database',
  'postgresql:index/grant:Grant',
];
const SECRET_SIG = '4dabf18193072939515e22adb298388d';

function requireStack(stack) {
  const state = load(stack);
  if (!state) fail(`no stack named '${stack}' found`, 6);
  return state.checkpoint.latest;
}

/** The first planned step for `command` (a step without `command` is for `up`), taken off the plan. */
function nextStep(command) {
  const file = process.env.FAKE_PLAN;
  const plan = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const index = plan.findIndex((step) => (step.command ?? 'up') === command);
  const [step] = index === -1 ? [{ result: 'ok' }] : plan.splice(index, 1);
  if (file) writeFileSync(file, JSON.stringify(plan));
  return step;
}

function configFile(stack) {
  return join(process.cwd(), `.fake-config-${stack}.json`);
}

const verb = args[0] === 'stack' || args[0] === 'config' ? `${args[0]} ${args[1]}` : args[0];
const stack = flag('--stack') ?? args[2];

switch (verb) {
  case 'stack select':
    requireStack(stack);
    break;
  case 'stack init': {
    if (load(stack)) fail(`stack '${stack}' already exists`);
    save(stack, {});
    // A cloud secrets provider writes its data key into the new stack's config file.
    write(
      join(process.cwd(), `Pulumi.${stack}.yaml`),
      `secretsprovider: ${flag('--secrets-provider')}\nencryptedkey: a2V5\n`
    );
    process.stdout.write(`Created stack '${stack}'\n`);
    break;
  }
  case 'cancel':
    requireStack(stack);
    rmSync(lockDir(stack), { recursive: true, force: true });
    break;
  case 'stack export':
    process.stdout.write(JSON.stringify({ version: 3, deployment: requireStack(stack) }, null, 4));
    break;
  case 'stack rm': {
    const deployment = requireStack(stack);
    if (locked(stack)) fail('the stack is currently locked by 1 lock(s)');
    if ((deployment.resources?.length ?? 0) > 0 && !args.includes('--force')) {
      fail(`'${stack}' still has resources; removal rejected. Possible actions: ...`);
    }
    write(`${stackFile(stack)}.bak`, readFileSync(stackFile(stack), 'utf8'));
    rmSync(stackFile(stack));
    process.stdout.write(`Stack '${stack}' has been removed!\n`);
    break;
  }
  case 'destroy': {
    const deployment = requireStack(stack);
    if (locked(stack)) fail('the stack is currently locked by 1 lock(s)');
    if ((deployment.pending_operations?.length ?? 0) > 0) fail('the current deployment has pending operations');
    const step = nextStep('destroy');
    history(stack, 'destroy.history');
    if (step.result === 'fail') {
      // A refused delete leaves the resource, and its state, where they were.
      process.stdout.write(`Destroying (${stack})\n    error: ${step.message ?? 'delete refused'}\n`);
      process.exit(255);
    }
    save(stack, { ...deployment, resources: [] });
    process.stdout.write('Destroying\nResources:\n    - destroyed\n');
    break;
  }
  case 'up': {
    const deployment = requireStack(stack);
    if (locked(stack)) fail('the stack is currently locked by 1 lock(s)');
    const step = nextStep('up');
    const secretsProviders = { type: 'cloud', state: { url: 'awskms://alias/fake', encryptedkey: 'a2V5' } };
    history(stack, 'update.history');
    if (step.result === 'template1') {
      process.stdout.write(
        `Updating (${stack})\n +  postgresql:index:Database db creating (0s) error: pq: source database "template1" is being accessed by other users\n`
      );
      process.exit(255);
    }
    if (step.result === 'fail') {
      process.stdout.write(`Updating (${stack})\n    error: ${step.message ?? 'something else went wrong'}\n`);
      process.exit(255);
    }
    if (step.result === 'interrupt') {
      write(join(lockDir(stack), `${randomUUID()}.json`), '{}');
      save(stack, {
        ...deployment,
        secrets_providers: secretsProviders,
        resources: (step.resources ?? []).map((type, index) => resource(stack, type, index)),
        pending_operations: (step.pending ?? []).map((type, index) => ({
          resource: resource(stack, type, `p${index}`),
          type: 'creating',
        })),
      });
      process.exit(1);
    }
    const outputs = Object.fromEntries(
      Object.entries(step.outputs ?? {}).map(([key, value]) =>
        typeof value === 'object' && value !== null && 'secret' in value
          ? [key, { [SECRET_SIG]: '1b47061264138c4ac30d75fd1eb44270', plaintext: JSON.stringify(value.secret) }]
          : [key, value]
      )
    );
    const resources = (step.resources ?? DATABASE_CLOSURE).map((type, index) => resource(stack, type, index));
    resources[0] = { ...resources[0], outputs: { outputs, wholeSecret: Boolean(step.wholeSecret) } };
    save(stack, { secrets_providers: secretsProviders, resources });
    process.stdout.write(`Updating (${stack})\nResources:\n    + ${resources.length} created\n`);
    break;
  }
  case 'preview':
    requireStack(stack);
    process.stdout.write(`Previewing update (${stack})\n~ aws:lambda/function:Function api update [diff: ~code]\n`);
    break;
  case 'config set': {
    const key = args.at(-1);
    const file = join(process.cwd(), `Pulumi.${stack}.yaml`);
    if (args.includes('--secret') && !(existsSync(file) && /^encryptedkey:/m.test(readFileSync(file, 'utf8')))) {
      fail(`stack ${stack} has no encryptedkey in Pulumi.${stack}.yaml to encrypt ${key} with`);
    }
    const config = existsSync(configFile(stack)) ? JSON.parse(readFileSync(configFile(stack), 'utf8')) : {};
    config[key] = { value: stdin, secret: args.includes('--secret') };
    writeFileSync(configFile(stack), JSON.stringify(config));
    break;
  }
  case 'config rm': {
    const config = existsSync(configFile(stack)) ? JSON.parse(readFileSync(configFile(stack), 'utf8')) : {};
    delete config[args.at(-1)];
    writeFileSync(configFile(stack), JSON.stringify(config));
    break;
  }
  case 'stack output': {
    const deployment = requireStack(stack);
    const name = args[2];
    const stackOutputs = deployment.resources?.[0]?.outputs;
    if (!stackOutputs || name !== 'outputs') fail(`current stack does not have output property '${name}'`, 1);
    const reveal = args.includes('--show-secrets');
    const isSecret = (value) => typeof value === 'object' && value !== null && SECRET_SIG in value;
    const shown =
      stackOutputs.wholeSecret && !reveal
        ? '[secret]'
        : Object.fromEntries(
            Object.entries(stackOutputs.outputs).map(([key, value]) => [
              key,
              isSecret(value) ? (reveal ? JSON.parse(value.plaintext) : '[secret]') : value,
            ])
          );
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
    break;
  }
  default:
    fail(`the fake has no pulumi ${args.join(' ')}`, 99);
}
