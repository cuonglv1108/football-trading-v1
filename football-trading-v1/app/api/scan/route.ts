import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { getFiveDollarScan } from '../../../lib/fiveDollarFootball';
import { getApiFootballScan } from '../../../lib/apiFootball';
import { evaluateV1 } from '../../../lib/rules';
import { supplementFtAhLine } from '../../../lib/ftAsianRecovery';
import type { TradingMatch } from '../../../lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_FILE = process.env.V1_PROVIDER_SCAN_FILE || '/data/v1-provider-scan-24h-v2.json';
const CACHE_MS = Number(process.env.V1_PROVIDER_SCAN_CACHE_MS || 30 * 60 * 1000);

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
  handicapVerifiedCount?: number;
  handicapMissingCount?: number;
  handicapLineOnlyCount?: number;
  webCallsThisScan: number;
  estimatedCostUsd: number;
  updatedAt: string;
  elapsedMs?: number;
  message?: string;
  cacheStatus?: 'HIT' | 'MISS' | 'STALE';
  nextRefreshAt?: string;
};

// Fixture IDs differ between providers. Match only strongly identified, nearby kickoff fixtures.
function matchKey(m: TradingMatch) {
  const norm = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|club|football)\b/g, '').replace(/[^a-z0-9]/g, '');
  return `${m.league}:${norm(m.home)}:${norm(m.away)}`;
}
function sameFixture(a: TradingMatch, b: TradingMatch) {
  const at = Date.parse(a.kickoff ?? '');
  const bt = Date.parse(b.kickoff ?? '');
  return matchKey(a) === matchKey(b) && Number.isFinite(at) && Number.isFinite(bt) &&
    Math.abs(at - bt) <= 10 * 60 * 1000;
}
function usableHandicap(m: TradingMatch) {
  return m.handicapVerified === true && Number.isFinite(m.handicap) &&
    m.handicap < 0 && m.handicapHomeOdd != null && m.handicapAwayOdd != null &&
    Number.isFinite(m.handicapHomeOdd) && Number.isFinite(m.handicapAwayOdd);
}
function mergeMarketCoverage(primary: TradingMatch[], secondary: TradingMatch[]) {
  const used = new Set<number>();
  const matches = primary.map(original => {
    const i = secondary.findIndex((candidate, index) => !used.has(index) && sameFixture(original, candidate));
    if (i < 0) return original;
    used.add(i);
    const backup = secondary[i];
    if (usableHandicap(original) || !usableHandicap(backup)) return original;
    // Preserve all original Bet365 goal/corner prices; borrow only validated FT AH.
    const patched: TradingMatch = {
      ...original,
      favourite: backup.favourite,
      handicap: backup.handicap,
      handicapVerified: true,
      handicapHomeOdd: backup.handicapHomeOdd,
      handicapAwayOdd: backup.handicapAwayOdd,
      sourceSummary: `${original.sourceSummary ?? '5Dollar'} · FT AH: ${backup.sourceSummary ?? 'API-Football'} (supplement)`,
    };
    return { ...patched, ...evaluateV1(patched) };
  });
  for (let i = 0; i < secondary.length; i++) {
    if (!used.has(i) && !primary.some(m => sameFixture(m, secondary[i]))) matches.push(secondary[i]);
  }
  return matches;
}

