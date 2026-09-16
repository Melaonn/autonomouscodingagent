import type { CheckCommand } from '../../../shared/types.js';
const check = (id: string, kind: CheckCommand['kind'], argv: string[], report: CheckCommand['report'] = 'exit', reportPath = ''): CheckCommand => ({ id, label: id.replace(/-/g, ' '), kind, argv, report, reportPath, required: true, timeoutSeconds: 600, baselineAllowed: false });
export const profiles: Record<string, CheckCommand[]> = {
  typescript: [check('install', 'setup', ['npm', 'ci', '--ignore-scripts']), check('build', 'build', ['npm', 'run', 'build']),
    check('lint', 'lint', ['npm', 'run', 'lint']), check('typecheck', 'types', ['npm', 'run', 'typecheck']),
    check('unit', 'unit', ['npm', 'run', 'test:unit', '--', '--reporter=json', '--outputFile=.reports/unit.json'], 'vitest', '.reports/unit.json'),
    check('integration', 'integration', ['npm', 'run', 'test:integration', '--', '--reporter=json', '--outputFile=.reports/integration.json'], 'vitest', '.reports/integration.json'),
    check('e2e', 'e2e', ['npx', '--no-install', 'playwright', 'test', '--reporter=json'], 'playwright', '.reports/playwright.json'),
    check('dependencies', 'security', ['npm', 'audit', '--json'], 'npm-audit', '.reports/audit.json')],
  python: [check('install', 'setup', ['uv', 'sync', '--frozen']), check('build', 'build', ['uv', 'build']),
    check('lint', 'lint', ['uv', 'run', '--no-sync', 'ruff', 'check', '.']), check('typecheck', 'types', ['uv', 'run', '--no-sync', 'mypy', '.']),
    check('unit', 'unit', ['uv', 'run', '--no-sync', 'pytest', 'tests/unit', '--junitxml=.reports/unit.xml'], 'junit', '.reports/unit.xml'),
    check('integration', 'integration', ['uv', 'run', '--no-sync', 'pytest', 'tests/integration', '--junitxml=.reports/integration.xml'], 'junit', '.reports/integration.xml'),
    check('dependencies', 'security', ['uv', 'run', '--no-sync', 'pip-audit', '--format=json'], 'pip-audit', '.reports/audit.json')],
};
const security = [check('sast', 'security', ['semgrep', 'scan', '--config=p/security-audit', '--json', '--output=.reports/semgrep.json'], 'semgrep', '.reports/semgrep.json'),
  check('secrets', 'security', ['gitleaks', 'dir', '.', '--report-format=json', '--report-path=.reports/gitleaks.json'], 'gitleaks', '.reports/gitleaks.json')];
for (const profile of Object.values(profiles)) profile.push(...security);
