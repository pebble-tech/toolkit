// A fake `aws` CLI for the pebble-infra tests: `s3 ls --recursive` and `s3 rm` over $FAKE_S3/<bucket>/<key>, where the
// fake `pulumi` keeps its backend. $FAKE_LOG gets one JSON line per call.
import { appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(
  process.env.FAKE_LOG,
  `${JSON.stringify({ tool: 'aws', args, cwd: process.cwd(), env: process.env })}\n`
);

const parse = (s3) => {
  const [bucket, ...key] = s3.replace(/^s3:\/\//, '').split('/');
  return { bucket, key: key.join('/') };
};

if (args[0] === 's3' && args[1] === 'ls') {
  const { bucket, key } = parse(args[2]);
  const bucketDir = join(process.env.FAKE_S3, bucket);
  const start = join(bucketDir, key);
  const keys = existsSync(start)
    ? readdirSync(start, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(bucketDir, join(entry.parentPath, entry.name)))
        .sort()
    : [];
  // `aws s3 ls` exits 1 with no output when nothing is under the prefix.
  if (keys.length === 0) process.exit(1);
  process.stdout.write(keys.map((k) => `2026-10-23 10:00:00        123 ${k}\n`).join(''));
} else if (args[0] === 's3' && args[1] === 'rm') {
  const { bucket, key } = parse(args[2]);
  rmSync(join(process.env.FAKE_S3, bucket, key), { force: true });
  process.stdout.write(`delete: ${args[2]}\n`);
} else {
  process.stderr.write(`the fake has no aws ${args.join(' ')}\n`);
  process.exit(99);
}
