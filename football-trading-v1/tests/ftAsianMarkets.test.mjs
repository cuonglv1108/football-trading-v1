import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApiFootballBet365FtAh } from '../lib/ftAsianMarkets.ts';

function market(values, name = 'Asian Handicap') {
  return {name,values};
}
function snapshot(bets) {
  return [{update:'2026-11-02T23:45:00Z',
    bookmakers:[{name:'Bet365',bets}]}];
}

test('pairs identical home-reference labels from API-Football pre-match correctly', () => {
  const result = parseApiFootballBet365FtAh(snapshot([
    market([
      {value:'Home -1.25',odd:'1.60'},
      {value:'Away -1.25',odd:'2.30'},
      {value:'Home -1',odd:'1.42'},
      {value:'Away -1',odd:'2.75'},
    ]),
  ]));
  assert.equal(result.marketFound,true);
  assert.equal(result.totalLines,2);
  assert.equal(result.convention,'SHARED_HOME_LINE');
  assert.deepEqual(result.candidates.find(q=>q.line===-1.25),
    {line:-1.25,homeOdd:1.6,awayOdd:2.3});
});

test('ignores 1H and corners AH and parses split quarter spread -1.75', () => {
  const result = parseApiFootballBet365FtAh(snapshot([
    market([{value:'Home -0.25',odd:'1.90'},{value:'Away -0.25',odd:'1.90'}],'Asian Handicap First Half'),
    market([{value:'Home -4',odd:'1.90'},{value:'Away -4',odd:'1.90'}],'Corners Asian Handicap'),
    market([{value:'Home -1.5,-2.0',odd:'1.975'},{value:'Away -1.5,-2.0',odd:'1.825'}]),
  ]));
  assert.equal(result.totalLines,1);
  assert.deepEqual(result.candidates,[{line:-1.75,homeOdd:1.975,awayOdd:1.825}]);
});

test('supports opposite signed team-referenced handicaps when present', () => {
  const result = parseApiFootballBet365FtAh(snapshot([
    market([{value:'Home -0.75',odd:'1.95'},{value:'Away +0.75',odd:'1.89'}]),
  ]));
  assert.equal(result.convention,'SIGNED_SIDES');
  assert.deepEqual(result.candidates,[{line:-0.75,homeOdd:1.95,awayOdd:1.89}]);
});

test('shows multiple full-time lines without silently selecting a main spread', () => {
  const result = parseApiFootballBet365FtAh(snapshot([
    market([
      {value:'Home -1.25',odd:'1.60'},{value:'Away -1.25',odd:'2.30'},
      {value:'Home -1.75',odd:'1.975'},{value:'Away -1.75',odd:'1.825'},
      {value:'Home -2',odd:'2.30'},{value:'Away -2',odd:'1.60'},
    ]),
  ]));
  assert.equal(result.totalLines,3);
  assert.deepEqual(result.candidates[0],{line:-1.75,homeOdd:1.975,awayOdd:1.825});
  // This array is only ordered for review; no "main" selection exists.
});

test('returns no FT market when only first-half and corners markets exist', () => {
  const result = parseApiFootballBet365FtAh(snapshot([
    market([{value:'Home 0',odd:'1.9'},{value:'Away 0',odd:'1.9'}],'Asian Handicap First Half'),
    market([{value:'Home -4',odd:'1.9'},{value:'Away -4',odd:'1.9'}],'Corners Asian Handicap'),
  ]));
  assert.equal(result.marketFound,false);
  assert.deepEqual(result.candidates,[]);
});
