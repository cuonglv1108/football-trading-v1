import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeOddsSnapshot, mergeWatchlistOdds, sameScheduledFixture } from '../lib/watchlistOdds.ts';

function match(id, extra = {}) {
  return {
    id, league: 'Liga MX', home: 'Atlante FC', away: 'U.N.A.M. - Pumas',
    kickoff: '2026-10-17T03:00:00Z', status: 'PRE', state: 'QUALIFIED',
    prematchGoalLine: 2.75, prematchCornerLine: 10,
    prematchGoalOverOdd: null, prematchGoalUnderOdd: null,
    prematchCornerOverOdd: null, prematchCornerUnderOdd: null,
    favourite: 'HOME', handicap: 0, handicapVerified: false,
    handicapHomeOdd: null, handicapAwayOdd: null, sourceSummary: 'old source',
    ...extra,
  };
}

test('legacy invalidations are removed idempotently without certifying an old handicap', () => {
  const warning = ' · HANDICAP INVALIDATED — SAFEv6 rescan required';
  const old = match('1550995', {
    sourceSummary: 'API-Football · Bet365 #8 · SAFEv8 AH unverified' + warning.repeat(19),
    handicapVerified: true,
  });
  const cleaned = sanitizeOddsSnapshot(old);
  assert.equal(cleaned.handicapVerified, false);
  assert.ok(!cleaned.sourceSummary.includes('HANDICAP INVALIDATED'));
  assert.deepEqual(sanitizeOddsSnapshot(cleaned), cleaned);
});

test('SAFEv9 handicap verified snapshot remains trusted', () => {
  const current = match('1', {
    sourceSummary: 'API-Football · Bet365 #8 · SAFEv9 AH verified',
    handicapVerified: true, handicap: -0.75,
  });
  assert.equal(sanitizeOddsSnapshot(current).handicapVerified, true);
});

test('a new snapshot replaces old prematch prices for the same saved fixture', () => {
  const saved = match('1550995', {
    sourceSummary: 'API-Football · SAFEv8 AH unverified',
  });
  const recent = match('new-5dollar-id', {
    home: 'Atlante', away: 'UNAM Pumas',
    prematchGoalOverOdd: 1.92, prematchGoalUnderOdd: 1.91,
    prematchCornerOverOdd: 1.84, prematchCornerUnderOdd: 2.02,
    handicap: -0.75, handicapVerified: true,
    handicapHomeOdd: 1.94, handicapAwayOdd: 1.96,
    sourceSummary: '5DollarFootballAPI · Bet365 FULL 2-way prices · AH verified',
  });
  assert.ok(sameScheduledFixture(saved, recent));
  const merged = mergeWatchlistOdds([saved], [recent]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, '1550995');
  assert.equal(merged[0].prematchGoalOverOdd, 1.92);
  assert.equal(merged[0].handicapVerified, true);
  assert.ok(merged[0].sourceSummary.includes('5DollarFootballAPI'));
});

test('verified HT decisions and history fields cannot be overwritten by a prematch refresh', () => {
  const verified = match('1550995', {
    status: 'HT', htVerified: true, htSourceType: 'API_FOOTBALL',
    htCornersHome: 3, htCornersAway: 3, handicap: -0.25, handicapVerified: true,
    sourceSummary: 'Verified earlier',
  });
  const next = match('5d', { handicap: -1.5, handicapVerified: true, sourceSummary: 'New odds' });
  const merged = mergeWatchlistOdds([verified], [next]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].htCornersHome, 3);
  assert.equal(merged[0].handicap, -0.25);
  assert.equal(merged[0].sourceSummary, 'Verified earlier');
});

test('distinct fixtures outside kickoff tolerance are not merged', () => {
  const old = match('1');
  const next = match('2', { kickoff: '2026-10-18T03:00:00Z' });
  assert.equal(mergeWatchlistOdds([old], [next]).length, 2);
});
