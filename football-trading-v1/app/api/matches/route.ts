import { NextResponse } from 'next/server';
import { evaluateV1 } from '../../../lib/rules';
import { TradingMatch } from '../../../lib/types';

export const dynamic = 'force-dynamic';

function buildDemoMatches(): TradingMatch[] {
  const tick = Math.floor(Date.now() / 1000);
  const phase = tick % 120;

  const matches: TradingMatch[] = [
    {
      id: 'demo-mls-001', league: 'MLS', home: 'DEMO Home', away: 'DEMO Away',
      minute: phase < 45 ? Math.max(1, phase) : null,
      status: phase < 45 ? 'LIVE' : 'HT',
      scoreHome: 0, scoreAway: 0,
      cornersHome: phase < 20 ? 1 : 2,
      cornersAway: phase < 35 ? 1 : 2,
      prematchCornerLine: 10.5, prematchGoalLine: 3.0,
      favourite: 'HOME', handicap: -0.75,
      favouriteCoveringHandicap: false, favouriteLosing: false, ftGoalOverClear: false,
    },
  ];

  return matches.map((m) => ({ ...m, ...evaluateV1(m) }));
}

export async function GET() {
  // Safety first: never show fabricated fixtures as live data by default.
  // Demo mode must be explicitly enabled in the environment.
  const demoEnabled = process.env.ENABLE_DEMO_DATA === 'true';

  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    mode: demoEnabled ? 'DEMO' : 'NO_LIVE_PROVIDER',
    dataSource: demoEnabled ? 'Synthetic test feed' : null,
    matches: demoEnabled ? buildDemoMatches() : [],
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
