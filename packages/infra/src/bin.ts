#!/usr/bin/env node
// The `pebble-infra` executable; cli.ts has the commands.
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));
