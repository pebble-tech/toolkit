import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { prepare, remove, type Runner, type StackContext } from './stack.js';

const BACKEND = 's3://acme-state/acme/preview?region=xx-test-1';
const PROVIDER = 'awskms://alias/acme-preview?region=xx-test-1';
const ROOT = 'acme/preview/.pulumi';
/** The types a preview stack holds after a complete `up`: the database closure. */
const CLOSURE = [
  'pulumi:pulumi:Stack',
  'pebbletech:index:Stage',
  'pebbletech:index:Database',
  'pulumi:providers:postgresql',
  'random:index/randomPassword:RandomPassword',
  'postgresql:index/role:Role',
  'postgresql:index/grantRole:GrantRole',
  'postgresql:index/database:Database',
];

type Interrupt = 'none' | 'before-up' | 'after-role' | 'after-database';

/**
 * The pulumi, aws and pg-database commands the CLI runs, against an in-memory DIY backend, S3 prefix and
 * Postgres cluster. Where Pulumi's behaviour is uncertain the fake takes the stricter side: a locked stack refuses
 * destroy and stack rm, destroy refuses pending operations, stack rm leaves its .json.bak and history behind.
 */
class World {
  stacks = new Map<string, { resources: number; pending: number; locked: boolean; updated: boolean }>();
  objects = new Set<string>();
  databases = new Set<string>();
  /** Every command run, as `<command> <first two args>`. */
  commands: string[] = [];
  /** What `pulumi stack select` prints when the backend cannot be read; unset, the backend answers. */
  backendError?: string;

  private stackFile = (stack: string) => `${ROOT}/stacks/acme/${stack}.json`;
  private fail = (stderr: string) => ({ ok: false, stdout: '', stderr });
  private ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });

  run: Runner = (command, args) => {
    this.commands.push(`${command} ${args.slice(0, 2).join(' ')}`);
    if (command === 'node') {
      if (args[1] === 'check') return this.ok();
      this.databases.delete(args[2]!);
      return this.ok();
    }
    if (command === 'aws') return this.aws(args);
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    const verb = args.slice(0, 2).join(' ');
    const stack = args.includes('--stack') ? flag('--stack') : args[2]!;
    const state = this.stacks.get(stack);
    switch (args[0] === 'stack' ? verb : args[0]) {
      case 'stack select':
        if (this.backendError) return this.fail(this.backendError);
        return state ? this.ok() : this.fail(`error: no stack named '${stack}' found\n`);
      case 'stack init':
        if (state) return this.fail(`stack '${stack}' already exists`);
        this.stacks.set(stack, { resources: 0, pending: 0, locked: false, updated: false });
        this.objects.add(this.stackFile(stack));
        return this.ok();
      case 'cancel':
        if (state) state.locked = false;
        for (const key of this.objects) if (key.startsWith(`${ROOT}/locks/acme/${stack}/`)) this.objects.delete(key);
        return this.ok();
      case 'stack export': {
        if (!state) return this.fail('no stack');
        const deployment = state.updated
          ? {
              resources: Array.from({ length: state.resources }, (_, i) => ({ type: CLOSURE[i % CLOSURE.length] })),
              pending_operations: Array.from({ length: state.pending }, () => ({
                resource: { type: 'postgresql:index/role:Role' },
                type: 'creating',
              })),
              secrets_providers: { type: 'cloud', state: { url: PROVIDER, encryptedkey: 'a2V5' } },
            }
          : {};
        return this.ok(JSON.stringify({ version: 3, deployment }));
      }
      case 'destroy':
        if (!state) return this.fail('no stack');
        if (state.locked) return this.fail('the stack is currently locked by 1 lock(s)');
        if (state.pending > 0) return this.fail('pending operations');
        this.databases.delete(`acme_${stack.replace('-', '_')}`);
        state.resources = 0;
        this.objects.add(`${ROOT}/history/acme/${stack}/${stack}-destroy.history.json`);
        return this.ok();
      case 'stack rm':
        if (!state) return this.fail('no stack');
        if (state.locked) return this.fail('the stack is currently locked by 1 lock(s)');
        if (state.resources > 0 && !args.includes('--force')) return this.fail('stack has resources');
        this.stacks.delete(stack);
        this.objects.delete(this.stackFile(stack));
        this.objects.add(`${this.stackFile(stack)}.bak`);
        return this.ok();
      default:
        throw new Error(`fake has no ${command} ${args.join(' ')}`);
    }
  };

  private aws(args: string[]) {
    if (args[1] === 'ls') {
      const keys = [...this.objects].sort();
      return keys.length === 0
        ? this.fail('')
        : this.ok(keys.map((key) => `2026-10-23 10:00:00        123 ${key}`).join('\n'));
    }
    this.objects.delete(args[2]!.replace('s3://acme-state/', ''));
    return this.ok();
  }

  /** `pulumi up` of a preview stack: creates the role, then the database; an interrupt leaves a lock and a pending op. */
  up(stack: string, interrupt: Interrupt = 'none'): void {
    const state = this.stacks.get(stack);
    const database = `acme_${stack.replace('-', '_')}`;
    if (!state) throw new Error('no stack');
    if (state.locked) throw new Error('the stack is currently locked');
    if (state.resources === 0 && this.databases.has(database)) throw new Error(`database "${database}" already exists`);
    if (interrupt === 'before-up') return;
    state.updated = true;
    this.objects.add(`${ROOT}/history/acme/${stack}/${stack}-up.history.json`);
    if (interrupt !== 'none') {
      state.locked = true;
      state.pending = 1;
      this.objects.add(`${ROOT}/locks/acme/${stack}/lock.json`);
      if (interrupt === 'after-database') this.databases.add(database);
      return;
    }
    this.databases.add(database);
    state.resources = 8;
  }

  /** What the verifier queries after a close: stacks, state objects and databases for `stack`. */
  leftovers(stack: string): string[] {
    return [
      ...(this.stacks.has(stack) ? [`stack ${stack}`] : []),
      ...[...this.objects].filter((key) => new RegExp(`/${stack}(\\.json|/)`).test(key)),
      ...[...this.databases].filter((name) => name === `acme_${stack.replace('-', '_')}`),
    ];
  }
}

