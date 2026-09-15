// Compares two webpack stats files and renders the difference as a Markdown
// report into $GITHUB_STEP_SUMMARY (stdout when run locally).
//
// This exists because grafana/plugin-actions/bundle-size can only report through
// a pull request comment, and GitHub hands `pull_request` runs from a fork a
// read-only GITHUB_TOKEN, so that comment is impossible for every outside
// contributor. Reporting into the job summary needs no write scope at all, so
// one code path serves fork and non-fork pull requests alike.
//
// Usage: node .github/scripts/bundle-size-summary.mjs <base-stats.json> <pr-stats.json>
// Exits non-zero only when the stats themselves cannot be read or parsed - bundle
// growth is reported, never a failure, matching the upstream action's behaviour.

import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Percentage growth of the entrypoint total above which the report is also
// raised as a workflow warning annotation. Mirrors the upstream action default (5).
// Must be set, non-empty, and numeric (optional trailing %). Fails closed.
export function parseThreshold(raw) {
  if (raw == null) {
    throw new Error('BUNDLE_SIZE_THRESHOLD is required and was not provided');
  }
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    throw new Error('BUNDLE_SIZE_THRESHOLD is empty');
  }
  const numeric = trimmed.endsWith('%') ? trimmed.slice(0, -1).trim() : trimmed;
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(numeric)) {
    throw new Error(`BUNDLE_SIZE_THRESHOLD is not a number: ${JSON.stringify(raw)}`);
  }
  const value = Number(numeric);
  if (!Number.isFinite(value)) {
    throw new Error(`BUNDLE_SIZE_THRESHOLD is not a number: ${JSON.stringify(raw)}`);
  }
  return value;
}

// Parses and validates baseline run ID from GitHub actions artifact lookup.
// Must be non-empty digits-only. Fails closed with an error signal.
export function parseBaselineRunId(raw) {
  if (raw == null) {
    return { runId: '', error: 'baseline run-id is missing' };
  }
  const cleaned = String(raw).replace(/[\r\n]+/g, '').trim();
  if (cleaned === '') {
    return { runId: '', error: '' };
  }
  if (!/^[0-9]+$/.test(cleaned)) {
    return { runId: '', error: `baseline run-id is not numeric: ${cleaned}` };
  }
  return { runId: cleaned, error: '' };
}

// Longest asset/entry tables to render, so a chunk-splitting change cannot bury
// the summary under hundreds of rows.
const MAX_ROWS = 20;

function readStats(label, file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label} stats from ${file}: ${error.message}`);
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error(`${label} stats from ${file} have no "assets" array - not a webpack stats file?`);
  }
  return parsed;
}

// entrypoints is an object keyed by entry name; assetsSize is the emitted total.
function entrySizes(stats) {
  return new Map(
    Object.entries(stats.entrypoints ?? {}).map(([key, entry]) => [entry.name ?? key, entry.assetsSize ?? 0])
  );
}

function assetSizes(stats) {
  return new Map(stats.assets.map((asset) => [asset.name, asset.size ?? 0]));
}

function bytes(size) {
  const sign = size < 0 ? '-' : '';
  const abs = Math.abs(size);
  if (abs < 1024) {
    return `${sign}${abs} B`;
  }
  if (abs < 1024 * 1024) {
    return `${sign}${(abs / 1024).toFixed(2)} KiB`;
  }
  return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MiB`;
}

function signedBytes(size) {
  return size > 0 ? `+${bytes(size)}` : bytes(size);
}

// A new file has no old size to grow from, so a percentage would be Infinity.
function percentage(oldSize, newSize) {
  if (oldSize === 0) {
    return newSize === 0 ? '0.00%' : 'new';
  }
  const value = ((newSize - oldSize) / oldSize) * 100;
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function diffRows(oldSizes, newSizes) {
  const rows = [];
  for (const name of new Set([...oldSizes.keys(), ...newSizes.keys()])) {
    const oldSize = oldSizes.get(name) ?? 0;
    const newSize = newSizes.get(name) ?? 0;
    rows.push({ name, oldSize, newSize, diff: newSize - oldSize });
  }
  return rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name));
}

