// Adds the 三打白骨精 sample project to an existing install (design B2).
// Idempotent: skips when the seed marker is already present. Fresh installs
// get the sample automatically at server boot, so this script is mainly for
// installs that predate the seeder. Usage: npm run seed
import { seedSampleProject } from '../server/sample-project.js';

const result = seedSampleProject({ force: true });
if (result.created) {
  console.log(`已创建示例项目「西游记 · 三打白骨精」（${result.projectId}）`);
} else {
  console.log('示例项目已存在，跳过');
}