function context(world: World): StackContext {
  return {
    run: world.run,
    projectDir: mkdtempSync(join(tmpdir(), 'pebble-infra-stack-')),
    product: 'acme',
    previewDatabase: true,
    backendUrl: BACKEND,
    secretsProvider: PROVIDER,
    log: () => {},
  };
}

describe('remove (the preview close job)', () => {
  test('a stack that was never created: the old workflow database is dropped, nothing else to do', () => {
    const world = new World();
    world.databases.add('acme_pr_7');
    remove(context(world), 'pr-7', { clearLock: true });
    expect(world.leftovers('pr-7')).toEqual([]);
  });

  test('a complete stack: destroyed, removed, and its .bak and history swept', () => {
    const world = new World();
    const ctx = context(world);
    prepare(ctx, 'pr-7');
    world.up('pr-7');
    remove(ctx, 'pr-7', { clearLock: true });
    expect(world.leftovers('pr-7')).toEqual([]);
  });

  test('a stack locked by a cancelled update with the database created but pending: nothing left', () => {
    const world = new World();
    const ctx = context(world);
    prepare(ctx, 'pr-7');
    world.up('pr-7', 'after-database');
    remove(ctx, 'pr-7', { clearLock: true });
    expect(world.leftovers('pr-7')).toEqual([]);
  });

  test("another pull request's stack and objects are untouched", () => {
    const world = new World();
    const ctx = context(world);
    prepare(ctx, 'pr-70');
    world.up('pr-70');
    prepare(ctx, 'pr-7');
    world.up('pr-7');
    remove(ctx, 'pr-7', { clearLock: true });
    expect([world.leftovers('pr-7'), world.leftovers('pr-70')]).toEqual([
      [],
      [
        'stack pr-70',
        `${ROOT}/stacks/acme/pr-70.json`,
        `${ROOT}/history/acme/pr-70/pr-70-up.history.json`,
        'acme_pr_70',
      ],
    ]);
  });
});

