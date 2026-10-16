'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import MatchCard from '../components/MatchCard';
import { evaluateV1 } from '../lib/rules';
import { League, MethodOverallStats, MethodStats, TradingMatch } from '../lib/types';
import { mergeWatchlistOdds, sanitizeOddsSnapshot } from '../lib/watchlistOdds';
import { buildH2Predictions, methodMatchStatus } from '../lib/outcomes';
import { deriveH2Execution } from '../lib/h2Execution';

const leagues: Array<'ALL' | League> = ['ALL', 'Eredivisie', 'Allsvenskan', 'Brazil Serie A', 'Liga MX', 'Swiss Super League', 'Danish Superliga', 'Eliteserien', 'MLS'];
type View = 'STARRED' | 'HISTORY';
type HistoryGroup = 'WIN' | 'LOSE' | 'DRAW' | 'NE';

const STAR_KEY = 'football-trading-v1-starred';
const HISTORY_KEY = 'football-trading-v1-history';

function localDayKey(value: string | number | Date) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayRail(now: number) {
  const base = new Date(now);
  base.setHours(12, 0, 0, 0);
  return Array.from({ length: 2 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return {
      key: localDayKey(d),
      dow: i === 0 ? 'TODAY' : d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
      date: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }).toUpperCase(),
    };
  });
}

function isTrustedLegacyFt(row: TradingMatch) {
  if (row.status !== 'FT' && row.researchPhase !== 'FT') return true;
  if (row.ftVerified === true) return true;
  const sh = row.ftScoreHome ?? row.scoreHome;
  const sa = row.ftScoreAway ?? row.scoreAway;
  const ch = row.ftCornersHome ?? row.cornersHome;
  const ca = row.ftCornersAway ?? row.cornersAway;
  // Old bug converted null -> 0. Do not keep legacy all-zero "FT" snapshots as real results.
  return !(sh === 0 && sa === 0 && ch === 0 && ca === 0);
}

function readSaved(key: string): TradingMatch[] {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || '[]') as TradingMatch[];
    return Array.isArray(rows)
      ? key === STAR_KEY
          ? mergeWatchlistOdds(rows.filter(isTrustedLegacyFt).map(sanitizeOddsSnapshot), [])
          : rows.filter(isTrustedLegacyFt).map(sanitizeOddsSnapshot)
      : [];
  } catch {
    return [];
  }
}

// Past the maximum normal match window, remove from the active list WITHOUT claiming FT.
const ARCHIVE_AFTER_MS = 180 * 60000;
function isWatchExpired(match: TradingMatch, now: number = Date.now()) {
  const kickoff = new Date(match.kickoff || '').getTime();
  return match.status !== 'FT' && Number.isFinite(kickoff) &&
    now - kickoff >= ARCHIVE_AFTER_MS;
}

function richerLifecycleMatch(a: TradingMatch | undefined, b: TradingMatch) {
  if (!a) return b;
  const score = (m: TradingMatch) =>
    (m.ftVerified === true ? 1000 : 0) +
    (m.htVerified === true ? 500 : 0) +
    (m.htAction && m.htAction !== 'NEED_INPUT' ? 100 : 0) +
    (m.htCornersHome != null && m.htCornersAway != null ? 50 : 0) +
    ((m.h2Predictions?.length ?? 0) > 0 ? 20 : 0) +
    (m.liveCornerLine != null || m.liveGoalLine != null ? 10 : 0);
  return score(b) > score(a) ? b : a;
}

