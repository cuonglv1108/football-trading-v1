'use client';

import { TradingMatch } from '../lib/types';

const stateLabel = {
  QUALIFIED: 'QUALIFIED',
  WATCHING: 'WAIT HT',
  TRIGGER: 'V1 TRIGGER',
  CANCELLED: 'CANCELLED',
};

type Props = {
  match: TradingMatch;
  starred?: boolean;
  onToggleStar?: (match: TradingMatch) => void;
  compact?: boolean;
};

export default function MatchCard({ match, starred = false, onToggleStar, compact = false }: Props) {
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

      {match.status === 'PRE' && match.kickoff && (
        <div className="kickoff">{new Date(match.kickoff).toLocaleString()}</div>
      )}

      <div className="metrics">
        <div><span>Corners</span><b>{match.cornersHome}-{match.cornersAway} ({totalCorners})</b></div>
        <div><span>Pre corner</span><b>{match.prematchCornerLine}</b></div>
        <div><span>Pre goals</span><b>{match.prematchGoalLine}</b></div>
      </div>

      <div className="probabilityRow">
        <div>
          <span>V1 win probability</span>
          <b>{probability}%</b>
        </div>
        <div className="probabilityTrack">
          <div className="probabilityFill" style={{ width: `${probability}%` }} />
        </div>
      </div>

      <div className="signal">
        <div className="dot" />
        <div>
          <b>{stateLabel[match.state ?? 'WATCHING']}</b>
          <p>{match.reasons?.[0]}</p>
        </div>
      </div>
    </article>
  );
}
