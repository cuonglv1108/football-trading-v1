import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { getFiveDollarScan } from '../../../lib/fiveDollarFootball';
import { getApiFootballScan } from '../../../lib/apiFootball';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_FILE = process.env.V1_PROVIDER_SCAN_FILE || '/data/v1-provider-scan-5d-v1.json';
const CACHE_MS = Number(process.env.V1_PROVIDER_SCAN_CACHE_MS || 2 * 60 * 60 * 1000);

type Payload = {
  providerStatus: string;
  dataSource: string;
  mode: string;
  matches: unknown[];
  scanStatus: string;
  fixturesFound: number;
  fixturesVerified: number;
  qualifiedMatches?: number;
  missingMarketCount?: number;
  marketCoverage?: string;
  webCallsThisScan: number;
  estimatedCostUsd: number;
  updatedAt: string;
  elapsedMs?: number;
  message?: string;
  cacheStatus?: 'HIT' | 'MISS' | 'STALE';
  nextRefreshAt?: string;
};

async function readCache(): Promise<{ payload: Payload; expiresAt: number } | null> {
  try {
    const raw = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    return raw?.payload && Number.isFinite(Number(raw?.expiresAt)) ? raw : null;
  } catch {
    return null;
  }
}

async function writeCache(payload: Payload, expiresAt: number) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = CACHE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ payload, expiresAt }), 'utf8');
  await fs.rename(tmp, CACHE_FILE);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const refresh = url.searchParams.get('refresh') === '1';
  const cached = await readCache();

  if (!refresh) {
    if (cached) {
      return NextResponse.json({
        ...cached.payload,
        cacheStatus: cached.expiresAt > Date.now() ? 'HIT' : 'STALE',
        nextRefreshAt: new Date(cached.expiresAt).toISOString(),
      }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }
    return NextResponse.json({
      providerStatus: 'CACHE_EMPTY',
      dataSource: '5DollarFootballAPI',
      mode: 'STRUCTURED_PROVIDER',
      matches: [],
      scanStatus: 'EMPTY',
      fixturesFound: 0,
      fixturesVerified: 0,
      webCallsThisScan: 0,
      estimatedCostUsd: 0,
      updatedAt: '',
      cacheStatus: 'HIT',
      message: 'No provider scan cached yet. Tap Scan 72h when you want new data.',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const startedAt = Date.now();

  if (!process.env.FIVE_DOLLAR_FOOTBALL_API_KEY) {
    return NextResponse.json({
      ...(cached?.payload ?? {
        dataSource: '5DollarFootballAPI',
        mode: 'STRUCTURED_PROVIDER',
        matches: [],
        fixturesFound: 0,
        fixturesVerified: 0,
        webCallsThisScan: 0,
        estimatedCostUsd: 0,
        updatedAt: new Date().toISOString(),
      }),
      providerStatus: 'FIVE_DOLLAR_KEY_MISSING',
      scanStatus: 'BLOCKED',
      cacheStatus: cached ? 'STALE' : 'HIT',
      message: '5DollarFootballAPI key is not configured. API-Football remains reserved for HT/FT verification.',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  try {
    let scanResult;
    let dataSource = '5DollarFootballAPI · Bet365';
    let providerNote = '';

    try {
      scanResult = await getFiveDollarScan();
    } catch (fiveDollarError) {
      if (!process.env.API_FOOTBALL_KEY) throw fiveDollarError;

      scanResult = await getApiFootballScan();
      dataSource = 'API-Football fallback';
      providerNote = fiveDollarError instanceof Error
        ? `5Dollar unavailable (${fiveDollarError.message}); using API-Football fallback.`
        : '5Dollar unavailable; using API-Football fallback.';
    }

    const all = scanResult.matches;
    const qualified = all.filter(m => m.state === 'QUALIFIED');
    const expiresAt = Date.now() + CACHE_MS;

    const payload: Payload = {
      providerStatus: 'CONNECTED',
      dataSource,
      mode: 'STRUCTURED_PROVIDER',
      matches: qualified,
      scanStatus: scanResult.missingMarketCount > 0 ? 'PARTIAL' : 'COMPLETE',
      fixturesFound: scanResult.fixturesFound,
      fixturesVerified: scanResult.fixturesWithCompleteMarkets,
      qualifiedMatches: qualified.length,
      missingMarketCount: scanResult.missingMarketCount,
      marketCoverage: `${scanResult.fixturesWithCompleteMarkets}/${scanResult.fixturesFound} fixtures have complete goal+corner markets`,
      webCallsThisScan: 0,
      estimatedCostUsd: 0,
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      message: providerNote || (
        scanResult.missingMarketCount > 0
          ? `5Dollar scan completed; ${scanResult.missingMarketCount} fixture(s) lack a complete Bet365 goal+corner market.`
          : '5Dollar Bet365 fixture/odds scan completed with no GPT web search.'
      ),
      cacheStatus: 'MISS',
      nextRefreshAt: new Date(expiresAt).toISOString(),
    };

    await writeCache(payload, expiresAt);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({
      ...(cached?.payload ?? {
        dataSource: '5DollarFootballAPI',
        mode: 'STRUCTURED_PROVIDER',
        matches: [],
        fixturesFound: 0,
        fixturesVerified: 0,
        webCallsThisScan: 0,
        estimatedCostUsd: 0,
        updatedAt: new Date().toISOString(),
      }),
      providerStatus: 'ERROR',
      scanStatus: 'ERROR',
      cacheStatus: cached ? 'STALE' : 'HIT',
      message: error instanceof Error ? error.message : 'Pre-match provider scan failed',
    }, { status: 200, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }
}
