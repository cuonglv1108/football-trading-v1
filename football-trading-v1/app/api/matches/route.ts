import { NextResponse } from 'next/server';
import { evaluateV1 } from '../../../lib/rules';
import { getApiFootballMatches } from '../../../lib/apiFootball';
import { TradingMatch } from '../../../lib/types';

export const dynamic = 'force-dynamic';

function buildDemoMatches(): TradingMatch[] {
  const tick = Math.floor(Date.now() / 1000);
  const phase = tick % 120;

  const matches: TradingMatch[] = [
    {
      id: 'demo-mls-001',
      league: 'MLS',
      home: 'DEMO Home',
      away: 'DEMO Away',
      minute: phase < 45 ? Math.max(1, phase) : null,
      status: phase < 45 ? 'LIVE' : 'HT',
      kickoff: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scoreHome: 0,
      scoreAway: 0,
      cornersHome: phase < 20 ? 1 : 2,
      cornersAway: phase < 35 ? 1 : 2,
      prematchCornerLine: 10.5,
      prematchGoalLine: 3.0,
      favourite: 'HOME',
      handicap: -0.75,
      favouriteCoveringHandicap: false,
      favouriteLosing: false,
      ftGoalOverClear: false,
    },
  ];

  return matches.map((m) => ({ ...m, ...evaluateV1(m) }));
}

export async function GET() {
  const demoEnabled = process.env.ENABLE_DEMO_DATA === 'true';
  const apiKeyConfigured = Boolean(process.env.API_FOOTBALL_KEY);

  if (demoEnabled) {
    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      mode: 'DEMO',
      dataSource: 'Synthetic test feed',
      matches: buildDemoMatches(),
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  if (!apiKeyConfigured) {
    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      mode: 'NO_LIVE_PROVIDER',
      dataSource: null,
      matches: [],
      providerStatus: 'API_FOOTBALL_KEY_MISSING',
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  try {
    const matches = await getApiFootballMatches();

    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      mode: 'LIVE',
      dataSource: 'API-Football + Bet365 odds feed',
      matches,
      providerStatus: 'CONNECTED',
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    console.error('API-Football provider error', error);

    return NextResponse.json({
      updatedAt: new Date().toISOString(),
      mode: 'NO_LIVE_PROVIDER',
      dataSource: 'API-Football',
      matches: [],
      providerStatus: 'ERROR',
      providerError: error instanceof Error ? error.message : 'Unknown provider error',
    }, {
      status: 200,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
}
