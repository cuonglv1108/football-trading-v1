import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import type { FtAhLookupTarget } from '../../../lib/fiveDollarFootball';
import { getApiFootballDedicatedFtAh } from '../../../lib/apiFootballAhRecovery';
import { isFtAhPriorityLeague, sortFtAhPriority } from '../../../lib/ftAhPriority';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LIMIT_FILE = process.env.V1_AH_LOOKUP_BUDGET_FILE || '/data/v1-ft-ah-lookup-budget.json';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CALLS_PER_DAY = 32;
const COOLDOWN_MS = 60_000;
let running = false;

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
function inputMatch(value: unknown): FtAhLookupTarget | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const league = String(v.league ?? '');
  const kickoff = String(v.kickoff ?? '');
  const millis = Date.parse(kickoff);
  if (!isFtAhPriorityLeague(league) ||
      typeof v.id !== 'string' || v.id.length > 100 || !v.id ||
      typeof v.home !== 'string' || v.home.length > 100 || !v.home ||
      typeof v.away !== 'string' || v.away.length > 100 || !v.away ||
      v.status !== 'PRE' ||
      !Number.isFinite(millis) || millis <= Date.now() ||
      millis > Date.now() + WINDOW_MS) return null;
  return {
    id: v.id,
    home: v.home,
    away: v.away,
    league: league as FtAhLookupTarget['league'],
    kickoff,
    status: 'PRE',
  };
}
type LimitState = { attempts: number[]; lastAt: number };
async function readLimits(): Promise<LimitState> {
  try {
    const state = JSON.parse(await fs.readFile(LIMIT_FILE, 'utf8')) as LimitState;
    return {
      attempts: (Array.isArray(state.attempts) ? state.attempts : [])
        .filter(n => Number.isFinite(n) && n > Date.now() - WINDOW_MS),
      lastAt: Number(state.lastAt) || 0,
    };
  } catch { return { attempts: [], lastAt: 0 }; }
}
async function saveLimits(state: LimitState) {
  await fs.mkdir(path.dirname(LIMIT_FILE), { recursive: true });
  const tmp = LIMIT_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
  await fs.rename(tmp, LIMIT_FILE);
}

export async function POST(request: Request) {
  if (!process.env.API_FOOTBALL_KEY) {
    return reply({ error: 'API_FOOTBALL_KEY is not configured; no AH request made' }, 503);
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return reply({ error: 'Invalid request JSON' }, 400); }
  const raw = (body as { matches?: unknown })?.matches;
  const sourceRows = Array.isArray(raw) ? raw.slice(0, 30) : [];
  const matches = sourceRows.map(inputMatch).filter((m): m is FtAhLookupTarget => m != null);
  const unique = sortFtAhPriority([...new Map(matches.map(m => [m.id, m])).values()]).slice(0, 4);
  if (!unique.length) {
    return reply({ message: 'No upcoming Brazil Serie A, Allsvenskan, Liga MX or MLS matches eligible for AH recovery.',
      attempted: 0, lookups: [], fixturePages: 0, marketRequests: 0 });
  }
  if (running) return reply({ error: 'A FT AH-only lookup is already running. No new requests started.' }, 429);
  running = true;
  try {
    const limits = await readLimits();
    const now = Date.now();
    if (now - limits.lastAt < COOLDOWN_MS) {
      return reply({ error: 'FT AH-only lookup is cooling down (1 minute). No API requests made.',
        retryAfterSeconds: Math.ceil((COOLDOWN_MS - (now - limits.lastAt)) / 1000) }, 429);
    }
    // Conservatively reserve up to four API-Football calls per selected match:
    // fixture verification, fixture search if needed, and at most 2 odds pages.
    if (limits.attempts.length + unique.length * 4 > MAX_CALLS_PER_DAY) {
      return reply({ error: 'FT AH-only daily provider request cap reached. No API requests made.' }, 429);
    }
    limits.lastAt = now;
    limits.attempts.push(...Array(unique.length * 4).fill(now));
    await saveLimits(limits);
    const result = await getApiFootballDedicatedFtAh(unique);
    const priced = result.lookups.filter(r => r.status === 'FOUND_PRICED').length;
    const lineOnly = result.lookups.filter(r => r.status === 'FOUND_LINE').length;
    return reply({
      status: 'DONE',
      attempted: unique.length,
      ...result,
      priced,
      lineOnly,
      message: 'FT AH-only check: ' + priced + ' two-way priced, ' + lineOnly +
        ' line-only, ' + (unique.length - priced - lineOnly) +
        ' missing/unsupported. API-Football used for Brazil Serie A, Allsvenskan, Liga MX, MLS. Existing Goal/Corner odds unchanged.',
    });
  } catch (error) {
    return reply({
      status: 'ERROR',
      attempted: unique.length,
      lookups: [],
      error: error instanceof Error ? error.message : 'FT AH provider lookup failed',
      message: 'Provider AH lookup failed; existing Goal/Corner odds were not altered.',
    }, 502);
  } finally {
    running = false;
  }
}