// What `pulumi stack select` prints when the backend cannot be read (the S3 form of a checkpoint read that fails).
const BACKEND_ERROR =
  'error: failed to load checkpoint: blob (key ".pulumi/stacks/acme/pr-7.json") (code=Unknown): AccessDenied: Access Denied\n';

describe('a backend that cannot be read is not a missing stack', () => {
  test("remove stops with Pulumi's error: no destroy, no stack rm, no drop, no state object deleted", () => {
    const world = new World();
    const ctx = context(world);
    prepare(ctx, 'pr-7');
    world.up('pr-7');
    const objects = [...world.objects];
    world.backendError = BACKEND_ERROR;
    world.commands = [];
    expect(() => remove(ctx, 'pr-7', { clearLock: true })).toThrow(
      `pulumi stack select pr-7 failed:\n${BACKEND_ERROR}`
    );
    expect([world.commands, [...world.objects], world.databases.has('acme_pr_7')]).toEqual([
      ['pulumi stack select'],
      objects,
      true,
    ]);
  });

  test("prepare stops with Pulumi's error: no database drop, no stack init", () => {
    const world = new World();
    const ctx = context(world);
    prepare(ctx, 'pr-7');
    world.up('pr-7');
    world.backendError = BACKEND_ERROR;
    world.commands = [];
    expect(() => prepare(ctx, 'pr-7', { clearLock: true })).toThrow(
      `pulumi stack select pr-7 failed:\n${BACKEND_ERROR}`
    );
    expect([world.commands, world.databases.has('acme_pr_7'), world.stacks.get('pr-7')!.resources]).toEqual([
      ['pulumi stack select'],
      true,
      8,
    ]);
  });
});

