import { minimatch } from 'minimatch';
import { testEvidencePolicySchema, type Repository } from '../../../shared/types.js';

const normalized = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');

export function changedTestEvidence(repository: Repository, changedPaths: string[]) {
  const policy = repository.testEvidence || testEvidencePolicySchema.parse(undefined);
  const paths = changedPaths.map(normalized);
  const sourceFiles = paths.filter((path) => policy.sourcePaths.some((glob) => minimatch(path, glob)));
  const testFiles = paths.filter((path) => policy.testPaths.some((glob) => minimatch(path, glob)));
  return {
    applicable: policy.requiredForSourceChanges && sourceFiles.length > 0,
    satisfied: testFiles.length > 0,
    sourceFiles,
    testFiles,
  };
}
