'use client';

import { useState } from 'react';
import { TradingMatch } from '../lib/types';
import { deriveH2Execution } from '../lib/h2Execution';
import { evaluateMethodOutcomes, inferVerifiedHtAction, methodMatchStatus } from '../lib/outcomes';

function hkOdd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  const hk = value >= 1 ? value - 1 : value;
  return hk.toFixed(2);
}

function totalPrice(line: number | null | undefined, over: number | null | undefined, under: number | null | undefined) {
  if (line == null || !Number.isFinite(line)) return 'LINE MISSING';
  if (over == null || under == null || !Number.isFinite(over) || !Number.isFinite(under))
    return `${line} · TWO-WAY PRICES MISSING`;
  return `${line} · O ${hkOdd(over)} / U ${hkOdd(under)}`;
}

type Props = {
  match: TradingMatch;
  starred?: boolean;
  onToggleStar?: (match: TradingMatch) => void;
  onCheckpoint?: (match: TradingMatch) => void;
  onHtCheck?: (match: TradingMatch) => void;
  htLoading?: boolean;
  htCheckReady?: boolean;
  compact?: boolean;
  onDeleteHistory?: (match: TradingMatch) => void;
};

export default function MatchCard({ match, starred = false, onToggleStar, onCheckpoint, onHtCheck, htLoading = false, htCheckReady = false, compact = false, onDeleteHistory }: Props) {
  const totalCorners = match.cornersHome + match.cornersAway;
  const [expanded, setExpanded] = useState(false);
  const favouriteName = match.favourite === 'AWAY' ? match.away : match.home;
  // Only display an authenticated Bet365 FT main Asian Handicap quote.
  // Older 1xBet/alternative recovery results are not comparable with Bet365 Asian Spread.
  const ahSource = match.handicapLineSource ?? '';
  const verifiedBet365 = /bet\\s*365/i.test(ahSource) &&
    match.handicapLineVerified === true;
  const pricedHandicap = verifiedBet365 && match.handicapVerified === true &&
    match.handicapHomeOdd != null && match.handicapAwayOdd != null &&
    match.handicapHomeOdd >= 1.65 && match.handicapHomeOdd <= 2.40 &&
    match.handicapAwayOdd >= 1.65 && match.handicapAwayOdd <= 2.40;
  const homeHandicap = verifiedBet365 ? match.prematchHandicapLine ?? null : null;
  const showSign = (line: number) => (line > 0 ? '+' : '') + line.toFixed(2).replace(/\\.00$/, '').replace(/(\\.\\d)0$/, '$1');
  const handicapText = homeHandicap == null
    ? 'Bet365 FT Asian Spread: NOT VERIFIED' +
      (match.handicapLookupStatus ? ' · ' + match.handicapLookupStatus.replace(/_/g, ' ') : '') :
    `${match.home} ${showSign(homeHandicap)}${pricedHandicap ? ' @ ' + match.handicapHomeOdd!.toFixed(3) : ''} / ${match.away} ${showSign(-homeHandicap)}${pricedHandicap ? ' @ ' + match.handicapAwayOdd!.toFixed(3) : ''}` +
    (pricedHandicap ? ' · Bet365 · decimal odds' : ' · line only; prices not verified');

  const cleanSource = (match.sourceSummary ?? '').replace(/\s*·\s*HANDICAP INVALIDATED\s*—\s*SAFEv\d+\s+rescan required/gi, '').trim();
  const legacySource = /SAFEv[0-8]\b/.test(cleanSource);
  const reliableFt = match.researchPhase === 'FT' && match.ftVerified === true &&
    /^API-Football fixture \d+/.test(match.ftSourceSummary ?? '');
  const verifiedHt = match.htVerified === true && match.htSourceType === 'API_FOOTBALL';
  const manualHt = match.htSourceType === 'MANUAL';
  const unverifiedHt = Boolean(match.htAction) && !verifiedHt && !manualHt;
  const execution = match.htAction && verifiedHt ? deriveH2Execution(match) : null;
  const executionText = unverifiedHt ? 'UNVERIFIED HT · NO AUTOMATIC ENTRY'
    : manualHt ? (match.htAction === 'NO_ENTRY' ? 'NO ENTRY · MANUAL HT' : 'MANUAL HT · VERIFY BEFORE ENTRY')
    : (execution?.text ?? match.h2ExecutionText);
  const kickoffDate = match.kickoff ? new Date(match.kickoff) : null;
  const kickoffTime = kickoffDate && Number.isFinite(kickoffDate.getTime())
    ? kickoffDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'TBD';
  const statusLabel = match.watchStatus === 'EXPIRED_UNVERIFIED'
    ? 'ARCH'
    : match.status === 'PRE'
      ? kickoffTime
      : match.status === 'LIVE'
        ? `${match.minute ?? ''}'`
        : match.status;
  const showScore = match.status !== 'PRE' && !unverifiedHt;

  if (compact && match.researchPhase !== 'FT') return null;

  if (compact && match.researchPhase === 'FT') {
    const htCorners = match.htCornersHome != null && match.htCornersAway != null
      ? match.htCornersHome + match.htCornersAway
      : null;
    const methodOutcomes = evaluateMethodOutcomes(match);
    const inferredAction = inferVerifiedHtAction(match);
    const finalStatus = methodMatchStatus(match);
    const verifiedAction = inferredAction === 'H2_GOALS_AND_CORNERS'
      ? 'GOALS + CORNERS'
      : inferredAction === 'H2_CORNERS'
        ? 'CORNERS'
        : inferredAction === 'NO_ENTRY'
          ? 'NO ENTRY'
          : '—';

    return (
      <article className="card compact historyFinalCard">
        <div className="matchAccent" />
        <div className="matchCompactRow">
          <div className="matchTimeBlock">
            <strong>FT</strong>
            <span>{match.league}</span>
          </div>
          <div className="clubPair">
            <div className="clubLine">
              <span className="teamBadge">{match.homeLogo ? <img src={match.homeLogo} alt="" /> : <b>{match.home.slice(0, 2).toUpperCase()}</b>}</span>
              <strong>{match.home}</strong>
              <b className="teamScore">{match.ftScoreHome ?? match.scoreHome}</b>
            </div>
            <div className="clubLine">
              <span className="teamBadge">{match.awayLogo ? <img src={match.awayLogo} alt="" /> : <b>{match.away.slice(0, 2).toUpperCase()}</b>}</span>
              <strong>{match.away}</strong>
              <b className="teamScore">{match.ftScoreAway ?? match.scoreAway}</b>
            </div>
          </div>
          <div className="matchSideActions">
            <span className={`resultBadge ${finalStatus === 'WIN' ? 'win' : finalStatus === 'LOSE' ? 'lose' : finalStatus === 'DRAW' ? 'draw' : finalStatus === 'NE' ? 'ne' : 'pending'}`}>
              {finalStatus ?? '—'}
            </span>
          </div>
        </div>

        <div className="historyCardActions">
          <button className="detailsBtn" onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Hide details' : 'Details'}
          </button>
          {onDeleteHistory && (
            <button
              className="historyDeleteBtn"
              onClick={() => onDeleteHistory(match)}
              aria-label={`Delete ${match.home} vs ${match.away} from history`}
            >
              Delete
            </button>
          )}
        </div>

        {expanded && (
          <div className="historyFinalDetails">
            <div className="verifyStrip">
              <span>HT VERIFIED</span>
              <b>{verifiedAction}</b>
              <small>
                HT corners {htCorners ?? '—'} · H2 Goals {totalPrice(match.liveGoalLine, match.liveGoalOverOdd, match.liveGoalUnderOdd)}
                {' · '}Corners {totalPrice(match.liveCornerLine, match.liveCornerOverOdd, match.liveCornerUnderOdd)}
              </small>
            </div>

            <div className="metrics">
              <div><span>Bet365 corner</span><b>{totalPrice(match.liveCornerLine ?? (match.h2Predictions ?? []).find(p => p.market === 'H2_CORNERS')?.line, match.liveCornerOverOdd, match.liveCornerUnderOdd)}</b></div>
              <div><span>Bet365 H2 goals</span><b>{totalPrice(match.liveGoalLine ?? (match.h2Predictions ?? []).find(p => p.market === 'H2_GOALS')?.line, match.liveGoalOverOdd, match.liveGoalUnderOdd)}</b></div>
              <div><span>H2 corners</span><b>{match.h2ActualCorners ?? '—'}</b></div>
              <div><span>H2 goals</span><b>{match.h2ActualGoals ?? '—'}</b></div>
            </div>

            {methodOutcomes.length > 0 && (
              <div className="methodResultCompact">
                {methodOutcomes.map((o, i) => (
                  <div key={`${o.market}-${i}`} className={`methodOutcome ${o.status.toLowerCase()}`}>
                    <span>{o.market === 'H2_CORNERS' ? 'CORNERS' : 'GOALS'}</span>
                    <b>{o.status === 'SUCCESS' ? 'WIN' : o.status === 'FAIL' ? 'LOSE' : '—'}</b>
                    <small>
                      {o.market === 'H2_CORNERS' ? 'FT corners' : 'H2 goals'} {o.actual ?? '—'} · Bet365 line {o.benchmarkLine || '—'}
                    </small>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </article>
    );
  }

  return (
    <article className={`card state-${match.state?.toLowerCase()} ${compact ? 'compact' : ''}`}>
      <div className="matchAccent" />
      <div className="matchCompactRow">
        <div className="matchTimeBlock">
          <strong>{statusLabel}</strong>
          <span>{match.league}</span>
        </div>

        <div className="clubPair">
          <div className="clubLine">
            <span className="teamBadge">
              {match.homeLogo ? <img src={match.homeLogo} alt="" /> : <b>{match.home.slice(0, 2).toUpperCase()}</b>}
            </span>
            <strong>{match.home}</strong>
            <b className="teamScore">{showScore ? match.scoreHome : ''}</b>
          </div>
          <div className="clubLine">
            <span className="teamBadge">
              {match.awayLogo ? <img src={match.awayLogo} alt="" /> : <b>{match.away.slice(0, 2).toUpperCase()}</b>}
            </span>
            <strong>{match.away}</strong>
            <b className="teamScore">{showScore ? match.scoreAway : ''}</b>
          </div>
        </div>

        <div className="matchSideActions">
          {onToggleStar && (
            <button
              className={`starBtn ${starred ? 'active' : ''}`}
              onClick={() => onToggleStar(match)}
              aria-label={starred ? 'Remove from starred' : 'Add to starred'}
            >
              ★
            </button>
          )}
          {match.notable && <span className="v1Dot">V1</span>}
        </div>
      </div>

      {match.kickoff && (
        <div className="kickoff compactKickoff">
          {kickoffDate?.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          {match.checkedAt ? ` · checked ${new Date(match.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
      )}

      {match.watchStatus === 'EXPIRED_UNVERIFIED' && (
        <div className="htAdvice">
          <b>ARCHIVED · FT NOT VERIFIED</b>
          <p>Removed from active watchlist after the match window. This is not a confirmed final score.</p>
        </div>
      )}
      {match.researchPhase === 'FT' && !reliableFt && (
        <div className="htAdvice">
          <b>LEGACY FT DATA · UNVERIFIED</b>
          <p>Old web-search FT records are retained for audit, not graded as verified outcomes.</p>
        </div>
      )}
      {unverifiedHt && (
        <div className="htAdvice">
          <b>OLD HT SNAPSHOT IS UNVERIFIED</b>
          <p>Legacy corners and odds were not source-verified. The previous V1 H2 recommendation has been withdrawn.</p>
        </div>
      )}
      {executionText && (
        <div className="htAdvice">
          <div className="htAdviceTop">
            <span>H2 NEXT STEP</span>
            <b>{executionText}</b>
          </div>
          {!unverifiedHt && (match.liveGoalLine != null || match.liveCornerLine != null) && (
            <small>
              Bet365 · Goals {totalPrice(match.liveGoalLine, match.liveGoalOverOdd, match.liveGoalUnderOdd)}
              {' · '}Corners {totalPrice(match.liveCornerLine, match.liveCornerOverOdd, match.liveCornerUnderOdd)}
            </small>
          )}
        </div>
      )}

      {onHtCheck && match.status !== 'FT' && (
        <div className="cardQuickActions">
          <button
            className={`htQuickBtn ${htCheckReady ? 'ready' : ''}`}
            onClick={() => onHtCheck(match)}
            disabled={
              htLoading ||
              (!htCheckReady && !(match.htVerified === true && (match.liveGoalLine == null || match.liveCornerLine == null))) ||
              (match.htVerified === true && match.liveGoalLine != null && match.liveCornerLine != null)
            }
          >
            {htLoading
              ? 'CHECKING HT + H2…'
              : match.htVerified === true && match.liveGoalLine != null && match.liveCornerLine != null
                ? 'HT + H2 VERIFIED ✓'
                : match.htVerified === true
                  ? 'REFRESH H2 LINES'
                  : htCheckReady
                    ? 'HT CHECK · GET H2 LINES'
                    : 'HT CHECK · AT HALFTIME'}
          </button>
        </div>
      )}

      <button className="detailsBtn" onClick={() => setExpanded(v => !v)}>
        {expanded ? 'Hide analysis' : compact ? 'View analysis & result' : 'View details'}
      </button>

      {expanded && (
        <>
          <div className="metrics">
            <div><span>Corners</span><b>{unverifiedHt ? 'UNVERIFIED' : `${match.cornersHome}-${match.cornersAway} (${totalCorners})`}</b></div>
            <div><span>Pre corner</span><b>{totalPrice(match.prematchCornerLine, match.prematchCornerOverOdd, match.prematchCornerUnderOdd)}</b></div>
            <div><span>Pre goals</span><b>{totalPrice(match.prematchGoalLine, match.prematchGoalOverOdd, match.prematchGoalUnderOdd)}</b></div>
            <div><span>FT Asian Spread (Bet365)</span><b>{handicapText}</b></div>
          </div>

          {cleanSource && (
            <div className="sourceBox">
              <span>Pre-match market sources (not HT)</span>
              <b>Goals/Corners: {cleanSource.includes('Bet365') ? 'API-Football · Bet365 preferred' : 'API-Football · see source details'} · FT Asian Spread: {pricedHandicap ? ahSource : 'Bet365 quote not verified; ignore any legacy 1xBet AH'}</b>
              {legacySource && <span>Saved legacy snapshot; not reverified</span>}
              {(match.sourceUrls ?? []).slice(0, 2).map((url, i) => (
                <a key={url + i} href={url} target="_blank" rel="noreferrer">Open source {i + 1}</a>
              ))}
            </div>
          )}

          {!unverifiedHt && (match.liveCornerLine != null || match.liveGoalLine != null) && (
            <div className="liveLines">
              <span>Bet365 HT snapshot</span>
              <b>
                G {totalPrice(match.liveGoalLine, match.liveGoalOverOdd, match.liveGoalUnderOdd)}
                {' · '}C {totalPrice(match.liveCornerLine, match.liveCornerOverOdd, match.liveCornerUnderOdd)}
              </b>
            </div>
          )}

          {!unverifiedHt && (match.redCardsHome != null || match.redCardsAway != null) && (
            <div className="liveLines">
              <span>Red cards</span>
              <b>{match.redCardsHome ?? 0} - {match.redCardsAway ?? 0}</b>
            </div>
          )}

          {(match.h2ActualGoals != null || match.h2ActualCorners != null) && (
            <div className="liveLines">
              <span>H2 actual</span>
              <b>Goals {match.h2ActualGoals ?? '—'} · Corners {match.h2ActualCorners ?? '—'}</b>
            </div>
          )}

          {!unverifiedHt && evaluateMethodOutcomes(match).length > 0 && (
            <div className="htAdvice">
              <div className="htAdviceTop">
                <span>METHOD RESULT</span>
                <b>{evaluateMethodOutcomes(match).some(o => o.status === 'SUCCESS') ? 'CHECKED' : 'PENDING / CHECKED'}</b>
              </div>
              {evaluateMethodOutcomes(match).map((o, i) => (
                <div key={`method-${o.market}-${i}`} className="liveLines">
                  <span>{o.market.replace(/_/g, ' ')}</span>
                  <b>{o.status}</b>
                  <small>
                    {o.market === 'H2_CORNERS' ? 'FT corners' : 'H2 goals'} {o.actual ?? '—'} · Bet365 line {o.benchmarkLine || '—'}
                  </small>
                </div>
              ))}
            </div>
          )}

          {!unverifiedHt && (match.h2Predictions ?? []).length > 0 && (
            <div className="htAdvice">
              <div className="htAdviceTop">
                <span>H2 RESEARCH RECORD</span>
                <b>{reliableFt ? 'GRADED' : match.researchPhase === 'FT' ? 'UNVERIFIED FT' : 'PENDING FT'}</b>
              </div>
              {(match.h2Predictions ?? []).map((p, i) => (
                <div key={`${p.market}-${i}`} className="liveLines">
                  <span>{p.market.replace(/_/g, ' ')}</span>
                  <b>
                    {p.active ? `OVER ${p.line ?? '—'}` : `RESEARCH ONLY · line ${p.line ?? '—'}`}
                    {p.grade && p.grade !== 'PENDING' ? ` · ${p.grade.replace(/_/g, ' ')}` : ''}
                  </b>
                  {p.actual != null && <small>Actual H2: {p.actual}</small>}
                </div>
              ))}
            </div>
          )}

          {match.htAction && (
            <div className="htAdvice">
              {(verifiedHt || manualHt) && (
                <small>HT source: {match.htSourceSummary ?? (manualHt ? 'MANUAL INPUT' : 'API-Football')}</small>
              )}
              <div className="htAdviceTop">
                <span>HT DECISION</span>
                <b>{unverifiedHt ? 'UNVERIFIED · DISABLED' : match.htAction.replace(/_/g, ' ')}</b>
              </div>
              {unverifiedHt
                ? <p>Previous GPT-based HT decision is withdrawn. Verify the correct HT score and corners before using V1.</p>
                : match.htAdvice && <p>{match.htAdvice}</p>}
              {!unverifiedHt && match.htConfidence && <small>Confidence: {match.htConfidence}</small>}
              {!unverifiedHt && match.htEvaluationType && <small>Record type: {match.htEvaluationType.replace(/_/g, ' ')}</small>}
              {!unverifiedHt && match.h2GoalsAssessment && <small>H2 Goals: {match.h2GoalsAssessment.replace(/_/g, ' ')}</small>}
              {!unverifiedHt && match.h2CornersAssessment && <small>H2 Corners: {match.h2CornersAssessment.replace(/_/g, ' ')}</small>}
              {!unverifiedHt && match.htDataNote && <p className="htDataNote">{match.htDataNote}</p>}
              {(match.htMissingInputs ?? []).length > 0 && (
                <small>Missing: {(match.htMissingInputs ?? []).join(', ')}</small>
              )}
              {(match.htSourceUrls ?? []).slice(0,2).map((url, i) => (
                <a key={url+i} href={url} target="_blank" rel="noreferrer">HT source {i + 1}</a>
              ))}
              {(match.ftSourceUrls ?? []).slice(0,2).map((url, i) => (
                <a key={`ft-${url}-${i}`} href={url} target="_blank" rel="noreferrer">FT source {i + 1}</a>
              ))}
            </div>
          )}

          {onCheckpoint && match.status !== 'FT' && (
            <button className="checkBtn" onClick={() => onCheckpoint(match)}>Manual Check</button>
          )}
        </>
      )}
    </article>
  );
}
