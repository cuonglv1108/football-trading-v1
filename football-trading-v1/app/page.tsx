'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import MatchCard from '../components/MatchCard';
import { League, TradingMatch } from '../lib/types';

const leagues: Array<'ALL' | League> = ['ALL', 'MLS', 'Allsvenskan', 'Liga MX'];
type FeedMode = 'DEMO' | 'NO_LIVE_PROVIDER' | 'LIVE';

export default function Home() {
  const [matches, setMatches] = useState<TradingMatch[]>([]);
  const [league, setLeague] = useState<'ALL' | League>('ALL');
  const [updatedAt, setUpdatedAt] = useState('');
  const [mode, setMode] = useState<FeedMode>('NO_LIVE_PROVIDER');
  const [dataSource, setDataSource] = useState<string | null>(null);
  const previousStates = useRef<Record<string, string>>({});

  async function refresh() {
    const res = await fetch('/api/matches', { cache: 'no-store' });
    const data = await res.json();
    setMatches(data.matches ?? []);
    setUpdatedAt(data.updatedAt ?? '');
    setMode(data.mode ?? 'NO_LIVE_PROVIDER');
    setDataSource(data.dataSource ?? null);

    if (data.mode !== 'LIVE') return;

    for (const m of (data.matches ?? []) as TradingMatch[]) {
      const prev = previousStates.current[m.id];
      if (prev && prev !== 'TRIGGER' && m.state === 'TRIGGER' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification(`V1 TRIGGER — ${m.home} vs ${m.away}`, {
            body: `${m.status} | ${m.scoreHome}-${m.scoreAway} | Corners ${m.cornersHome}-${m.cornersAway}`,
          });
        }
      }
      previousStates.current[m.id] = m.state ?? '';
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => league === 'ALL' ? matches : matches.filter(m => m.league === league), [matches, league]);
  const liveCount = matches.filter(m => m.status === 'LIVE' || m.status === 'HT').length;
  const triggerCount = matches.filter(m => m.state === 'TRIGGER').length;

  async function enableNotifications() {
    if ('Notification' in window) await Notification.requestPermission();
  }

  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">FOOTBALL TRADING</p>
          <h1>V1 Scanner</h1>
        </div>
        <button className="notify" onClick={enableNotifications}>Enable alerts</button>
      </header>

      {mode !== 'LIVE' && (
        <section className="feedNotice" role="status">
          <strong>{mode === 'DEMO' ? 'DEMO MODE' : 'LIVE DATA NOT CONNECTED'}</strong>
          <span>
            {mode === 'DEMO'
              ? `Synthetic test data only${dataSource ? ` — ${dataSource}` : ''}. Not real fixtures.`
              : 'No matches are shown until a verified live provider is connected.'}
          </span>
        </section>
      )}

      <section className="summary">
        <div><span>Live</span><strong>{liveCount}</strong></div>
        <div><span>Triggers</span><strong>{triggerCount}</strong></div>
        <div><span>Tracked</span><strong>{matches.length}</strong></div>
      </section>

      <nav className="leagueTabs">
        {leagues.map(item => (
          <button key={item} className={league === item ? 'active' : ''} onClick={() => setLeague(item)}>
            {item === 'ALL' ? 'All' : item}
          </button>
        ))}
      </nav>

      <section className="matchList">
        {filtered.length > 0
          ? filtered.map(match => <MatchCard key={match.id} match={match} />)
          : <div className="emptyState">
              <strong>No verified live matches</strong>
              <span>The scanner will stay empty rather than display guessed or synthetic fixtures.</span>
            </div>}
      </section>

      <footer>
        <span>{mode === 'LIVE' ? 'Verified live feed' : mode === 'DEMO' ? 'Demo feed' : 'Waiting for live provider'}</span>
        <span>{updatedAt ? `Checked ${new Date(updatedAt).toLocaleTimeString()}` : 'Connecting…'}</span>
      </footer>
    </main>
  );
}
