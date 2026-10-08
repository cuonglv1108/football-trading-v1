'use client';

import { useState } from 'react';
import { TradingMatch } from '../lib/types';

type Props = {
  match: TradingMatch;
  starred?: boolean;
  onToggleStar?: (match: TradingMatch) => void;
  onCheckpoint?: (match: TradingMatch) => void;
  onHtCheck?: (match: TradingMatch) => void;
  htLoading?: boolean;
  compact?: boolean;
};

export default function MatchCard({ match, starred = false, onToggleStar, onCheckpoint, onHtCheck, htLoading = false, compact = false }: Props) {
  const totalCorners = match.cornersHome + match.cornersAway;
  const probability = match.winProbability ?? 0;
  const [expanded, setExpanded] = useState(compact);

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

      {!compact && (
        <button className="detailsBtn" onClick={() => setExpanded(v => !v)}>
          {expanded ? 'Hide details' : 'View details'}
        </button>
      )}

      {(expanded || compact) && (
        <>
          <div className="metrics">
            <div><span>Corners</span><b>{match.cornersHome}-{match.cornersAway} ({totalCorners})</b></div>
            <div><span>Pre corner</span><b>{match.prematchCornerLine}</b></div>
            <div><span>Pre goals</span><b>{match.prematchGoalLine}</b></div>
          </div>

          {match.sourceSummary && (
            <div className="sourceBox">
              <span>Source</span>
              <b>{match.sourceSummary}</b>
              {(match.sourceUrls ?? []).slice(0, 2).map((url, i) => (
                <a key={url + i} href={url} target="_blank" rel="noreferrer">Open source {i + 1}</a>
              ))}
            </div>
          )}

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

          {match.htAction && (
            <div className="htAdvice">
              <div className="htAdviceTop">
                <span>HT DECISION</span>
                <b>{match.htAction.replace(/_/g, ' ')}</b>
              </div>
              {match.htAdvice && <p>{match.htAdvice}</p>}
              {match.htConfidence && <small>Confidence: {match.htConfidence}</small>}
              {match.htEvaluationType && <small>Record type: {match.htEvaluationType.replace(/_/g, ' ')}</small>}
              {match.h2GoalsAssessment && <small>H2 Goals: {match.h2GoalsAssessment.replace(/_/g, ' ')}</small>}
              {match.h2CornersAssessment && <small>H2 Corners: {match.h2CornersAssessment.replace(/_/g, ' ')}</small>}
              {match.htDataNote && <p className="htDataNote">{match.htDataNote}</p>}
              {(match.htMissingInputs ?? []).length > 0 && (
                <small>Missing: {(match.htMissingInputs ?? []).join(', ')}</small>
              )}
              {(match.htSourceUrls ?? []).slice(0,2).map((url, i) => (
                <a key={url+i} href={url} target="_blank" rel="noreferrer">HT source {i + 1}</a>
              ))}
            </div>
          )}

          {onHtCheck && match.status !== 'FT' && (
            <button className="htCheckBtn" onClick={() => onHtCheck(match)} disabled={htLoading}>
              {htLoading ? 'GPT checking HT…' : 'HT Check'}
            </button>
          )}

          {onCheckpoint && match.status !== 'FT' && (
            <button className="checkBtn" onClick={() => onCheckpoint(match)}>Manual Check</button>
          )}
        </>
      )}
    </article>
  );
}
