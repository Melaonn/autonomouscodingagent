import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolvePairedRun, resultLabel, runPairedExperiment } from './paired-runner.js';

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = option('--input');
if (!input) {
  console.error('Usage: npm run benchmark:run -- --input <paired-run.json>');
  process.exit(2);
}

const inputPath = resolve(input);
const experiment = resolvePairedRun(JSON.parse(await readFile(inputPath, 'utf8')), inputPath);
const results = await runPairedExperiment(experiment, dirname(inputPath));
for (const result of results) {
  const variants = [result.baseline, result.harness].filter((value) => value !== undefined);
  console.log(`${result.id}: ${variants.map(resultLabel).join('; ')}`);
}
if (results.some((result) => [result.baseline, result.harness].some((value) => value && !value.completed)))
  process.exitCode = 1;
