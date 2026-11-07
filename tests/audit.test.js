// Tests for scripts/audit-repo.sh: spawns bash on a throw-away git repository. Skips when bash or git is unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'audit-repo.sh');

function findBash() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'bash']
    : ['bash'];
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'ok') return c;
  }
  return null;
}
const BASH = findBash();
const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = !BASH || !HAS_GIT ? { skip: 'bash or git unavailable' } : {};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cqa-audit-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.env.example'), 'PORT=8080\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function runAudit(dir, env = {}) {
  const posix = (p) => p.replace(/\\/g, '/');
  const r = spawnSync(BASH, [posix(SCRIPT)], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, CQA_AUDIT_REPO: posix(dir), CQA_AUDIT_PATHS_FILE: '', CQA_AUDIT_TERMS_FILE: '', CQA_AUDIT_READONLY_REPO: '', ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('audit passes on a clean repo and lists files', SKIP, () => {
  const dir = makeRepo();
  try {
    const r = runAudit(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /AUDIT PASSED/);
    assert.match(r.out, /src\/a\.js/);
    assert.match(r.out, /Summary: 3 files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit fails on tracked .env, *.pem, node_modules', SKIP, () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, '.env'), 'X=1\n');
    writeFileSync(join(dir, 'cert.pem'), 'x\n');
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x\n');
    git(dir, 'add', '-A', '-f');
    const r = runAudit(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /secret-like paths/);
    assert.match(r.out, /\.env/);
    assert.match(r.out, /cert\.pem/);
    assert.match(r.out, /node_modules/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit fails on key-like strings in tracked text', SKIP, () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'src', 'cfg.js'), `const k = 'sk-ant-${'a'.repeat(30)}';\nconst g = 'ghp_${'B'.repeat(36)}';\nconst aws = 'AKIA${'C'.repeat(16)}';\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'leak');
    const r = runAudit(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /key-like strings/);
    assert.match(r.out, /src\/cfg\.js:1/);
    assert.match(r.out, /src\/cfg\.js:2/);
    assert.match(r.out, /src\/cfg\.js:3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit honours external path and term deny-lists without echoing the terms', SKIP, () => {
  const dir = makeRepo();
  const lists = mkdtempSync(join(tmpdir(), 'cqa-audit-lists-'));
  try {
    mkdirSync(join(dir, 'secretdir'));
    writeFileSync(join(dir, 'secretdir', 'notes.md'), 'hello\n');
    writeFileSync(join(dir, 'src', 'b.js'), '// The ZEBRAWORD appears here\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'more');
    writeFileSync(join(lists, 'paths.txt'), '# comment\nsecretdir/\n*.tmp\n');
    writeFileSync(join(lists, 'terms.txt'), 'zebraword\n');
    const r = runAudit(dir, { CQA_AUDIT_PATHS_FILE: join(lists, 'paths.txt').replace(/\\/g, '/'), CQA_AUDIT_TERMS_FILE: join(lists, 'terms.txt').replace(/\\/g, '/') });
    assert.equal(r.code, 1);
    assert.match(r.out, /secretdir\/notes\.md/);
    assert.match(r.out, /forbidden terms found/);
    assert.match(r.out, /src\/b\.js:1/);
    assert.ok(!/zebraword/i.test(r.out.replace(/src\/b\.js:1/g, '')), 'the term itself is not printed');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(lists, { recursive: true, force: true }); }
});

test('audit fails when the read-only repository is dirty', SKIP, () => {
  const dir = makeRepo();
  const ro = makeRepo();
  try {
    assert.equal(runAudit(dir, { CQA_AUDIT_READONLY_REPO: ro.replace(/\\/g, '/') }).code, 0);
    writeFileSync(join(ro, 'dirty.txt'), 'x\n');
    const r = runAudit(dir, { CQA_AUDIT_READONLY_REPO: ro.replace(/\\/g, '/') });
    assert.equal(r.code, 1);
    assert.match(r.out, /read-only repository has changes/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(ro, { recursive: true, force: true }); }
});
