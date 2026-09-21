import { describe, expect, it } from 'vitest';
import { profiles } from '../apps/server/src/profiles.js';

describe('quality gate profiles', () => {
  it('keeps unit, integration, and browser suites isolated with machine-readable reports', () => {
    const unit = profiles.typescript.find((check) => check.id === 'unit');
    const integration = profiles.typescript.find((check) => check.id === 'integration');
    const e2e = profiles.typescript.find((check) => check.id === 'e2e');

    expect(unit).toMatchObject({
      argv: ['npm', 'run', 'test:unit', '--', '--reporter=json', '--outputFile=.reports/unit.json'],
      report: 'vitest',
      reportPath: '.reports/unit.json',
    });
    expect(integration).toMatchObject({
      argv: ['npm', 'run', 'test:integration', '--', '--reporter=json', '--outputFile=.reports/integration.json'],
      report: 'vitest',
      reportPath: '.reports/integration.json',
    });
    expect(e2e).toMatchObject({ kind: 'e2e', report: 'playwright', reportPath: '.reports/e2e.json' });
  });
});
