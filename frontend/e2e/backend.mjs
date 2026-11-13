// Isolated API for the end-to-end tests: a temporary SQLite database, fictional accounts, nothing shared with
// the development database. Started by Playwright (see ../playwright.config.ts).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../backend');
const venv = process.platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python';
const python = process.env.E2E_PYTHON ?? (existsSync(path.join(backend, venv)) ? path.join(backend, venv) : 'python');
const port = process.env.E2E_API_PORT ?? '8011';

if (!process.env.E2E_PASSWORD) throw new Error('E2E_PASSWORD manquant (il est généré par playwright.config.ts).');

const dir = mkdtempSync(path.join(os.tmpdir(), 'wakara-e2e-'));
const env = {
  ...process.env,
  DEBUG: 'True', SECRET_KEY: randomBytes(48).toString('hex'), DATABASE_URL: '', DB_ENGINE: 'django.db.backends.sqlite3',
  SQLITE_PATH: path.join(dir, 'e2e.sqlite3'), DOCUMENTS_STORAGE: 'database', LOGIN_THROTTLE_RATE: '1000/min',
  ALLOWED_HOSTS: 'localhost,127.0.0.1', PYTHONUNBUFFERED: '1',
};

function manage(...args) {
  const result = spawnSync(python, ['manage.py', ...args], { cwd: backend, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const SEED = `
import os
from accounts.models import CustomUser, Role, UserRole
for username, role in (('agent.e2e', 'collection_agent'), ('agent2.e2e', 'collection_agent'), ('admin.e2e', 'admin')):
    user = CustomUser.objects.create_user(username=username, password=os.environ['E2E_PASSWORD'],
                                          first_name=username.split('.')[0].title(), last_name='Essai')
    UserRole.objects.create(user=user, role=Role.objects.get(codename=role))
`;

manage('migrate', '--noinput', '-v', '0');
manage('setup_initial_data', '--skip-admin', '-v', '0');
manage('shell', '-c', SEED);

const server = spawn(python, ['manage.py', 'runserver', `127.0.0.1:${port}`, '--noreload'], { cwd: backend, env, stdio: 'inherit' });
const stop = () => { server.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', code => process.exit(code ?? 0));