function formatCountdown(minutes: number) {
  const total = Math.max(1, Math.ceil(minutes));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function nextCheckpoint(match: TradingMatch) {
  if (!match.kickoff) return 'HT timing unavailable';
  const kickoff = new Date(match.kickoff).getTime();
  const now = Date.now();
  const min = (now - kickoff) / 60000;

  if (min < 43) return `HT check in ${formatCountdown(43 - min)}`;
  if (min <= 85 && match.htVerified !== true) return 'HT CHECK NOW';
  if (min < 105) return match.htVerified ? 'H2 monitoring' : 'HT retry window';
  if (match.ftVerified !== true) return 'FT CHECK DUE';
  return 'Completed';
}

export default function Home() {
  const [matches, setMatches] = useState<TradingMatch[]>([]);
  const [starred, setStarred] = useState<TradingMatch[]>([]);
  const [history, setHistory] = useState<TradingMatch[]>([]);
  const [league, setLeague] = useState<'ALL' | League>('ALL');
  const [view, setView] = useState<View>('STARRED');
  const [checkpoint, setCheckpoint] = useState<TradingMatch | null>(null);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [providerStatus, setProviderStatus] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [nextRefreshAt, setNextRefreshAt] = useState('');
  const [scanStatus, setScanStatus] = useState('');
  const [scanCoverage, setScanCoverage] = useState('');
  const [budgetStatus, setBudgetStatus] = useState('');
  const [htLoadingId, setHtLoadingId] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState<'HT' | 'FT' | null>(null);
  const [methodStats, setMethodStats] = useState<MethodStats[]>([]);
  const [methodOverall, setMethodOverall] = useState<MethodOverallStats | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [selectedDay, setSelectedDay] = useState('ALL');
  const [historyGroup, setHistoryGroup] = useState<HistoryGroup | null>(null);

  useEffect(() => {
    const savedWatchlist = readSaved(STAR_KEY).filter(m => m.status !== 'FT');
    setStarred(savedWatchlist);
    localStorage.setItem(STAR_KEY, JSON.stringify(savedWatchlist));
    setHistory(readSaved(HISTORY_KEY));
    loadCachedScan();
    loadSharedResearch();
  }, []);

  // Timed cleanup is entirely local: no GPT call, no football API request.
  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 60000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const expired = starred.filter(m => isWatchExpired(m, clock));
    if (!expired.length) return;

    const active = starred.filter(m => !isWatchExpired(m, clock));
    setStarred(active);
    localStorage.setItem(STAR_KEY, JSON.stringify(active));

    setHistory(prev => {
      const archived: TradingMatch[] = expired.map(m => ({
        ...m,
        watchStatus: 'EXPIRED_UNVERIFIED',
        researchPhase: 'MANUAL',
        checkedAt: new Date().toISOString(),
      }));
      const merged = new Map<string, TradingMatch>();
      for (const row of [...archived, ...prev]) {
        const key = `${row.id}|${row.researchPhase ?? row.status}`;
        if (!merged.has(key)) merged.set(key, row);
      }
      const next = Array.from(merged.values()).slice(0, 500);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [starred, clock]);

  async function loadSharedResearch() {
    try {
      const res = await fetch('/api/research', { cache: 'no-store' });
      const data = await res.json();
      const shared = (data.rows ?? []) as TradingMatch[];
      setMethodStats((data.methodStats ?? []) as MethodStats[]);
      setMethodOverall((data.methodOverall ?? null) as MethodOverallStats | null);
      if (!shared.length) return;
      setHistory(prev => {
        const merged = new Map<string, TradingMatch>();
        for (const m of shared) merged.set(`${m.id}-${m.researchPhase ?? m.status}`, m);
        for (const m of prev) {
          const key = `${m.id}-${m.researchPhase ?? m.status}`;
          if (!merged.has(key)) merged.set(key, m);
        }
        const next = Array.from(merged.values()).slice(0, 500);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        return next;
      });
    } catch {
      // Local history remains available if shared history cannot load.
    }
  }

  async function persistResearch(snapshot: TradingMatch) {
    try {
      await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
    } catch {
      // History still remains locally available.
    }
  }


  async function deleteHistoryMatch(match: TradingMatch) {
    const confirmed = window.confirm(`Delete ${match.home} vs ${match.away} from History and win-probability stats?`);
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/research?id=${encodeURIComponent(match.id)}`, {
        method: 'DELETE',
        cache: 'no-store',
      });
      const data = await res.json();
      if (data.ok !== true) {
        setNotice(data.error || 'Could not delete this history match.');
        return;
      }

      setHistory(prev => {
        const next = prev.filter(row => row.id !== match.id);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        return next;
      });
      setNotice(`Deleted ${match.home} vs ${match.away} from History.`);
      await loadSharedResearch();
    } catch {
      setNotice('Could not delete this history match.');
    }
  }

  function dueForPhase(match: TradingMatch, phase: 'HT' | 'FT') {
    if (!match.kickoff) return false;
    const elapsed = (Date.now() - new Date(match.kickoff).getTime()) / 60000;
    if (phase === 'HT') return elapsed >= 43 && elapsed <= 85 && match.htVerified !== true;
    return elapsed >= 105 && elapsed <= 72 * 60 && match.ftVerified !== true && match.status !== 'FT';
  }

  async function runLiveBatch(phase: 'HT' | 'FT') {
    const pool = phase === 'FT'
      ? [...starred, ...history.filter(m => m.watchStatus === 'EXPIRED_UNVERIFIED')]
      : starred;
    const unique = new Map<string, TradingMatch>();
    for (const m of pool.filter(m => dueForPhase(m, phase))) {
      unique.set(m.id, richerLifecycleMatch(unique.get(m.id), m));
    }
    const candidates = Array.from(unique.values()).slice(0, 10);
    if (!candidates.length) {
      setNotice(phase === 'HT' ? 'No HT checks are due right now.' : 'No FT checks are due right now.');
      return;
    }

    setBatchLoading(phase);
    setNotice(`${phase} Batch · checking ${candidates.length} matches in one shared request…`);
    try {
      const res = await fetch('/api/live-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase, matches: candidates }),
      });
      const data = await res.json();

      if (data.providerStatus === 'DAILY_LIVE_BUDGET_REACHED') {
        setNotice('Live-data daily budget reached. No paid batch was started.');
        return;
      }
      if (data.providerStatus !== 'CONNECTED') {
        setNotice(data.message || data.error || 'Batch check failed. No result was verified.');
        return;
      }

      const results = (data.results ?? []) as TradingMatch[];
      const byId = new Map(results.map(m => [m.id, m]));
      setStarred(prev => {
        const completedIds = new Set(results.filter(m => m.status === 'FT' && m.ftVerified === true).map(m => m.id));
        const next = phase === 'FT'
          ? prev.filter(m => !completedIds.has(m.id) && m.status !== 'FT')
          : prev.map(m => byId.get(m.id) ?? m).filter(m => m.status !== 'FT');
        localStorage.setItem(STAR_KEY, JSON.stringify(next));
        return next;
      });
      setMatches(prev => prev.map(m => byId.get(m.id) ?? m));
      setHistory(prev => {
        const historyResults = phase === 'HT'
          ? results.filter(m => m.htVerified === true)
          : results.filter(m => m.status === 'FT' && m.ftVerified === true);
        const completed = new Set(historyResults.filter(m => m.status === 'FT' && m.ftVerified).map(m => m.id));
        const merged = [...historyResults, ...prev.filter(m => !(completed.has(m.id) && m.watchStatus === 'EXPIRED_UNVERIFIED'))];
        const deduped = Array.from(new Map(merged.map(m => [`${m.id}-${m.researchPhase ?? m.status}`, m])).values()).slice(0, 500);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped));
        return deduped;
      });

      if (phase === 'FT') {
        const verified = results.filter(m => m.status === 'FT' && m.ftVerified === true).length;
        const pending = results.length - verified;
        const reason = pending && results.find(m => m.ftVerified !== true)?.ftSourceSummary;
        setNotice(`FT Batch · ${verified} verified · ${pending} pending · ${data.providerRequests ?? 0} fixture API requests · 0 GPT web searches${reason ? ' · ' + reason : ''}`);
        void loadSharedResearch();
      } else {
        setNotice(`HT Batch · ${results.filter(m => m.htVerified === true).length} source-verified · ${results.filter(m => m.htVerified !== true).length} pending · 0 GPT web searches`);
      }
    } catch {
      setNotice(`${phase} Batch failed. Saved data was not overwritten.`);
    } finally {
      setBatchLoading(null);
    }
  }

  async function loadCachedScan() {
    try {
      const res = await fetch('/api/scan', { cache: 'no-store' });
      const data = await res.json();
      const incoming = ((data.matches ?? []) as TradingMatch[]).map(sanitizeOddsSnapshot);

      setMatches(incoming);
      setProviderStatus(data.providerStatus ?? data.mode ?? '');
      setUpdatedAt(data.updatedAt ?? '');
      setNextRefreshAt(data.nextRefreshAt ?? '');
      setScanStatus(data.scanStatus ?? '');
      setScanCoverage(data.fixturesFound != null
        ? `${data.fixturesVerified ?? 0}/${data.fixturesFound} fixtures verified`
        : '');
      setBudgetStatus(data.budgetMessage ?? (data.estimatedCostUsd != null
        ? `This scan est. ${Number(data.estimatedCostUsd).toFixed(3)}`
        : ''));

      if (incoming.length) {
        setStarred(prev => {
          const next = mergeWatchlistOdds(
            prev.filter(m => m.status !== 'FT' && !isWatchExpired(m)),
            incoming.filter(m => m.state === 'QUALIFIED' && m.status !== 'FT' && !isWatchExpired(m))
          );
          localStorage.setItem(STAR_KEY, JSON.stringify(next));
          return next;
        });
      }
    } catch {
      // Opening the app must never trigger a paid scan or block the UI.
    }
  }

  function saveStarred(next: TradingMatch[]) {
    const clean = mergeWatchlistOdds(next, []);
    setStarred(clean);
    localStorage.setItem(STAR_KEY, JSON.stringify(clean));
  }

  function saveHistory(next: TradingMatch[]) {
    const deduped = Array.from(
      new Map(next.map(m => [`${m.id}-${m.checkedAt ?? m.status}-${m.state}`, m])).values()
    ).slice(0, 150);
    setHistory(deduped);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped));
  }

  async function scanUpcoming() {
    setLoading(true);
    try {
      let data: any;

      try {
        const res = await fetch('/api/scan?refresh=1', { cache: 'no-store' });
        const text = await res.text();
        data = JSON.parse(text);
      } catch {
        // A mobile browser/network can drop a long response even after the server
        // finished the paid scan. Recover from the shared persistent cache first,
        // so retrying never starts a second paid scan.
        await new Promise(resolve => setTimeout(resolve, 1200));
        const recovery = await fetch('/api/scan', { cache: 'no-store' });
        const recoveryText = await recovery.text();
        data = JSON.parse(recoveryText);
      }

      const incoming = ((data.matches ?? []) as TradingMatch[]).map(sanitizeOddsSnapshot);

      setMatches(incoming);
      setProviderStatus(data.providerStatus ?? data.mode ?? '');
      setUpdatedAt(data.updatedAt ?? '');
      setNextRefreshAt(data.nextRefreshAt ?? '');
      setScanStatus(data.scanStatus ?? '');
      setScanCoverage(data.fixturesFound != null
        ? `${data.fixturesVerified ?? 0}/${data.fixturesFound} fixtures verified`
        : '');
      setBudgetStatus(data.budgetMessage ?? '');

      if (incoming.length) {
        setStarred(prev => {
          const next = mergeWatchlistOdds(
            prev.filter(m => m.status !== 'FT' && !isWatchExpired(m)),
            incoming.filter(m => m.state === 'QUALIFIED' && m.status !== 'FT' && !isWatchExpired(m))
          );
          localStorage.setItem(STAR_KEY, JSON.stringify(next));
          return next;
        });

        if (data.providerStatus === 'DAILY_BUDGET_REACHED') {
          setNotice(`Daily budget reached · showing saved result · ${incoming.length} V1 matches`);
        } else if (data.cacheStatus === 'HIT') {
          setNotice(`Shared result · ${incoming.length} qualified V1 matches · cached · no new provider refresh`);
        } else {
          const coverage = data.marketCoverage
            ? ` · ${data.marketCoverage}`
            : data.fixturesFound != null
              ? ` · ${data.fixturesVerified ?? 0}/${data.fixturesFound} complete markets`
              : '';
          const status = data.scanStatus === 'COMPLETE' ? 'COMPLETE' : 'PARTIAL';
          const ah = data.handicapVerifiedCount == null ? '' : ` · FT AH ${data.handicapVerifiedCount}/${incoming.length} verified`;
          const label = data.cacheStatus === 'STALE' || data.providerStatus !== 'CONNECTED'
            ? 'Saved snapshot (not a fresh scan)'
            : 'Provider scan';
          setNotice(`${label} · ${status}${coverage}${ah} · ${incoming.length} qualified`);
        }
      } else {
        const status = data.providerStatus ?? data.mode ?? '';
        setNotice(status === 'API_FOOTBALL_KEY_MISSING'
          ? 'API-Football is not configured yet. Add the provider key before refreshing fixtures.'
          : status === 'DAILY_BUDGET_REACHED'
            ? 'Daily scan budget reached. No paid scan was started.'
            : status === 'ERROR'
              ? `Scan stopped safely · ${data.providerError ?? 'scanner error'} · saved watchlist/history kept`
              : data.scanStatus === 'PARTIAL'
                ? `PARTIAL scan · ${data.fixturesVerified ?? 0}/${data.fixturesFound ?? 0} fixtures have complete goal+corner markets · ${data.missingMarketCount ?? 0} missing market coverage.`
                : 'Scan complete · no verified V1 matches found.');
      }
    } catch {
      setProviderStatus('ERROR');
      setNotice('Pre-match scan failed. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function runHtCheck(match: TradingMatch) {
    setHtLoadingId(match.id);
    setNotice(`Verifying HT with fixture statistics · ${match.home} vs ${match.away}`);
    try {
      const res = await fetch('/api/ht-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(match),
      });
      const data = await res.json();

      if (data.providerStatus === 'HT_DATA_PROVIDER_MISSING' || data.providerStatus === 'API_FOOTBALL_KEY_MISSING') {
        setNotice('API-Football is not configured for automatic HT verification.');
        return;
      }
      if (data.providerStatus !== 'CONNECTED') {
        setNotice(data.advice || 'HT source unavailable. No automatic H2 recommendation was issued.');
        return;
      }

      if (data.htVerified !== true || data.htSourceType !== 'API_FOOTBALL' || data.action === 'NEED_INPUT' || data.evaluationType === 'NEED_INPUT') {
        setNotice('HT source has not confirmed the interval yet. Match stays pending — retry in a few minutes; this attempt will NOT be marked as completed HT.');
        return;
      }

      const baseUpdated: TradingMatch = {
        ...match,
        status: 'HT',
        scoreHome: data.scoreHome ?? match.scoreHome,
        scoreAway: data.scoreAway ?? match.scoreAway,
        cornersHome: data.cornersHome ?? match.cornersHome,
        cornersAway: data.cornersAway ?? match.cornersAway,
        liveGoalLine: data.liveGoalLine ?? null,
        liveGoalOverOdd: data.liveGoalOverOdd ?? null,
        liveGoalUnderOdd: data.liveGoalUnderOdd ?? null,
        liveCornerLine: data.liveCornerLine ?? null,
        liveCornerOverOdd: data.liveCornerOverOdd ?? null,
        liveCornerUnderOdd: data.liveCornerUnderOdd ?? null,
        favouriteCoveringHandicap: data.favouriteCoveringHandicap ?? false,
        favouriteLosing: data.favouriteLosing ?? false,
        ftGoalOverClear: data.ftGoalOverClear ?? false,
        htAction: data.action,
        htVerified: true,
        htSourceType: 'API_FOOTBALL',
        htAdvice: data.reason,
        htConfidence: data.confidence,
        htMissingInputs: Array.isArray(data.missingInputs) ? data.missingInputs : [],
        htSourceSummary: data.sourceSummary,
        htSourceUrls: Array.isArray(data.sourceUrls) ? data.sourceUrls : [],
        htCheckedAt: data.checkedAt ?? new Date().toISOString(),
        htScoreHome: data.scoreHome ?? null,
        htScoreAway: data.scoreAway ?? null,
        htCornersHome: data.cornersHome ?? null,
        htCornersAway: data.cornersAway ?? null,
        htEvaluationType: data.evaluationType,
        h2GoalsAssessment: data.h2GoalsAssessment,
        h2CornersAssessment: data.h2CornersAssessment,
        htDataNote: data.dataNote,
        h2ExecutionAction: data.h2ExecutionAction,
        h2ExecutionText: data.h2ExecutionText,
        h2ExecutionDetail: data.h2ExecutionDetail,
        checkedAt: data.checkedAt ?? new Date().toISOString(),
      };

      const updated: TradingMatch = {
        ...baseUpdated,
        h2Predictions: buildH2Predictions(baseUpdated),
      };

      setMatches(prev => prev.map(m => m.id === updated.id ? updated : m));
      setStarred(prev => {
        const next = prev.map(m => m.id === updated.id ? updated : m);
        localStorage.setItem(STAR_KEY, JSON.stringify(next));
        return next;
      });
      saveHistory([updated, ...history]);
      void persistResearch({ ...updated, researchPhase: 'HT' });
      setNotice(`HT Check · ${String(data.action).replace(/_/g, ' ')}`);
    } catch {
      setNotice('HT Check failed. Try again.');
    } finally {
      setHtLoadingId(null);
    }
  }

  function toggleStar(match: TradingMatch) {
    if (match.status === 'FT') return;
    const exists = starred.some(m => m.id === match.id);
    saveStarred(exists ? starred.filter(m => m.id !== match.id) : [{ ...match }, ...starred.filter(m => m.status !== 'FT')]);
  }

  function submitCheckpoint(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!checkpoint) return;
    const fd = new FormData(e.currentTarget);
    const isHt = fd.get('status') === 'HT';
    const required = ['scoreHome', 'scoreAway', 'cornersHome', 'cornersAway'];
    if (isHt && required.some(name => {
      const raw = fd.get(name);
      return typeof raw !== 'string' || raw.trim() === '' ||
        !Number.isInteger(Number(raw)) || Number(raw) < 0;
    })) {
      setNotice('Manual HT check needs both scores and BOTH team corner counts. Empty is not zero.');
      return;
    }

    const updated: TradingMatch = {
      ...checkpoint,
      status: String(fd.get('status')) as TradingMatch['status'],
      minute: Number(fd.get('minute')) || null,
      scoreHome: Number(fd.get('scoreHome')) || 0,
      scoreAway: Number(fd.get('scoreAway')) || 0,
      cornersHome: Number(fd.get('cornersHome')) || 0,
      cornersAway: Number(fd.get('cornersAway')) || 0,
      liveCornerLine: fd.get('liveCornerLine') ? Number(fd.get('liveCornerLine')) : null,
      liveGoalLine: fd.get('liveGoalLine') ? Number(fd.get('liveGoalLine')) : null,
      favouriteCoveringHandicap: fd.get('favCovering') === 'on',
      favouriteLosing: fd.get('favLosing') === 'on',
      ftGoalOverClear: fd.get('goalClear') === 'on',
      checkedAt: new Date().toISOString(),
    };

    const baseEvaluated = { ...updated, ...evaluateV1(updated) };
    let evaluated: TradingMatch = baseEvaluated;

    if (updated.status === 'HT') {
      const totalHtCorners = updated.cornersHome + updated.cornersAway;
      const is00 = updated.scoreHome === 0 && updated.scoreAway === 0;
      const cornerTrigger = updated.favouriteCoveringHandicap || updated.favouriteLosing || updated.ftGoalOverClear;
      const htAction: TradingMatch['htAction'] =
        totalHtCorners > 5 ? 'NO_ENTRY'
          : is00 ? 'H2_GOALS_AND_CORNERS'
            : cornerTrigger ? 'H2_CORNERS'
              : 'NO_ENTRY';
      const htEvaluationType: TradingMatch['htEvaluationType'] =
        htAction === 'NO_ENTRY' ? 'V1_CANCEL_DATA' : 'V1_TRIGGER';

      const htBase: TradingMatch = {
        ...baseEvaluated,
        htAction,
        htEvaluationType,
        h2GoalsAssessment: htAction === 'H2_GOALS_AND_CORNERS' ? 'V1_SUPPORTED' : 'V1_NOT_SUPPORTED',
        h2CornersAssessment: htAction === 'H2_GOALS_AND_CORNERS' || htAction === 'H2_CORNERS' ? 'V1_SUPPORTED' : 'V1_NOT_SUPPORTED',
        htAdvice: totalHtCorners > 5
          ? `V1 cancelled: HT corners ${totalHtCorners} > 5.`
          : htAction === 'H2_GOALS_AND_CORNERS'
            ? `V1 trigger: HT 0-0 and corners ${totalHtCorners} <= 5 -> H2 Goals + H2 Corners.`
            : htAction === 'H2_CORNERS'
              ? `V1 trigger: HT corners ${totalHtCorners} <= 5 plus aligned favourite/FT-goals condition -> H2 Corners.`
              : `No V1 trigger: HT corners ${totalHtCorners} <= 5 but the remaining V1 conditions are not aligned.`,
        htConfidence: 'LOW',
        htVerified: false,
        htSourceType: 'MANUAL',
        htSourceSummary: 'Manually entered HT data; not independently verified',
        htSourceUrls: [],
        htMissingInputs: [],
        htCheckedAt: updated.checkedAt,
        htScoreHome: updated.scoreHome,
        htScoreAway: updated.scoreAway,
        htCornersHome: updated.cornersHome,
        htCornersAway: updated.cornersAway,
        researchPhase: 'HT',
      };
      const execution = deriveH2Execution(htBase);
      evaluated = {
        ...htBase,
        h2ExecutionAction: execution.action,
        h2ExecutionText: execution.text,
        h2ExecutionDetail: execution.detail,
        h2Predictions: buildH2Predictions(htBase),
      };
    }

    setMatches(matches.map(m => m.id === evaluated.id ? evaluated : m));
    saveStarred(starred.map(m => m.id === evaluated.id ? evaluated : m));
    saveHistory([evaluated, ...history]);
    void persistResearch({ ...evaluated, researchPhase: evaluated.status === 'HT' ? 'HT' : 'MANUAL' });

    if (evaluated.state === 'TRIGGER' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`V1 TRIGGER — ${evaluated.home} vs ${evaluated.away}`, {
        body: `${evaluated.status} | ${evaluated.scoreHome}-${evaluated.scoreAway} | Corners ${evaluated.cornersHome}-${evaluated.cornersAway} | V1 ${evaluated.winProbability}%`,
      });
    }

    setNotice(`${evaluated.state} · V1 ${evaluated.winProbability}%`);
    setCheckpoint(null);
  }

  async function enableNotifications() {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

    if (!('Notification' in window)) {
      setNotice(isIos
        ? 'iPhone alerts require the app to be added to Home Screen first.'
        : 'This browser does not support notifications.');
      return;
    }

    if (isIos && !isStandalone) {
      setNotice('On iPhone: Share → Add to Home Screen, then open the installed app and tap Alerts again.');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setNotice('Alerts permission enabled on this device.');
    } else if (permission === 'denied') {
      setNotice('Alerts are blocked in device/browser settings.');
    } else {
      setNotice('Alerts permission was not enabled.');
    }
  }

  const verifiedHistory = useMemo(
    () => history.filter(m => m.researchPhase === 'FT' && m.ftVerified === true),
    [history]
  );

  const historyCounts = useMemo(() => {
    const counts: Record<HistoryGroup, number> = { WIN: 0, LOSE: 0, DRAW: 0, NE: 0 };
    const rows = league === 'ALL'
      ? verifiedHistory
      : verifiedHistory.filter(m => m.league === league);

    for (const match of rows) {
      const status = methodMatchStatus(match);
      if (status) counts[status] += 1;
    }
    return counts;
  }, [verifiedHistory, league]);

  const source = view === 'HISTORY'
    ? verifiedHistory.filter(m => historyGroup != null && methodMatchStatus(m) === historyGroup)
    : starred.filter(m => m.status !== 'FT' && !isWatchExpired(m, clock));

  const filtered = useMemo(() => {
    let rows = league === 'ALL' ? source : source.filter(m => m.league === league);
    if (view !== 'HISTORY' && selectedDay !== 'ALL') {
      rows = rows.filter(m => m.kickoff && localDayKey(m.kickoff) === selectedDay);
    }
    return rows;
  }, [source, league, view, selectedDay]);

  const dates = useMemo(() => dayRail(clock), [clock]);

  const dueCount = starred.filter(m =>
    m.status !== 'FT' &&
    !isWatchExpired(m, clock) &&
    (dueForPhase(m, 'HT') || dueForPhase(m, 'FT'))
  ).length;
  const triggerCount = starred.filter(m => m.state === 'TRIGGER').length;
  const qualifiedCount = matches.filter(m => m.state === 'QUALIFIED').length;

  return (
    <main className="shell">
      <header className="appHeader">
        <div className="brandBlock">
          <div className="brandMark">V1</div>
          <div>
            <p className="eyebrow">FOOTBALL TRADING</p>
            <h1>Match Center</h1>
          </div>
        </div>
        <div className="headerActions">
          <button className="iconAction" onClick={enableNotifications} aria-label="Alerts">🔔</button>
          <button className="quickAction" onClick={() => runLiveBatch('HT')} disabled={batchLoading !== null}>
            {batchLoading === 'HT' ? 'HT…' : 'HT'}
          </button>
          <button className="quickAction" onClick={() => runLiveBatch('FT')} disabled={batchLoading !== null}>
            {batchLoading === 'FT' ? 'FT…' : 'FT'}
          </button>
          <button className="refreshAction" onClick={scanUpcoming} disabled={loading}>
            {loading ? 'Scanning…' : 'Scan 24h'}
          </button>
        </div>
      </header>

      {notice && <div className="toast" onClick={() => setNotice('')}>{notice}</div>}

      <section className="summary">
        <div><span>Qualified</span><strong>{qualifiedCount}</strong></div>
        <div><span>Saved</span><strong>{starred.length}</strong></div>
        <div><span>Due now</span><strong>{dueCount}</strong></div>
      </section>

      <nav className="mainTabs">
        <button className={view === 'STARRED' ? 'active' : ''} onClick={() => setView('STARRED')}>★ My Watches</button>
        <button className={view === 'HISTORY' ? 'active' : ''} onClick={() => setView('HISTORY')}>History</button>
      </nav>

      {view !== 'HISTORY' && (
        <nav className="dateRail">
          <button className={selectedDay === 'ALL' ? 'active' : ''} onClick={() => setSelectedDay('ALL')}>
            <strong>ALL</strong><span>24H</span>
          </button>
          {dates.map(item => (
            <button key={item.key} className={selectedDay === item.key ? 'active' : ''} onClick={() => setSelectedDay(item.key)}>
              <strong>{item.dow}</strong><span>{item.date}</span>
            </button>
          ))}
        </nav>
      )}

      <nav className="leagueTabs">
        {leagues.map(item => (
          <button key={item} className={league === item ? 'active' : ''} onClick={() => setLeague(item)}>
            {item === 'ALL' ? 'All' : item}
          </button>
        ))}
      </nav>

      {view === 'HISTORY' && (
        <>
          {methodOverall && methodOverall.samples > 0 && (
            <section className="winProbabilityBox">
              <div className="winProbabilityTop">
                <div>
                  <span>WIN PROBABILITY</span>
                  <strong>{methodOverall.smoothedWinRate}%</strong>
                </div>
                <b>{methodOverall.confidenceLabel.replace(/_/g, ' ')}</b>
              </div>
              <div className="winProbabilityMetrics">
                <div><span>Observed</span><b>{methodOverall.observedWinRate}%</b></div>
                <div><span>Samples</span><b>{methodOverall.samples}</b></div>
                <div><span>Success</span><b>{methodOverall.successes}</b></div>
                <div><span>Fail</span><b>{methodOverall.failures}</b></div>
              </div>
              {methodStats.length > 0 && (
                <details className="probabilityBreakdown">
                  <summary>By setup</summary>
                  {methodStats.map(stat => (
                    <div className="probabilitySetupRow" key={`method-${stat.market}-${stat.key}`}>
                      <span>{stat.market === 'H2_CORNERS' ? 'Corners' : 'Goals'} · {stat.key.replace(/_/g, ' ')}</span>
                      <b>{stat.smoothedWinRate}%</b>
                      <small>{stat.successes}/{stat.samples}</small>
                    </div>
                  ))}
                </details>
              )}
            </section>
          )}
          <section className="historyGroupGrid" aria-label="History result groups">
            {(['WIN', 'LOSE', 'DRAW', 'NE'] as HistoryGroup[]).map(group => (
              <button
                key={group}
                className={`historyGroupBox ${group.toLowerCase()} ${historyGroup === group ? 'active' : ''}`}
                onClick={() => setHistoryGroup(current => current === group ? null : group)}
              >
                <span>{group}</span>
                <strong>{historyCounts[group]}</strong>
                <small>{historyGroup === group ? 'Hide matches' : 'View matches'}</small>
              </button>
            ))}
          </section>

          {historyGroup && (
            <div className="historyGroupHeader">
              <span>{historyGroup} · {historyCounts[historyGroup]} match{historyCounts[historyGroup] === 1 ? '' : 'es'}</span>
              <button onClick={() => setHistoryGroup(null)}>Close</button>
            </div>
          )}
        </>
      )}

      <section className="matchList">
        {filtered.length > 0 ? filtered.map(match => (
          <div key={`${match.id}-${view}-${match.checkedAt}`}>
            {view === 'STARRED' && (
              <div className={`checkpointLabel ${dueForPhase(match, 'HT') || dueForPhase(match, 'FT') ? 'due' : ''}`}>
                <span>NEXT CHECK</span>
                <b>{nextCheckpoint(match)}</b>
              </div>
            )}
            <MatchCard
              match={match}
              starred={starred.some(m => m.id === match.id)}
              onToggleStar={view !== 'HISTORY' ? toggleStar : undefined}
              onCheckpoint={view !== 'HISTORY' ? setCheckpoint : undefined}
              onHtCheck={view === 'STARRED' ? runHtCheck : undefined}
              htLoading={htLoadingId === match.id}
              htCheckReady={view === 'STARRED' && dueForPhase(match, 'HT')}
              compact={view === 'HISTORY'}
              onDeleteHistory={view === 'HISTORY' ? deleteHistoryMatch : undefined}
            />
          </div>
        )) : (
          <div className="emptyState">
            <strong>
              {view === 'STARRED'
                ? (loading ? 'Scanning upcoming matches…' : 'No V1 matches in ★ yet')
                : historyGroup
                  ? `No ${historyGroup} matches in this filter`
                  : 'Choose a History group'}
            </strong>
            <span>
              {view === 'STARRED'
                ? 'Tap Scan 24h to load qualified fixtures. Saved V1 matches stay here until FT.'
                : historyGroup
                  ? 'Try another result group or league.'
                  : 'Tap WIN, LOSE, DRAW or NE to view those matches.'}
            </span>
          </div>
        )}
      </section>

      {checkpoint && (
        <div className="modalBackdrop" onClick={() => setCheckpoint(null)}>
          <form className="checkpointForm" onSubmit={submitCheckpoint} onClick={e => e.stopPropagation()}>
            <div className="modalTop">
              <div>
                <p className="eyebrow">CHECKPOINT</p>
                <strong>{checkpoint.home} vs {checkpoint.away}</strong>
              </div>
              <button type="button" className="closeBtn" onClick={() => setCheckpoint(null)}>×</button>
            </div>

            <div className="formGrid">
              <select name="status" defaultValue={checkpoint.status === 'PRE' ? 'HT' : checkpoint.status}>
                <option value="LIVE">LIVE</option>
                <option value="HT">HT</option>
                <option value="FT">FT</option>
              </select>
              <input name="minute" type="number" placeholder="Minute" defaultValue={checkpoint.minute ?? 45} />
              <input name="scoreHome" type="number" min="0" required placeholder="Home goals (required)" defaultValue={checkpoint.htCheckedAt || checkpoint.htSourceType === 'MANUAL' ? checkpoint.scoreHome : ''} />
              <input name="scoreAway" type="number" min="0" required placeholder="Away goals (required)" defaultValue={checkpoint.htCheckedAt || checkpoint.htSourceType === 'MANUAL' ? checkpoint.scoreAway : ''} />
              <input name="cornersHome" type="number" min="0" required placeholder="Home corners (required)" defaultValue={checkpoint.htSourceType === 'MANUAL' ? checkpoint.cornersHome : ''} />
              <input name="cornersAway" type="number" min="0" required placeholder="Away corners (required)" defaultValue={checkpoint.htSourceType === 'MANUAL' ? checkpoint.cornersAway : ''} />
              <input name="liveCornerLine" type="number" step="0.25" placeholder="365 live corner line" defaultValue={checkpoint.liveCornerLine ?? ''} />
              <input name="liveGoalLine" type="number" step="0.25" placeholder="365 live goal line" defaultValue={checkpoint.liveGoalLine ?? ''} />
            </div>

            <div className="checkFlags">
              <label><input type="checkbox" name="favCovering" /> Favourite covering handicap</label>
              <label><input type="checkbox" name="favLosing" /> Favourite losing</label>
              <label><input type="checkbox" name="goalClear" /> FT Over Goals already clear</label>
            </div>

            <button className="primaryBtn" type="submit">Evaluate V1 snapshot</button>
            <p className="formHint">Manual data are NOT independently verified. Enter exact HT scores and corners from your sportsbook; leave missing H2 lines blank (never 0). V1 results will be marked MANUAL.</p>
          </form>
        </div>
      )}

      <footer>
        <span>Structured football feed · V1 rules local</span>
        <span>{updatedAt ? `Last scan ${new Date(updatedAt).toLocaleTimeString()}` : 'Waiting for provider refresh'}</span>
        {nextRefreshAt && <span>{`Provider cache until ${new Date(nextRefreshAt).toLocaleTimeString()}`}</span>}
        {scanStatus && <span>{`Scan ${scanStatus}${scanCoverage ? ` · ${scanCoverage}` : ''}`}</span>}
        {budgetStatus && <span>{budgetStatus}</span>}
      </footer>
    </main>
  );
}