// Provider scan files survive deployments. Older versions reported COMPLETE even
// when lines existed but FT two-way prices or Asian handicap did not.
function auditCachedPayload(payload: Payload): Payload {
  const rows = (Array.isArray(payload.matches) ? payload.matches : []) as TradingMatch[];
  const price = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 1;
  const priced = rows.filter(m =>
    price(m.prematchGoalOverOdd) && price(m.prematchGoalUnderOdd) &&
    price(m.prematchCornerOverOdd) && price(m.prematchCornerUnderOdd)
  ).length;
  const verifiedAh = rows.filter(m => m.handicapVerified === true &&
    !/SAFEv[0-8]\b/.test(m.sourceSummary ?? '')).length;
  const lineOnly = rows.filter(m => m.handicapVerified !== true && m.handicapLineVerified === true).length;
  const complete = rows.length > 0 && priced === rows.length && verifiedAh === rows.length;
  return {
    ...payload,
    scanStatus: payload.scanStatus === 'COMPLETE' && !complete ? 'PARTIAL' : payload.scanStatus,
    handicapVerifiedCount: verifiedAh,
    handicapMissingCount: rows.length - verifiedAh - lineOnly,
    handicapLineOnlyCount: lineOnly,
    marketCoverage: `Qualified two-way FT goals+corners ${priced}/${rows.length}; FT AH priced ${verifiedAh}/${rows.length}; line-only ${lineOnly}. Entire fixture coverage cannot be proven from this cache.`,
  };
}
async function readCache(): Promise<{ payload: Payload; expiresAt: number } | null> {
  try {
    const raw = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    return raw?.payload && Number.isFinite(Number(raw?.expiresAt))
      ? { ...raw, payload: auditCachedPayload(raw.payload as Payload) } : null;
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
      message: 'No provider scan cached yet. Tap Scan 24h when you want new data.',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const startedAt = Date.now();

  if (!process.env.FIVE_DOLLAR_FOOTBALL_API_KEY && !process.env.API_FOOTBALL_KEY) {
    return NextResponse.json({
      providerStatus: 'PROVIDER_KEYS_MISSING',
      dataSource: '5DollarFootballAPI + API-Football',
      mode: 'STRUCTURED_PROVIDER',
      matches: [],
      scanStatus: 'BLOCKED',
      fixturesFound: 0,
      fixturesVerified: 0,
      webCallsThisScan: 0,
      estimatedCostUsd: 0,
      updatedAt: new Date().toISOString(),
      cacheStatus: cached ? 'STALE' : 'MISS',
      message: 'Both provider keys are missing.',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  try {
    // Independent providers: a partial success must not prevent the other from filling gaps.
    const [five, football] = await Promise.allSettled([
      process.env.FIVE_DOLLAR_FOOTBALL_API_KEY ? getFiveDollarScan() : Promise.reject(new Error('5Dollar key missing')),
      process.env.API_FOOTBALL_KEY ? getApiFootballScan() : Promise.reject(new Error('API-Football key missing')),
    ]);
    if (five.status === 'rejected' && football.status === 'rejected') {
      throw new Error(`Both scans failed: 5Dollar (${String(five.reason)}); API-Football (${String(football.reason)})`);
    }
    const first = five.status === 'fulfilled' ? five.value : null;
    const second = football.status === 'fulfilled' ? football.value : null;
    const combined = supplementFtAhLine(
      mergeMarketCoverage(first?.matches ?? [], second?.matches ?? []),
      first?.handicapLines ?? []
    );
    const qualified = combined.filter(m => m.state === 'QUALIFIED');
    const handicapVerifiedCount = qualified.filter(m => m.handicapVerified === true).length;
    const handicapLineOnlyCount = qualified.filter(m => m.handicapVerified !== true && m.handicapLineVerified === true).length;
    const handicapMissingCount = qualified.length - handicapVerifiedCount - handicapLineOnlyCount;
    const dataSource = [first && '5DollarFootballAPI', second && 'API-Football'].filter(Boolean).join(' + ');
    const providerNote = [
      first ? '5Dollar OK' : `5Dollar unavailable: ${String(five.status === 'rejected' ? five.reason : '')}`,
      second ? 'API-Football OK' : `API-Football unavailable: ${String(football.status === 'rejected' ? football.reason : '')}`,
    ].join('; ');
    // Audit numbers are provider-specific; never pretend counts are unique across provider IDs.
    const fixturesFound = Math.max(first?.fixturesFound ?? 0, second?.fixturesFound ?? 0);
    const fixturesVerified = combined.length;
    const missingMarketCount = Math.max(0, fixturesFound - fixturesVerified);
    const expiresAt = Date.now() + CACHE_MS;

    const payload: Payload = {
      providerStatus: 'CONNECTED',
      dataSource,
      mode: 'STRUCTURED_PROVIDER',
      matches: qualified,
      scanStatus: missingMarketCount > 0 || handicapMissingCount > 0 || handicapLineOnlyCount > 0 || !first || !second ? 'PARTIAL' : 'COMPLETE',
      fixturesFound,
      fixturesVerified,
      qualifiedMatches: qualified.length,
      missingMarketCount,
      handicapVerifiedCount,
      handicapMissingCount,
      handicapLineOnlyCount,
      marketCoverage: `Provider scans: 5Dollar ${first?.fixturesWithCompleteMarkets ?? 'unavailable'}/${first?.fixturesFound ?? 'unavailable'}; API-Football ${second?.fixturesWithCompleteMarkets ?? 'unavailable'}/${second?.fixturesFound ?? 'unavailable'}. Cross-provider counts are not unique.`,
      webCallsThisScan: 0,
      estimatedCostUsd: 0,
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      message: `${providerNote}; FT AH priced ${handicapVerifiedCount}/${qualified.length}, line-only ${handicapLineOnlyCount}, missing ${handicapMissingCount}.`,
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
