import test from 'node:test';
import assert from 'node:assert/strict';
import { sameAhFixture, supplementFtAhLine } from '../lib/ftAsianRecovery.ts';

const match = (rest = {}) => ({
  id: '1550995', league: 'Liga MX', home: 'Atlante FC', away: 'U.N.A.M. - Pumas',
  kickoff: '2026-10-17T03:00:00Z', status: 'PRE',
  prematchGoalLine: 2.75, prematchCornerLine: 10,
  prematchGoalOverOdd: 1.9, prematchGoalUnderOdd: 1.9,
  prematchCornerOverOdd: 1.93, prematchCornerUnderOdd: 1.87,
  handicapVerified: false, handicap: 0, favourite: 'HOME', sourceSummary: 'API-Football · Bet365 goals/corners',
  ...rest,
});
const line = (rest = {}) => ({
  league: 'Liga MX', home: 'Atlante', away: 'Pumas UNAM',
  kickoff: '2026-10-17T03:00:00Z', homeLine: -0.75,
  source: '5DollarFootballAPI fixture summary FT Asian Handicap line only',
  ...rest,
});

test('matches provider aliases and kickoff, without changing qualified goals/corners', () => {
  assert.ok(sameAhFixture(match(), line()));
  const [result] = supplementFtAhLine([match()], [line()]);
  assert.equal(result.prematchHandicapLine, -0.75);
  assert.equal(result.handicapLineVerified, true);
  assert.equal(result.handicapVerified, false);
  assert.equal(result.handicapHomeOdd, undefined);
  assert.equal(result.prematchGoalOverOdd, 1.9);
  assert.equal(result.prematchCornerUnderOdd, 1.87);
  assert.match(result.sourceSummary, /line only/);
});

test('accepts zero Asian handicap while not inventing side prices', () => {
  const [result] = supplementFtAhLine([match()], [line({homeLine: 0})]);
  assert.equal(result.prematchHandicapLine, 0);
  assert.equal(result.handicapVerified, false);
  assert.equal(result.handicapLineVerified, true);
});

test('does not overwrite a priced verified FT handicap', () => {
  const old = match({handicapVerified: true, handicap: -0.5, handicapHomeOdd: 1.97, handicapAwayOdd: 1.87});
  assert.deepEqual(supplementFtAhLine([old], [line()])[0], old);
});

test('rejects ambiguous matching quotes, wrong dates and invalid quarter-line', () => {
  assert.equal(supplementFtAhLine([match()], [line(), line()])[0].handicapLineVerified, undefined);
  assert.equal(supplementFtAhLine([match()], [line({kickoff:'2026-10-18T03:00:00Z'})])[0].handicapLineVerified, undefined);
  assert.equal(supplementFtAhLine([match()], [line({homeLine: -0.33})])[0].handicapLineVerified, undefined);
});

test('does not supplement a live or half-time decision', () => {
  const existing = match({ status: 'HT', htVerified: true });
  assert.deepEqual(supplementFtAhLine([existing], [line()])[0], existing);
});
