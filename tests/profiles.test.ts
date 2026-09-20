import { describe, expect, it } from 'vitest';
import { profiles } from '../apps/server/src/profiles.js';

describe('quality gate profiles', () => {
  it('runs Vitest directly so the required JSON report is produced', () => {
    const unit = profiles.typescript.find((check) => check.id === 'unit');

    expect(unit).toMatchObject({
      argv: ['npm', 'exec', '--', 'vitest', 'run', '--reporter=json', '--outputFile=.reports/unit.json'],
      report: 'vitest',
      reportPath: '.reports/unit.json',
    });
  });
});
