import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDedicatedBet365Ah } from '../lib/ftAsianRecovery.ts';
import { mergeWatchlistOdds } from '../lib/watchlistOdds.ts';

test('reads dedicated market=asian with current string without price fabrication', () => {
  const data = { fixture_id: 422841891, odds: {
    asian_handicap: { opening: '-0.5', current: '-0.75', inplay: '-1.0' },
  }};
  const q = parseDedicatedBet365Ah(data);
  assert.equal(q.homeLine, -0.75);
  assert.equal(q.homeOdd, null);
  assert.equal(q.awayOdd, null);
  assert.match(q.source, /line only/);
});

test('reads documented Bet365 bookmaker two-way AH and retains prices', () => {
  const data = { fixture_id: 422841891, bookmakers: [{
    slug: 'bet365', name: 'Bet 365', odds: {
      asian_handicap: {
        opening: { line: -0.25, home: 1.95, away: 1.85 },
        closing: { line: -0.5, home: 2.02, away: 1.78 },
      },
    },
  }]};
  const q = parseDedicatedBet365Ah(data);
  assert.deepEqual([q.homeLine, q.homeOdd, q.awayOdd], [-0.5, 2.02, 1.78]);
});

test('does not accept illegal line, no market or only live line', () => {
  assert.equal(parseDedicatedBet365Ah({odds:{asian_handicap:{closing:'-0.32'}}}),null);
  assert.equal(parseDedicatedBet365Ah({ odds: { } }),null);
  assert.equal(parseDedicatedBet365Ah({odds:{asian_handicap:{inplay:-1.5}}}),null);
});

test('does not infer any odds from incomplete Bet365 prices', () => {
  const quote = parseDedicatedBet365Ah({bookmakers:[{slug:'bet365',odds:{
    asian_handicap:{closing:{line:0,home:1.9,away:null}}
  }}]});
  assert.equal(quote.homeLine, 0);
  assert.equal(quote.homeOdd, null);
  assert.equal(quote.awayOdd, null);
});

test('dedicated AH saved on device remains after stale scan with missing AH', () => {
  const previous = {
    id:'1550995', league:'Liga MX', home:'Atlante FC', away:'U.N.A.M. - Pumas',
    kickoff:'2026-10-17T03:00:00Z', status:'PRE',
    prematchGoalLine:2.75,prematchCornerLine:10,
    prematchGoalOverOdd:1.9,prematchGoalUnderOdd:1.9,
    prematchCornerOverOdd:1.87,prematchCornerUnderOdd:1.97,
    favourite:'HOME',handicap:0,handicapVerified:false,
    prematchHandicapLine:-0.75,handicapLineVerified:true,
    handicapLineSource:'5DollarFootballAPI · Bet365 dedicated FT Asian Handicap (line only)',
    sourceSummary:'API-Football · FT AH: dedicated source',
  };
  const stale = {...previous,id:'other-provider-id',prematchHandicapLine:null,
    handicapLineVerified:false,handicapLineSource:null,sourceSummary:'API-Football · SAFEv10 AH unverified'};
  const [merged] = mergeWatchlistOdds([previous],[stale]);
  assert.equal(merged.handicapLineVerified,true);
  assert.equal(merged.prematchHandicapLine,-0.75);
  assert.equal(merged.prematchGoalOverOdd,1.9);
  assert.equal(merged.handicapVerified,false);
});