describe('prepare (the preview deploy job, before pulumi up)', () => {
  test.each(['before-up', 'after-role', 'after-database'] as const)(
    'after a run cancelled %s, the next run deploys',
    (interrupt) => {
      const world = new World();
      const ctx = context(world);
      prepare(ctx, 'pr-7');
      world.up('pr-7', interrupt);
      expect(prepare(ctx, 'pr-7', { clearLock: true })).toBe('reset');
      world.up('pr-7');
      expect(world.stacks.get('pr-7')).toEqual({ resources: 8, pending: 0, locked: false, updated: true });
    }
  );

  test('a database left by the pre-Pulumi workflow is dropped before the first up', () => {
    const world = new World();
    world.databases.add('acme_pr_7');
    const ctx = context(world);
    expect(prepare(ctx, 'pr-7')).toBe('created');
    world.up('pr-7');
    expect(world.stacks.get('pr-7')!.resources).toBe(8);
  });

  test('on a fresh checkout the stack config gets the secrets provider and key back from the state', () => {
    const world = new World();
    const ctx = context(world);
    prepare(ctx, 'pr-7');
    world.up('pr-7');
    expect(prepare(ctx, 'pr-7')).toBe('ready');
    expect(readFileSync(join(ctx.projectDir, 'Pulumi.pr-7.yaml'), 'utf8')).toBe(
      `secretsprovider: ${PROVIDER}\nencryptedkey: a2V5\n`
    );
  });

  test('an existing stack config keeps its own key', () => {
    const world = new World();
    const ctx = context(world);
    prepare(ctx, 'pr-7');
    world.up('pr-7');
    writeFileSync(join(ctx.projectDir, 'Pulumi.pr-7.yaml'), 'encryptedkey: b3du\n');
    prepare(ctx, 'pr-7');
    expect(readFileSync(join(ctx.projectDir, 'Pulumi.pr-7.yaml'), 'utf8')).toBe('encryptedkey: b3du\n');
  });

  test('prod, created by an earlier preview-only run on another checkout, is created again with a key', () => {
    const world = new World();
    const ctx = context(world);
    world.stacks.set('prod', { resources: 0, pending: 0, locked: false, updated: false });
    expect(prepare(ctx, 'prod')).toBe('reset');
    expect(world.stacks.get('prod')).toEqual({ resources: 0, pending: 0, locked: false, updated: false });
  });

  test('a deploying run clears the lock a cancelled deploy of prod left', () => {
    const world = new World();
    const ctx = context(world);
    world.stacks.set('prod', { resources: 40, pending: 0, locked: true, updated: true });
    expect(prepare(ctx, 'prod', { clearLock: true })).toBe('ready');
    expect(world.stacks.get('prod')!.locked).toBe(false);
  });

  // A preview of prod can share a concurrency group with the deploy, but a lock can also be held by a `pulumi` run
  // from a laptop: a preview must never clear it, nor remove or recreate prod.
  test('a preview of prod held by another run: no cancel, no stack rm, the lock stays', () => {
    const world = new World();
    const ctx = context(world);
    const commands: string[] = [];
    const run = world.run;
    ctx.run = (command, args, options) => {
      commands.push(`${command} ${args.slice(0, 2).join(' ')}`);
      return run(command, args, options);
    };
    world.stacks.set('prod', { resources: 40, pending: 0, locked: true, updated: true });
    expect(prepare(ctx, 'prod', { previewOnly: true })).toBe('ready');
    expect([world.stacks.get('prod'), commands.filter((c) => /cancel|stack rm|stack init/.test(c))]).toEqual([
      { resources: 40, pending: 0, locked: true, updated: true },
      [],
    ]);
  });

  test('a preview of a prod stack that does not exist refuses instead of creating it', () => {
    const world = new World();
    const ctx = context(world);
    const commands: string[] = [];
    const run = world.run;
    ctx.run = (command, args, options) => {
      commands.push(`${command} ${args.slice(0, 2).join(' ')}`);
      return run(command, args, options);
    };
    expect(() => prepare(ctx, 'prod', { previewOnly: true })).toThrow(
      'stack prod does not exist; a preview does not create it'
    );
    expect([world.stacks.has('prod'), commands.filter((c) => /cancel|stack rm|stack init/.test(c))]).toEqual([
      false,
      [],
    ]);
  });

  test('a deploying run still creates a stack that does not exist', () => {
    const world = new World();
    expect(prepare(context(world), 'prod')).toBe('created');
    expect(world.stacks.has('prod')).toBe(true);
  });

  test('a preview of a prod stack that was never updated refuses instead of recreating it', () => {
    const world = new World();
    const ctx = context(world);
    world.stacks.set('prod', { resources: 0, pending: 0, locked: false, updated: false });
    expect(() => prepare(ctx, 'prod', { previewOnly: true })).toThrow(
      'stack prod was never updated; a preview does not recreate it'
    );
    expect(world.stacks.get('prod')).toEqual({ resources: 0, pending: 0, locked: false, updated: false });
  });

  test('staging with pending operations stops for a human instead of resetting', () => {
    const world = new World();
    const ctx = context(world);
    world.stacks.set('staging', { resources: 40, pending: 1, locked: true, updated: true });
    expect(() => prepare(ctx, 'staging', { clearLock: true })).toThrow('run `pulumi refresh -s staging`');
    expect(world.stacks.get('staging')).toEqual({ resources: 40, pending: 1, locked: false, updated: true });
  });
});

test('20 open/push/close cycles with a cancel at every point leave no stack, state object or database', () => {
  const world = new World();
  const ctx = context(world);
  const interrupts: Interrupt[] = ['none', 'before-up', 'after-role', 'after-database'];
  const after: string[][] = [];
  for (let cycle = 0; cycle < 20; cycle += 1) {
    // opened: a run cancelled at this cycle's point by the push that follows it (cancel-in-progress)
    prepare(ctx, 'pr-7', { clearLock: true });
    world.up('pr-7', interrupts[cycle % 4]);
    // synchronize: completes
    prepare(ctx, 'pr-7', { clearLock: true });
    world.up('pr-7');
    // a second push cancelled at the next point, then closed before another run finishes
    prepare(ctx, 'pr-7', { clearLock: true });
    world.up('pr-7', interrupts[(cycle + 1) % 4]);
    remove(ctx, 'pr-7', { clearLock: true });
    after.push(world.leftovers('pr-7'));
  }
  expect(after).toEqual(Array.from({ length: 20 }, () => []));
});
