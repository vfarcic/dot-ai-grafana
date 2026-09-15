import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseThreshold, parseBaselineRunId, evaluateGrowth } from './bundle-size-summary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, 'bundle-size-summary.mjs');

describe('bundle-size-summary', () => {
  describe('threshold parsing', () => {
    test('a non-numeric BUNDLE_SIZE_THRESHOLD fails', () => {
      assert.throws(
        () => parseThreshold('not-a-number'),
        /BUNDLE_SIZE_THRESHOLD is not a number: "not-a-number"/
      );
      assert.throws(
        () => parseThreshold('NaN'),
        /BUNDLE_SIZE_THRESHOLD is not a number: "NaN"/
      );
      assert.throws(
        () => parseThreshold('12px'),
        /BUNDLE_SIZE_THRESHOLD is not a number: "12px"/
      );
      assert.throws(
        () => parseThreshold('true'),
        /BUNDLE_SIZE_THRESHOLD is not a number: "true"/
      );
    });

    test('an absent or empty BUNDLE_SIZE_THRESHOLD fails', () => {
      assert.throws(
        () => parseThreshold(undefined),
        /BUNDLE_SIZE_THRESHOLD is required and was not provided/
      );
      assert.throws(
        () => parseThreshold(null),
        /BUNDLE_SIZE_THRESHOLD is required and was not provided/
      );
      assert.throws(
        () => parseThreshold(''),
        /BUNDLE_SIZE_THRESHOLD is empty/
      );
      assert.throws(
        () => parseThreshold('   '),
        /BUNDLE_SIZE_THRESHOLD is empty/
      );
    });

    test('valid numeric thresholds work, including percentages and decimals', () => {
      assert.equal(parseThreshold('5'), 5);
      assert.equal(parseThreshold('10%'), 10);
      assert.equal(parseThreshold('2.5'), 2.5);
      assert.equal(parseThreshold(' 3.75% '), 3.75);
      assert.equal(parseThreshold(0), 0);
    });

    test('runtime script fails closed when BUNDLE_SIZE_THRESHOLD is non-numeric', () => {
      const res = spawnSync(process.execPath, [SCRIPT_PATH, 'base.json', 'pr.json'], {
        env: { ...process.env, BUNDLE_SIZE_THRESHOLD: 'invalid' },
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.ok(res.stdout.includes('::error title=Bundle size comparison failed::BUNDLE_SIZE_THRESHOLD is not a number: "invalid"'));
    });

    test('runtime script fails closed when BUNDLE_SIZE_THRESHOLD is missing', () => {
      const envWithout = { ...process.env };
      delete envWithout.BUNDLE_SIZE_THRESHOLD;
      const res = spawnSync(process.execPath, [SCRIPT_PATH, 'base.json', 'pr.json'], {
        env: envWithout,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1);
      assert.ok(res.stdout.includes('::error title=Bundle size comparison failed::BUNDLE_SIZE_THRESHOLD is required and was not provided'));
    });
  });

  describe('growth evaluation under and over limit', () => {
    test('growth under threshold does not exceed', () => {
      // 1000 -> 1040 is 4% growth, under threshold 5%
      const res = evaluateGrowth(1000, 1040, 5);
      assert.equal(res.totalDiff, 40);
      assert.ok(Math.abs(res.growth - 4.0) < 1e-6);
      assert.equal(res.exceeded, false);
    });

    test('growth over threshold exceeds', () => {
      // 1000 -> 1060 is 6% growth, over threshold 5%
      const res = evaluateGrowth(1000, 1060, 5);
      assert.equal(res.totalDiff, 60);
      assert.ok(Math.abs(res.growth - 6.0) < 1e-6);
      assert.equal(res.exceeded, true);
    });

    test('growth exactly at threshold exceeds (boundary)', () => {
      // 1000 -> 1050 is 5% growth, equal to threshold 5%
      const res = evaluateGrowth(1000, 1050, 5);
      assert.equal(res.totalDiff, 50);
      assert.ok(Math.abs(res.growth - 5.0) < 1e-6);
      assert.equal(res.exceeded, true);
    });

    test('bundle shrinkage never exceeds threshold', () => {
      // 1000 -> 900 is -10% growth
      const res = evaluateGrowth(1000, 900, 5);
      assert.equal(res.totalDiff, -100);
      assert.ok(Math.abs(res.growth - (-10.0)) < 1e-6);
      assert.equal(res.exceeded, false);
    });
  });

  describe('baseline run-id parsing and failure modes', () => {
    test('a valid numeric run-id passes', () => {
      const res = parseBaselineRunId('1234567890\n');
      assert.equal(res.runId, '1234567890');
      assert.equal(res.error, '');
    });

    test('empty run-id indicates no baseline without error', () => {
      const res = parseBaselineRunId('');
      assert.equal(res.runId, '');
      assert.equal(res.error, '');
    });

    test('a non-numeric baseline run-id fails closed with a distinct error signal', () => {
      const warningRes = parseBaselineRunId('warning: could not find artifact\n');
      assert.equal(warningRes.runId, '');
      assert.equal(warningRes.error, 'baseline run-id is not numeric: warning: could not find artifact');

      const textRes = parseBaselineRunId('null');
      assert.equal(textRes.runId, '');
      assert.equal(textRes.error, 'baseline run-id is not numeric: null');

      const alphaRes = parseBaselineRunId('123abc');
      assert.equal(alphaRes.runId, '');
      assert.equal(alphaRes.error, 'baseline run-id is not numeric: 123abc');
    });

    test('missing run-id fails closed with missing signal', () => {
      const res = parseBaselineRunId(null);
      assert.equal(res.runId, '');
      assert.equal(res.error, 'baseline run-id is missing');
    });
  });
});
