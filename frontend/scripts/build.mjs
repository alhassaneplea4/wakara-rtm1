// Production build of the frontend, with a safety net for the Vercel build machine.
//
// Symptom this guards against: on Vercel, `ng build` prints "Output location: ..." (every file is written) and the
// process then never exits, so the platform waits 45 minutes (BUILD_EXCEEDED_MAXIMUM_TIME) and the deployment fails,
// while the same build exits normally on a developer machine. Here the build is run as a child process: as soon as it
// has announced its output location and the output is complete, a short grace period is given to exit by itself;
// after that the idle process is stopped and the build is reported as successful. A build that fails, or that never
// writes its output, still fails (non-zero exit code).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRACE_MS = Number(process.env.BUILD_EXIT_GRACE_MS ?? 20000);
// NG_BIN only exists so that this script can be tested with a stand-in that hangs on purpose.
const ngBin = process.env.NG_BIN ?? createRequire(import.meta.url).resolve('@angular/cli/bin/ng.js');
const outputs = ['dist/wakara-frontend/browser/index.html', 'dist/wakara-frontend/browser/ngsw.json'];

const child = spawn(process.execPath, [ngBin, 'build', ...process.argv.slice(2)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, NG_CLI_ANALYTICS: 'false' },
});

let announced = false;
let timer = null;
child.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  if (!announced && chunk.toString().includes('Output location:')) {
    announced = true;
    timer = setTimeout(() => {
      const complete = outputs.every(f => existsSync(path.join(root, f)));
      console.log(`\n[wakara] Build complete but the Angular CLI did not exit within ${GRACE_MS / 1000}s: stopping it${complete ? '' : ' (output INCOMPLETE)'}.`);
      child.kill('SIGKILL');
      process.exit(complete ? 0 : 1);
    }, GRACE_MS);
  }
});
child.on('exit', code => {
  if (timer) clearTimeout(timer);
  process.exit(code ?? 1);
});