// Note: sums entrypoints[*].assetsSize across all entrypoints. If an asset is
// shared by two or more entrypoints, it is counted multiple times in this total.
// This plugin currently has a single entrypoint ("module"), so there is no
// double-counting in practice. This matches grafana/plugin-actions/bundle-size
// compareStats.js deliberately so totals remain consistent with historical runs.
function total(sizes) {
  return [...sizes.values()].reduce((sum, size) => sum + size, 0);
}

function table(rows) {
  const lines = ['| Name | main | This PR | Change | % |', '| --- | --- | --- | --- | --- |'];
  for (const row of rows.slice(0, MAX_ROWS)) {
    const label = row.oldSize === 0 ? `${row.name} 🆕` : row.newSize === 0 ? `${row.name} 🗑️` : row.name;
    lines.push(
      `| ${label} | ${bytes(row.oldSize)} | ${bytes(row.newSize)} | ${signedBytes(row.diff)} | ${percentage(row.oldSize, row.newSize)} |`
    );
  }
  if (rows.length > MAX_ROWS) {
    lines.push(`| _…and ${rows.length - MAX_ROWS} more_ | | | | |`);
  }
  return lines.join('\n');
}

// Compares entrypoint growth against threshold. Returns whether threshold was reached/exceeded.
export function evaluateGrowth(baseTotal, prTotal, threshold) {
  const totalDiff = prTotal - baseTotal;
  const growth = baseTotal === 0 ? 0 : ((prTotal - baseTotal) / baseTotal) * 100;
  const exceeded = growth >= threshold;
  return { totalDiff, growth, exceeded };
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMain()) {
const [baseFile, prFile] = process.argv.slice(2);
if (!baseFile || !prFile) {
  console.error('Usage: node .github/scripts/bundle-size-summary.mjs <base-stats.json> <pr-stats.json>');
  process.exit(1);
}

try {
  const THRESHOLD = parseThreshold(process.env.BUNDLE_SIZE_THRESHOLD);
  const baseStats = readStats('main branch', baseFile);
  const prStats = readStats('pull request', prFile);

  const baseEntries = entrySizes(baseStats);
  const prEntries = entrySizes(prStats);
  const baseTotal = total(baseEntries);
  const prTotal = total(prEntries);
  const { totalDiff, growth, exceeded } = evaluateGrowth(baseTotal, prTotal, THRESHOLD);
  const headline =
    totalDiff === 0
      ? `No change to the entrypoint total (${bytes(prTotal)}).`
      : `Entrypoint total ${totalDiff > 0 ? 'grew' : 'shrank'} by ${signedBytes(totalDiff)} (${percentage(baseTotal, prTotal)}) to ${bytes(prTotal)}.`;

  const assetRows = diffRows(assetSizes(baseStats), assetSizes(prStats)).filter((row) => row.diff !== 0);

  const report = [
    '## Bundle size',
    '',
    headline,
    '',
    '### Entrypoints',
    '',
    table(diffRows(baseEntries, prEntries)),
    '',
    '### Changed assets',
    '',
    assetRows.length === 0 ? '_No asset changed size._' : table(assetRows),
    '',
    '<sub>Compared against the latest `main` build. Growth is reported, not enforced: this job fails only when the bundle cannot be built or measured.</sub>',
    '',
  ].join('\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  } else {
    console.log(report);
  }

  console.log(headline);
  if (exceeded) {
    console.log(
      `::warning title=Bundle size grew by ${growth.toFixed(2)}%::The entrypoint total grew more than ${THRESHOLD}% against main. See the job summary for the breakdown.`
    );
  }
} catch (error) {
  // A stack trace here would only point at this script; the message is the signal.
  console.log(`::error title=Bundle size comparison failed::${error.message}`);
  process.exit(1);
}
}
