import { resolve } from 'node:path';
import { readBenchmarkCheck, runBenchmarkCheck } from './benchmark-check.js';

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = option('--config');
if (!configPath) {
  console.error('Usage: node benchmark-check-main.js --config <public-check.json>');
  process.exit(2);
}

const result = await runBenchmarkCheck(await readBenchmarkCheck(resolve(configPath)));
console.log(
  result.passed ? 'Public benchmark build and tests passed.' : `Public benchmark check "${result.failedLabel}" failed.`,
);
if (!result.passed) process.exitCode = result.exitCode || 1;
