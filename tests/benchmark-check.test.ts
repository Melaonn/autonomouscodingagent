import { describe, expect, it } from 'vitest';
import { benchmarkCheckSchema, vitestFailures } from '../apps/server/src/benchmark-check.js';

describe('Docker-backed public benchmark checks', () => {
  it('accepts argument-safe image references and requires a real test command', () => {
    expect(
      benchmarkCheckSchema.parse({
        image: 'registry.example/team/task:sha-123',
        commands: [
          { label: 'Build', command: 'npm run build' },
          { label: 'Tests', command: 'npm test' },
        ],
        relatedTests: {
          label: 'Related tests',
          argv: ['npm', 'exec', 'vitest', 'related', '--run'],
          baselineCommands: ['npm install'],
        },
      }),
    ).toMatchObject({
      timeoutSeconds: 1800,
      relatedTests: {
        extensions: ['.js', '.jsx', '.ts', '.tsx', '.svelte'],
        baselineCommands: ['npm install'],
      },
    });
    expect(
      benchmarkCheckSchema.safeParse({
        image: 'task; echo unsafe',
        commands: [{ label: 'Tests', command: 'npm test' }],
      }).success,
    ).toBe(false);
    expect(benchmarkCheckSchema.safeParse({ image: 'task:latest', commands: [] }).success).toBe(false);
  });

  it('extracts stable failed-test identities from a Vitest report', () => {
    const failures = vitestFailures(
      JSON.stringify({
        testResults: [
          {
            name: '/testbed/source.test.ts',
            status: 'failed',
            assertionResults: [
              { status: 'passed', fullName: 'source accepts valid input' },
              { status: 'failed', fullName: 'source rejects invalid input' },
            ],
          },
          {
            name: '/testbed/broken.test.ts',
            status: 'failed',
            message: '\u001b[31mSyntaxError: broken\u001b[0m\nline 2',
          },
        ],
      }),
    );
    expect([...failures]).toEqual([
      'test:/testbed/source.test.ts:source rejects invalid input',
      'suite:/testbed/broken.test.ts:SyntaxError: broken',
    ]);
  });
});
