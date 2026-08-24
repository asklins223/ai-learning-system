#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const rootFromScript = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const semanticReview = [
  ['platform', 'V1 only ships Electron; legacy Web is migration oracle, not a release target'],
  ['rendering', 'V1 uses high-quality 2D plus DOM; no 3D/WebGL implementation'],
  ['golden-slice', 'GS-01R leads to Member strict V2 wire, then Owner whole-note production branch'],
  ['owner-completion', 'Owner flow ends at activation receipt and does not auto-enter formal LearningRun'],
  ['member-wire', 'Member uses strict V2 origin / snapshot / draft / submit / result / return'],
  ['local-api', 'Local API remains required and unavailable is distinct from untrusted'],
  ['companion', 'Default companion is orb; Live2D is optional and gated separately'],
  ['motion-owner', 'MOTION-01 uniquely owns timelines, modes and calibration values'],
  ['visual-owner', 'QG-01 uniquely owns visual directories, manifests, thresholds and approval'],
  ['freeze', 'Document confirmation does not by itself解除 implementation freeze'],
];

function parseArgs(argv) {
  const args = { root: rootFromScript, output: null, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root') args.root = resolve(argv[++index]);
    else if (value === '--output') args.output = resolve(argv[++index]);
    else if (value === '--strict') args.strict = true;
    else if (value === '--help' || value === '-h') {
      console.log('Usage: node scripts/q0-doc-check.mjs [--root PATH] [--output PATH] [--strict]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  args.output ??= resolve(args.root, '.impeccable/evidence/q0-report.json');
  return args;
}

function toRepoPath(root, filePath) {
  return relative(root, filePath).split(sep).join('/');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function gitCommit(root) {
  try {
    const result = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function designFiles(root) {
  const entries = await readdir(resolve(root, 'docs/design'), { withFileTypes: true });
  return [resolve(root, 'PRODUCT.md'), resolve(root, 'DESIGN.md')]
    .concat(entries.filter((entry) => entry.isFile() && extname(entry.name) === '.md')
      .map((entry) => resolve(root, 'docs/design', entry.name)))
    .sort();
}

function codeLineMap(lines) {
  const inside = new Array(lines.length).fill(false);
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {0,3}(`{3,}|~{3,})/);
    inside[index] = Boolean(fence);
    if (!match) continue;
    const marker = match[1];
    if (!fence) fence = { char: marker[0], length: marker.length };
    else if (marker[0] === fence.char && marker.length >= fence.length) {
      fence = null;
      inside[index] = true;
    }
  }
  return inside;
}

function checkFences(lines, path) {
  const findings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) return;
    const marker = match[1];
    if (!fence) {
      fence = { char: marker[0], length: marker.length, line: index + 1 };
      return;
    }
    if (marker[0] === fence.char && marker.length >= fence.length) {
      fence = null;
      return;
    }
    if (marker[0] !== fence.char) {
      findings.push(`${path}:${index + 1}: mismatched Markdown fence`);
    }
  });
  if (fence) findings.push(`${path}:${fence.line}: unclosed Markdown fence`);
  return findings;
}

function splitTableRow(line) {
  const trimmed = line.trim();
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const cells = [];
  let cell = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\' && body[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

function isPipeRow(line) {
  const trimmed = line.trim();
  return trimmed.includes('|') && !trimmed.startsWith('<!--');
}

function isSeparatorCell(cell) {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function checkTables(lines, path, codeLines) {
  const findings = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (codeLines[index] || codeLines[index + 1] || !isPipeRow(lines[index]) || !isPipeRow(lines[index + 1])) continue;
    const header = splitTableRow(lines[index]);
    const separator = splitTableRow(lines[index + 1]);
    if (!separator.length || !separator.every(isSeparatorCell)) continue;
    const expected = header.length;
    let row = index;
    while (row < lines.length && isPipeRow(lines[row]) && !codeLines[row]) {
      const count = splitTableRow(lines[row]).length;
      if (count !== expected) findings.push(`${path}:${row + 1}: table has ${count} columns; expected ${expected}`);
      row += 1;
    }
    index = row - 1;
  }
  return findings;
}

function slugifyHeading(value) {
  const cleaned = value
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+#+\s*$/, '')
    .trim()
    .toLocaleLowerCase();
  return cleaned
    .replace(/[^\p{Letter}\p{Number}\p{Mark}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function anchorsForMarkdown(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const base = slugifyHeading(heading[1]);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      anchors.add(count ? `${base}-${count}` : base);
    }
    for (const match of line.matchAll(/<(?:a|div)\s+[^>]*id=["']([^"']+)["']/gi)) anchors.add(match[1]);
  }
  return anchors;
}

async function checkLinks({ root, filePath, text, codeLines, textByPath }) {
  const findings = [];
  const filePathRepo = toRepoPath(root, filePath);
  const links = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of text.matchAll(links)) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    if (codeLines[line - 1]) continue;
    let target = match[1];
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) {
      if (/^file:/i.test(target)) findings.push(`${filePathRepo}:${line}: absolute file URL is not allowed`);
      continue;
    }
    if (target.startsWith('/')) {
      findings.push(`${filePathRepo}:${line}: absolute local link is not allowed`);
      continue;
    }
    const [rawPath, fragment] = target.split('#', 2);
    const decodedPath = decodeURIComponent(rawPath || '');
    const targetPath = resolve(dirname(filePath), decodedPath || filePath);
    let targetStat;
    try {
      targetStat = await stat(targetPath);
    } catch {
      findings.push(`${filePathRepo}:${line}: missing local link target ${target}`);
      continue;
    }
    if (!targetStat.isFile()) {
      findings.push(`${filePathRepo}:${line}: local link target is not a file ${target}`);
      continue;
    }
    if (fragment) {
      const targetText = targetPath === filePath ? text : textByPath.get(targetPath);
      if (targetText == null) continue;
      if (!anchorsForMarkdown(targetText).has(decodeURIComponent(fragment))) {
        findings.push(`${filePathRepo}:${line}: missing local anchor #${fragment}`);
      }
    }
  }
  return findings;
}

function checkMetadata(text, path) {
  const checks = [
    ['status', /(?:\b(?:DRAFT|PROPOSED|ACCEPTED|BLOCKED|FROZEN|CONFIRMED|DEFERRED|OWNER-CONFIRMED)\b|状态|current disposition)/i],
    ['version', /(?:\bv\d+(?:\.\d+)*\b|version|revision|修订|版本)/i],
    ['date', /(?:\b20\d{2}-\d{2}-\d{2}\b|更新日期|日期)/i],
    ['freeze', /(?:冻结|freeze|frozen|NON_EXECUTABLE|IMPLEMENTATION_FROZEN)/i],
  ];
  return checks.filter(([, pattern]) => !pattern.test(text)).map(([id]) => `${path}: missing required Q0 metadata: ${id}`);
}

function checkUnsafePaths(lines, path) {
  const findings = [];
  const pattern = /(?:file:\/\/|\/(?:Users|home|private\/tmp|tmp|var\/folders)\/|\b[A-Za-z]:[\\/])/;
  lines.forEach((line, index) => {
    if (pattern.test(line)) findings.push(`${path}:${index + 1}: absolute or temporary path is not allowed`);
  });
  return findings;
}

function collectIdDeclarations(text, path) {
  const declarations = [];
  const idPattern = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+';
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const document = line.match(/(?:文档\s*ID|Document\s*ID)\s*[:：]\s*`([^`]+)`/i);
    if (document) declarations.push({ id: document[1], path, line: index + 1, kind: 'document' });
    const table = line.match(new RegExp(`^\\s*\\|\\s*\\x60(${idPattern})\\x60\\s*\\|`));
    if (table && !/^(?:MOTION-(?:WINDOW|ONBOARDING)-|AUDIO-|STATIC-|P[04]-|REF-|FB-)/i.test(table[1])) {
      declarations.push({ id: table[1], path, line: index + 1, kind: 'gate-or-decision', reuse: /复用|引用|reference|唯一事实来源/i.test(line) });
    }
  }
  return declarations;
}

function summarizeFindings(id, findings, statusWhenFindings = 'failed') {
  return { id, status: findings.length ? statusWhenFindings : 'passed', findings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = await designFiles(args.root);
  const contents = new Map();
  const fileRecords = [];
  for (const filePath of files) {
    const text = await readFile(filePath, 'utf8');
    contents.set(filePath, text);
    fileRecords.push({ path: toRepoPath(args.root, filePath), sha256: sha256(text), bytes: Buffer.byteLength(text) });
  }

  const findings = [];
  const declarations = [];
  for (const filePath of files) {
    const text = contents.get(filePath);
    const lines = text.split(/\r?\n/);
    const codeLines = codeLineMap(lines);
    const path = toRepoPath(args.root, filePath);
    findings.push(...checkFences(lines, path));
    findings.push(...checkTables(lines, path, codeLines));
    findings.push(...checkMetadata(text, path));
    findings.push(...checkUnsafePaths(lines, path));
    findings.push(...await checkLinks({ root: args.root, filePath, text, codeLines, textByPath: contents }));
    declarations.push(...collectIdDeclarations(text, path));
  }

  const duplicateDeclarations = [];
  const byId = new Map();
  for (const declaration of declarations) {
    const entries = byId.get(declaration.id) ?? [];
    entries.push(declaration);
    byId.set(declaration.id, entries);
  }
  for (const [id, entries] of byId) {
    if (entries.length < 2 || entries.every((entry) => entry.reuse)) continue;
    duplicateDeclarations.push({ id, declarations: entries });
  }

  const ownerSignals = [];
  for (const [filePath, text] of contents) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (/Owner|OWNER/i.test(line) && /待|未|阻塞|确认|approval|pending|BLOCKED/i.test(line)) {
        ownerSignals.push({ path: toRepoPath(args.root, filePath), line: index + 1, text: line.trim().slice(0, 240) });
      }
    }
  }

  const automaticChecks = [
    summarizeFindings('markdown-fence-pairs', findings.filter((item) => item.includes('fence'))),
    summarizeFindings('markdown-links-and-anchors', findings.filter((item) => item.includes('local link') || item.includes('anchor'))),
    summarizeFindings('markdown-table-columns', findings.filter((item) => item.includes('table has'))),
    summarizeFindings('required-metadata', findings.filter((item) => item.includes('required Q0 metadata'))),
    summarizeFindings('unsafe-paths-and-screenshot-targets', findings.filter((item) => item.includes('absolute') || item.includes('temporary') || item.includes('missing local link target'))),
    summarizeFindings(
      'document-id-reuse-review',
      duplicateDeclarations.map((entry) => `${entry.id}: cross-document reference requires semantic reuse review`),
      'review',
    ),
  ];
  const automaticFailures = automaticChecks.filter((check) => check.status === 'failed').length;
  const report = {
    schemaVersion: 1,
    kind: 'q0-doc-report',
    generatedAt: new Date().toISOString(),
    suiteRevision: await gitCommit(args.root),
    scope: { files: fileRecords, source: 'PRODUCT.md, DESIGN.md, docs/design/*.md' },
    automaticChecks,
    duplicateIdDeclarations: duplicateDeclarations,
    manualReviewRequired: semanticReview.map(([id, requirement]) => ({ id, requirement, status: 'pending' })),
    unresolvedOwnerSignals: ownerSignals,
    findings,
    closeEligible: automaticFailures === 0 && duplicateDeclarations.length === 0 && semanticReview.length === 0,
    closeReason: automaticFailures
      ? 'Automatic Q0 findings remain; semantic review is also required.'
      : duplicateDeclarations.length
        ? 'Automatic checks are clean; cross-document ID references and semantic review still require review.'
      : 'Automatic checks are clean, but the required semantic review and Owner decision record are still pending.',
  };

  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: toRepoPath(args.root, args.output),
    files: files.length,
    automaticFailures,
    duplicateDeclarations: duplicateDeclarations.length,
    manualReviewItems: semanticReview.length,
    closeEligible: report.closeEligible,
  }, null, 2));
  if (args.strict && automaticFailures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
