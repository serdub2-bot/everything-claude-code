#!/usr/bin/env node
/**
 * Executes a hook script only when enabled by ECC hook profile flags.
 *
 * Usage:
 *   node run-with-flags.js <hookId> <scriptRelativePath> [profilesCsv] [extraArgs...]
 *
 * .js hooks run under Node; .sh hooks run under a resolved bash
 * (Git Bash or WSL bash on Windows — see resolveWindowsBash).
 * Extra args after profilesCsv are forwarded to the hook script
 * (e.g. "pre"/"post" for hooks that need their phase).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isHookEnabled } = require('../lib/hook-flags');

const MAX_STDIN = 1024 * 1024;

function readStdinRaw() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.substring(0, remaining);
      }
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

// Convert a Windows path like C:\dir\file to the /mnt/c/dir/file form
// understood inside WSL, or /c/dir/file for MSYS/Git Bash.
function driveLetterTo(prefix, winPath) {
  const m = /^([A-Za-z]):[\\\/]([\s\S]*)$/.exec(winPath);
  if (!m) return winPath;
  return `${prefix}${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}
const toWslPath = p => driveLetterTo('/mnt/', p);
const toMsysPath = p => driveLetterTo('/', p);

// Locate a bash that can run *.sh hooks on Windows.
// WSL's bash.exe only understands /mnt/<drive>/ paths; Git Bash uses /c/
// paths, so the flavor determines how the script path must be rewritten.
function resolveWindowsBash() {
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, process.env.GIT_BASH_PATH].filter(Boolean);

  try {
    const whereGit = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' });
    const gitExe = (whereGit.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (gitExe) {
      candidates.push(path.join(path.dirname(gitExe), '..', 'bin', 'bash.exe'));
    }
  } catch {
    /* where.exe missing — keep going */
  }

  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  );

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { cmd: candidate, flavor: 'msys' };
    } catch {
      /* keep looking */
    }
  }

  // Fall back to whatever `bash` resolves to on PATH. The WSL launcher lives
  // in System32; anything else is assumed to be an MSYS-style bash.
  try {
    const whereBash = spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8' });
    const bashExe = (whereBash.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (bashExe) {
      const isWslLauncher = /system32\\bash\.exe$/i.test(bashExe);
      return { cmd: bashExe, flavor: isWslLauncher ? 'wsl' : 'msys' };
    }
  } catch {
    /* no bash on PATH */
  }

  return null;
}

// Returns { cmd, argPath } for spawning a .sh hook, or null when no bash exists.
function resolveShellRunner(scriptPath) {
  if (process.platform !== 'win32') {
    return { cmd: 'bash', argPath: scriptPath };
  }
  const bash = resolveWindowsBash();
  if (!bash) return null;
  const argPath = bash.flavor === 'wsl' ? toWslPath(scriptPath) : toMsysPath(scriptPath);
  return { cmd: bash.cmd, argPath };
}

function getPluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT && process.env.CLAUDE_PLUGIN_ROOT.trim()) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return path.resolve(__dirname, '..', '..');
}

async function main() {
  const [, , hookId, relScriptPath, profilesCsv] = process.argv;
  const raw = await readStdinRaw();

  if (!hookId || !relScriptPath) {
    process.stdout.write(raw);
    process.exit(0);
  }

  if (!isHookEnabled(hookId, { profiles: profilesCsv })) {
    process.stdout.write(raw);
    process.exit(0);
  }

  const pluginRoot = getPluginRoot();
  const resolvedRoot = path.resolve(pluginRoot);
  const scriptPath = path.resolve(pluginRoot, relScriptPath);

  // Prevent path traversal outside the plugin root
  if (!scriptPath.startsWith(resolvedRoot + path.sep)) {
    process.stderr.write(`[Hook] Path traversal rejected for ${hookId}: ${scriptPath}\n`);
    process.stdout.write(raw);
    process.exit(0);
  }

  if (!fs.existsSync(scriptPath)) {
    process.stderr.write(`[Hook] Script not found for ${hookId}: ${scriptPath}\n`);
    process.stdout.write(raw);
    process.exit(0);
  }

  const extraArgs = process.argv.slice(5);

  // Shell hooks (*.sh) run under bash. On Windows the right interpreter and
  // path form differ between Git Bash (/c/...) and WSL bash (/mnt/c/...);
  // resolveShellRunner picks both. Without a bash, pass input through.
  if (scriptPath.toLowerCase().endsWith('.sh')) {
    const shell = resolveShellRunner(scriptPath);
    if (!shell) {
      process.stderr.write(`[Hook] No bash found for ${hookId}; passing input through\n`);
      process.stdout.write(raw);
      process.exit(0);
    }

    const shResult = spawnSync(shell.cmd, [shell.argPath, ...extraArgs], {
      input: raw,
      encoding: 'utf8',
      env: process.env,
      cwd: process.cwd(),
      timeout: 30000
    });

    if (shResult.stdout) process.stdout.write(shResult.stdout);
    if (shResult.stderr) process.stderr.write(shResult.stderr);
    process.exit(Number.isInteger(shResult.status) ? shResult.status : 0);
  }

  // Prefer direct require() when the hook exports a run(rawInput) function.
  // This eliminates one Node.js process spawn (~50-100ms savings per hook).
  //
  // SAFETY: Only require() hooks that export run(). Legacy hooks execute
  // side effects at module scope (stdin listeners, process.exit, main() calls)
  // which would interfere with the parent process or cause double execution.
  let hookModule;
  const src = fs.readFileSync(scriptPath, 'utf8');
  const hasRunExport = /\bmodule\.exports\b/.test(src) && /\brun\b/.test(src);

  if (hasRunExport) {
    try {
      hookModule = require(scriptPath);
    } catch (requireErr) {
      process.stderr.write(`[Hook] require() failed for ${hookId}: ${requireErr.message}\n`);
      // Fall through to legacy spawnSync path
    }
  }

  if (hookModule && typeof hookModule.run === 'function') {
    try {
      const output = hookModule.run(raw);
      if (output !== null && output !== undefined) process.stdout.write(output);
    } catch (runErr) {
      process.stderr.write(`[Hook] run() error for ${hookId}: ${runErr.message}\n`);
      process.stdout.write(raw);
    }
    process.exit(0);
  }

  // Legacy path: spawn a child Node process for hooks without run() export
  const result = spawnSync('node', [scriptPath, ...extraArgs], {
    input: raw,
    encoding: 'utf8',
    env: process.env,
    cwd: process.cwd(),
    timeout: 30000
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const code = Number.isInteger(result.status) ? result.status : 0;
  process.exit(code);
}

main().catch(err => {
  process.stderr.write(`[Hook] run-with-flags error: ${err.message}\n`);
  process.exit(0);
});
