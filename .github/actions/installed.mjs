// The version of a package installed for a directory, found as Node finds it from the directory's real path (a
// symlinked infra/ resolves from its target): <real dir>/node_modules/<name>, then each parent's. The setup and pulumi
// actions run it before anything that depends on that version.
//
//   node installed.mjs <dir> <package>                  prints the installed version
//   node installed.mjs <dir> <package> <package.json>   prints it, and fails unless its major.minor is that file's
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [dir, name, expected] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!dir || !name) fail('usage: node installed.mjs <dir> <package> [<package.json>]');

const version = (file) => {
  const value = JSON.parse(readFileSync(file, 'utf8')).version;
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value))
    fail(`${file} has no version of the form x.y.z`);
  return value;
};

let found;
const start = existsSync(dir) ? realpathSync(dir) : resolve(dir);
for (let at = start; ; at = dirname(at)) {
  const file = join(at, 'node_modules', name, 'package.json');
  if (existsSync(file)) {
    found = file;
    break;
  }
  if (dirname(at) === at) break;
}
if (!found) {
  fail(
    `${name} is not installed for ${dir}: no node_modules/${name} in it or a parent. Install the product's dependencies first, and set the action's infra input to the directory whose package.json depends on ${name}.`
  );
}

const installed = version(found);
if (expected) {
  const own = version(expected);
  const minor = (value) => value.split('.').slice(0, 2).join('.');
  if (minor(installed) !== minor(own)) {
    fail(
      `${name} ${installed} is installed for ${dir}, but this action is from ${name} ${own}: pin the action at the commit of the version the product installs, so the two agree on major.minor.`
    );
  }
}
process.stdout.write(`${installed}\n`);
