import test from 'node:test';
import assert from 'node:assert/strict';
import { FT_AH_PRIORITY_LEAGUES, isFtAhPriorityLeague, sortFtAhPriority } from '../lib/ftAhPriority.ts';

test('only the requested four leagues receive targeted FT AH lookups', () => {
  assert.deepEqual(FT_AH_PRIORITY_LEAGUES, [
    'Brazil Serie A','Allsvenskan','Liga MX','MLS',
  ]);
  for (const name of FT_AH_PRIORITY_LEAGUES) assert.equal(isFtAhPriorityLeague(name),true);
  for (const name of ['Eredivisie','Danish Superliga','Swiss Super League','Eliteserien']) {
    assert.equal(isFtAhPriorityLeague(name),false);
  }
});

test('rank follows Brazil, Sweden, Mexico, MLS regardless of incoming order', () => {
  const rows = [
    { league:'MLS', kickoff:'2026-10-17T01:00:00Z' },
    { league:'Liga MX', kickoff:'2026-10-17T02:00:00Z' },
    { league:'Brazil Serie A', kickoff:'2026-10-17T03:00:00Z' },
    { league:'Allsvenskan', kickoff:'2026-10-17T04:00:00Z' },
  ];
  assert.deepEqual(sortFtAhPriority(rows).map(x=>x.league),[
    'Brazil Serie A','Allsvenskan','Liga MX','MLS',
  ]);
  assert.equal(rows[0].league,'MLS','sort must not mutate input');
});

test('earlier kickoff wins within the same priority league', () => {
  const rows = sortFtAhPriority([
    { league:'Liga MX', kickoff:'2026-10-17T23:00:00Z',id:'late' },
    { league:'Liga MX', kickoff:'2026-10-17T18:00:00Z',id:'early' },
  ]);
  assert.deepEqual(rows.map(x=>x.id),['early','late']);
});
