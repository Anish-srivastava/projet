import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import './App.css'
import { gameSubject, initGame, resetGame, endGameByTimeout } from './Game'
import Board from './Board'
import ChessClock from './ChessClock'
import { useParams, useHistory, useLocation } from 'react-router-dom'
import { db } from './firebase'

function GameApp() {
  const [board, setBoard] = useState([])
  const [isGameOver, setIsGameOver] = useState()
  const [result, setResult] = useState()
  const [position, setPosition] = useState()
  const [initResult, setInitResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [game, setGame] = useState({})
  const [moveHistory, setMoveHistory] = useState([])
  const [gameStartedClock, setGameStartedClock] = useState(false)
  // Track the last move that was added to history to prevent duplicates
  const lastProcessedMoveRef = useRef(null)
  const { id } = useParams()
  const history = useHistory()
  const location = useLocation()
  // determine initial time (minutes) for this game from query param `t` or game data
  const query = new URLSearchParams(location.search)
  const queryT = query.get('t')
  const initialTimeFromQuery = queryT ? parseInt(queryT, 10) : null
  // if query param provided use it; otherwise undefined so creator must set
  const initialTimeMinutes = initialTimeFromQuery != null ? initialTimeFromQuery : null
  const sharebleLink = window.location.href
  useEffect(() => {
    let subscribe
    async function init() {
      const res = await initGame(id !== 'local' ? db.doc(`games/${id}`) : null)
      setInitResult(res)
      setLoading(false)
      if (!res) {
        // reset move history when subscribing to a game
        setMoveHistory([])
        lastProcessedMoveRef.current = null
        subscribe = gameSubject.subscribe((game) => {
          setBoard(game.board)
          setIsGameOver(game.isGameOver)
          setResult(game.result)
          setPosition(game.position)
          setStatus(game.status)
          setGame(game)

          // Auto-start clock when game is ready and initial time is set
          // For remote games: when status is 'ready' and initialMinutes is set
          // For local games: when initialMinutes is set (from query param or setup)
          if (!gameStartedClock && game.status === 'ready' && (game.initialMinutes != null || initialTimeMinutes != null)) {
            setGameStartedClock(true)
          } else if (!gameStartedClock && id === 'local' && (game.initialMinutes != null || initialTimeMinutes != null)) {
            setGameStartedClock(true)
          }

          // Only add move to history if it's a new valid move that hasn't been processed
          if (game.lastMove) {
            const m = game.lastMove
            // Create a unique identifier for this move (from + to + san if available)
            const moveId = `${m.from}:${m.to}:${m.san || ''}`
            
            // Only process if this is a different move than the last one we processed
            if (lastProcessedMoveRef.current !== moveId) {
              lastProcessedMoveRef.current = moveId
              const moveObj = {
                player: m.color === 'w' ? 'White' : 'Black',
                from: m.from,
                to: m.to,
                san: m.san || null
              }
              setMoveHistory(prev => {
                // Additional check: ensure this move isn't already in history
                const isDuplicate = prev.some(existing => 
                  existing.from === moveObj.from && 
                  existing.to === moveObj.to &&
                  existing.player === moveObj.player
                )
                if (isDuplicate) {
                  return prev
                }
                return [...prev, moveObj]
              })
            }
          }
        })

      }

    }

    init()

    return () => subscribe && subscribe.unsubscribe()
  }, [id])

  // Memoize handleTimeOut to prevent ChessClock from re-rendering
  // MUST be called before any early returns (Rules of Hooks)
  const handleTimeOut = useCallback((player) => {
    // Stop both clocks and end game
    endGameByTimeout(player)
    setIsGameOver(true)
    setResult(`Time over! ${player === 'white' ? 'Black' : 'White'} wins!`)
  }, [])

  // Memoize onSetInitial callback
  // MUST be called before any early returns (Rules of Hooks)
  const handleSetInitial = useCallback(async (mins) => {
    // persist creator-chosen initial minutes to backend for remote games
    if (id && id !== 'local') {
      try {
        await db.doc(`games/${id}`).update({ initialMinutes: mins })
      } catch (e) {
        console.error('Failed to persist initial minutes', e)
      }
    } else {
      // local mode: ChessClock already writes to localStorage
    }
  }, [id])

  // Memoize move list to avoid recalculating on every render
  // MUST be called before any early returns (Rules of Hooks)
  const moveHistoryRows = useMemo(() => {
    const rows = []
    for (let i = 0; i < moveHistory.length; i += 2) {
      const white = moveHistory[i]
      const black = moveHistory[i + 1]
      rows.push({ number: Math.floor(i / 2) + 1, white, black })
    }
    return rows
  }, [moveHistory])

  // Helper to render move list grouped by move number
  // MUST be called before any early returns (Rules of Hooks)
  const renderMoveList = useCallback(() => {
    return (
      <div className="move-history">
        <h3>Move History</h3>
        <div className="move-list">
          {moveHistoryRows.map((r, idx) => (
            <div key={idx} className="move-row">
              <div className="move-number">{r.number}.</div>
              <div className="move-pair">
                {r.white ? (
                  <div className={`move-item ${idx === moveHistoryRows.length - 1 && moveHistory.length % 2 === 1 ? 'latest' : ''}`}>
                    <span className="player">White:</span> {r.white.from} → {r.white.to}
                  </div>
                ) : <div className="move-item empty" />}
                {r.black ? (
                  <div className={`move-item ${idx === moveHistoryRows.length - 1 && moveHistory.length % 2 === 0 ? 'latest' : ''}`}>
                    <span className="player">Black:</span> {r.black.from} → {r.black.to}
                  </div>
                ) : <div className="move-item empty" />}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }, [moveHistoryRows, moveHistory.length])

  async function copyToClipboard() {
    await navigator.clipboard.writeText(sharebleLink)
  }

  // Early returns AFTER all hooks have been called
  if (loading) {
    return 'Loading ...'
  }
  if (initResult === 'notfound') {
    return 'Game Not found'
  }

  if (initResult === 'intruder') {
    return 'The game is already full'
  }

  return (
    <div className="app-container">
      {isGameOver && (
        <h2 className="vertical-text">
          GAME OVER
          <button onClick={async () => {
            await resetGame()
            // Reset move history tracking when starting a new game
            setMoveHistory([])
            lastProcessedMoveRef.current = null
            history.push('/')
          }}>
            <span className="vertical-text"> NEW GAME</span>
          </button>
        </h2>
      )}
      <div className="play-area">
        {renderMoveList()}

        <div className="board-container">
          {game.oponent && game.oponent.name && <span className="tag is-link">{game.oponent.name}</span>}
          
          {/* board-wrapper holds the board centered */}
          <div className="board-wrapper">
            <Board board={board} position={position} />
          </div>

          {game.member && game.member.name && <span className="tag is-link">{game.member.name}</span>}
        </div>

        {/* clock-column sits to the right of the board and contains both clocks stacked top/bottom */}
        <div className="clock-column">
          {status !== 'waiting' && (
            <ChessClock
                gameStarted={gameStartedClock}
                currentPlayer={game.currentPlayer}
                isGameOver={isGameOver}
                onTimeOut={handleTimeOut}
                isLocal={id === 'local'}
                localPlayer={position}
                // prefer persisted game.initialMinutes, then query param
                initialTimeMinutes={game.initialMinutes != null ? game.initialMinutes : initialTimeMinutes}
                gameId={id || 'local'}
                gameRef={id !== 'local' ? db.doc(`games/${id}`) : null}
                canSetInitial={id === 'local' ? true : (game.member && game.member.creator)}
                onSetInitial={handleSetInitial}
              />
          )}
        </div>
      </div>
      {result && <p className="vertical-text">{result}</p>}
      {status === 'waiting' && (
        <div className="notification is-link share-game">
          <strong>Share this game to continue</strong>
          <br />
          <br />
          <div className="field has-addons">
            <div className="control is-expanded">
              <input type="text" name="" id="" className="input" readOnly value={sharebleLink} />
            </div>
            <div className="control">
              <button className="button is-info" onClick={copyToClipboard}>Copy</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default GameApp
