'use client';

import { TradingMatch } from '../lib/types';

type Props = {
  match: TradingMatch;
  starred?: boolean;
  onToggleStar?: (match: TradingMatch) => void;
  onCheckpoint?: (match: TradingMatch) => void;
  compact?: boolean;
};

export default function MatchCard({ match, starred = false, onToggleStar, onCheckpoint, compact = false }: Props) {
  const totalCorners = match.cornersHome + match.cornersAway;
  const probability = match.winProbability ?? 0;

  return (
    <article className={`card state-${match.state?.toLowerCase()} ${compact ? 'compact' : ''}`}>
      <div className="cardTop">
        <span className="league">{match.league}</span>
        <div className="cardActions">
          {match.notable && <span className="notableBadge">★ V1 PICK</span>}
          {onToggleStar && (
            <button
              className={`starBtn ${starred ? 'active' : ''}`}
              onClick={() => onToggleStar(match)}
              aria-label={starred ? 'Remove from starred' : 'Add to starred'}
            >
              ★
            </button>
          )}
          <span className="status">{match.status === 'LIVE' ? `${match.minute}'` : match.status}</span>
        </div>
      </div>

      <div className="teams">
        <strong>{match.home}</strong>
        <span>{match.scoreHome} - {match.scoreAway}</span>
        <strong>{match.away}</strong>
      </div>

      {match.kickoff && (
        <div className="kickoff">
          {new Date(match.kickoff).toLocaleString()}
          {match.checkedAt ? ` · checked ${new Date(match.checkedAt).toLocaleTimeString()}` : ''}
        </div>
      )}

      <div className="metrics">
        <div><span>Corners</span><b>{match.cornersHome}-{match.cornersAway} ({totalCorners})</b></div>
        <div><span>Pre corner</span><b>{match.prematchCornerLine}</b></div>
        <div><span>Pre goals</span><b>{match.prematchGoalLine}</b></div>
      </div>

      {(match.liveCornerLine || match.liveGoalLine) && (
        <div className="liveLines">
          <span>365 snapshot</span>
          <b>C {match.liveCornerLine ?? '—'} · G {match.liveGoalLine ?? '—'}</b>
        </div>
      )}

      <div className="probabilityRow">
        <div>
          <span>V1</span>
          <b>{probability}%</b>
        </div>
        <div className="probabilityTrack">
          <div className="probabilityFill" style={{ width: `${probability}%` }} />
        </div>
      </div>


      {onCheckpoint && match.status !== 'FT' && (
        <button className="checkBtn" onClick={() => onCheckpoint(match)}>Check</button>
      )}
    </article>
  );
}
