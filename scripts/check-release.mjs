import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import { releaseFiles } from './release-files.mjs';

const env = existsSync('.env') ? parse(readFileSync('.env')) : {};
const knownSecrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD/.test(key) && value.length >= 8);
const findings = [];
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub credential', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['credential-bearing stream URL', /https?:\/\/[^\s'"`]+\/live\/[^\s'"`$<>]+\/[^\s'"`$<>]+\/\d+/],
];
function scan(file, data, revision) {
  const text = data.toString('utf8');
  for (const [key, value] of knownSecrets) if (text.includes(value)) findings.push({ file, revision, rule: `configured ${key}` });
  for (const [index, line] of text.split('\n').entries()) {
    for (const [rule, pattern] of secretPatterns) if (pattern.test(line)) findings.push({ file, revision, line: index + 1, rule });
    // Assignment literals with realistic lengths; ignore variable references,
    // example/test credentials, regex definitions and documentation placeholders.
    if (!file.startsWith('test/') && !file.startsWith('scripts/') && /(?:TOKEN|SECRET|PASSWORD)\s*[:=]\s*['"][A-Za-z0-9_+\/-]{16,}['"]/.test(line)
      && !/process\.env|changeme|example|placeholder|test-/i.test(line)) findings.push({ file, revision, line: index + 1, rule: 'credential assignment candidate' });
  }
}

const gitIndex = process.argv.indexOf('--git-dir');
if (gitIndex >= 0) {
  const repository = process.argv[gitIndex + 1];
  if (!repository) throw new Error('--git-dir requires a local repository path');
  const git = (...args) => execFileSync('git', [`--git-dir=${repository}`, ...args], { maxBuffer: 100 * 1024 * 1024 });
  const objects = git('rev-list', '--objects', '--all').toString().trim().split('\n');
  let count = 0;
  for (const line of objects) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const revision = line.slice(0, space); const file = line.slice(space + 1);
    if (git('cat-file', '-t', revision).toString().trim() !== 'blob') continue;
    count++; scan(file, git('cat-file', 'blob', revision), revision);
  }
  console.log(`Scanned ${count} reachable historical blobs. Commit metadata and deleted/unreachable objects require separate review.`);
} else {
  const files = releaseFiles();
  for (const file of files) {
    if (/(?:^|\/)(?:\.env(?!\.example$)(?:\.[^/]*)?|\.sessions\.json|\.local-finished\.json|\.installation\.json|config\.local\.json)$/.test(file)) findings.push({ file, rule: 'private runtime file' });
    scan(file, readFileSync(file));
  }
  console.log(`Scanned ${files.length} allowlisted source files. Active config.json is replaced by config.example.json in exports.`);
}
for (const finding of findings) console.log(JSON.stringify(finding)); // Never include matched values.
console.log(findings.length ? `${findings.length} finding(s); review before publication.` : 'No configured-secret matches or selected credential patterns found. This is not an exhaustive secret scanner.');
process.exitCode = findings.length ? 1 : 0;
