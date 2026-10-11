import { NextResponse } from 'next/server';
import { getApiFootballMatches } from '../../../lib/apiFootball';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const startedAt = Date.now();

  if (!process.env.API_FOOTBALL_KEY) {
    return NextResponse.json({
      providerStatus: 'API_FOOTBALL_KEY_MISSING',
      dataSource: 'API-Football',
      mode: 'STRUCTURED_PROVIDER',
      matches: [],
      scanStatus: 'BLOCKED',
      fixturesFound: 0,
      fixturesVerified: 0,
      updatedAt: new Date().toISOString(),
      message: 'API-Football key is not configured. No GPT fallback was started.',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  try {
    const all = await getApiFootballMatches();
    const qualified = all.filter(m => m.state === 'QUALIFIED');

    return NextResponse.json({
      providerStatus: 'CONNECTED',
      dataSource: 'API-Football',
      mode: 'STRUCTURED_PROVIDER',
      matches: qualified,
      scanStatus: 'COMPLETE',
      fixturesFound: all.length,
      fixturesVerified: all.length,
      qualifiedMatches: qualified.length,
      webCallsThisScan: 0,
      estimatedCostUsd: 0,
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      message: 'Structured fixture/odds scan completed with no GPT web search.',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({
      providerStatus: 'ERROR',
      dataSource: 'API-Football',
      mode: 'STRUCTURED_PROVIDER',
      matches: [],
      scanStatus: 'ERROR',
      fixturesFound: 0,
      fixturesVerified: 0,
      webCallsThisScan: 0,
      estimatedCostUsd: 0,
      updatedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : 'API-Football scan failed',
    }, { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }
}
