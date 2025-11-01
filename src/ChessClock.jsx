import React, { useState, useEffect, useRef } from 'react'

// Utility: safe parse int from localStorage
const readMs = (key) => {
  const v = localStorage.getItem(key)
  return v ? parseInt(v, 10) : null
}

const writeMs = (key, val) => {
  try {
    localStorage.setItem(key, String(val))
  } catch (e) {
    // ignore quota issues
  }
}

const ChessClock = ({ gameStarted, currentPlayer, isGameOver, onTimeOut, isLocal = false, localPlayer = null, initialTimeMinutes = null, gameId = 'local', gameRef = null, canSetInitial = false, onSetInitial = null }) => {
  const [timeInput, setTimeInput] = useState(initialTimeMinutes) // minutes
  const [whiteTime, setWhiteTime] = useState(null)
  const [blackTime, setBlackTime] = useState(null)

  // For local multi-tab sync: subscribed current turn (can come from localStorage)
  const [syncedCurrent, setSyncedCurrent] = useState(currentPlayer)

  const intervalRef = useRef(null)
  // Use refs to store time values to avoid recreating interval on every update
  const whiteTimeRef = useRef(null)
  const blackTimeRef = useRef(null)
  const onTimeOutRef = useRef(onTimeOut)
  const gameRefRef = useRef(gameRef)
  
  // Keep refs in sync
  useEffect(() => {
    whiteTimeRef.current = whiteTime
    blackTimeRef.current = blackTime
    onTimeOutRef.current = onTimeOut
    gameRefRef.current = gameRef
  }, [whiteTime, blackTime, onTimeOut, gameRef])

  // keys per game to avoid cross-game interference
  const prefix = `rc_${gameId}`
  const KEY_WHITE = `${prefix}_whiteTime`
  const KEY_BLACK = `${prefix}_blackTime`
  const KEY_CURRENT = `${prefix}_currentPlayer`
  const KEY_INITIAL = `${prefix}_initialMinutes`

  // If another tab already set the initial minutes, reflect it in the setup UI immediately
  useEffect(() => {
    if (!isLocal) return
    const stored = readMs(KEY_INITIAL)
    if (stored != null) setTimeInput(stored)
  }, [isLocal, KEY_INITIAL])

  // Initialize timers when game starts
  useEffect(() => {
    if (!gameStarted) return

    // check if an initial minutes value was already persisted for this game
    const storedInitial = readMs(KEY_INITIAL)
    const minutesToUse = storedInitial != null ? storedInitial : (initialTimeMinutes || timeInput)
    // initial time in ms (from prop, stored initial, or the timeInput state)
    const initialMs = minutesToUse * 60 * 1000

    if (isLocal) {
      // If other tab already created timers, pick them up
      const w = readMs(KEY_WHITE)
      const b = readMs(KEY_BLACK)
      const cur = localStorage.getItem(KEY_CURRENT)

      // If no stored initial exists but a prop initialTimeMinutes is provided, persist it
      if (storedInitial == null && initialTimeMinutes) {
        writeMs(KEY_INITIAL, initialTimeMinutes)
      }

      if (w == null || b == null) {
        // initialize storage for all tabs
        writeMs(KEY_WHITE, initialMs)
        writeMs(KEY_BLACK, initialMs)
        // Default to White's turn when game starts (before first move)
        const defaultPlayer = currentPlayer || 'w'
        if (!cur) localStorage.setItem(KEY_CURRENT, defaultPlayer)
        setWhiteTime(initialMs)
        setBlackTime(initialMs)
        setSyncedCurrent(defaultPlayer)
      } else {
        setWhiteTime(w)
        setBlackTime(b)
        setSyncedCurrent(cur || currentPlayer || 'w')
      }

    } else {
      // Non-local: initialize from Firebase or use default
      const initializeFromFirebase = async () => {
        if (gameRef) {
          try {
            const gameDoc = await gameRef.get()
            const gameData = gameDoc.data()
            if (gameData && (gameData.whiteTime != null || gameData.blackTime != null)) {
              // Clock times already exist in Firebase, use them
              setWhiteTime(gameData.whiteTime || initialMs)
              setBlackTime(gameData.blackTime || initialMs)
              setSyncedCurrent(gameData.currentPlayer || currentPlayer || 'w')
            } else {
              // Initialize clock times in Firebase
              const defaultPlayer = currentPlayer || 'w'
              setWhiteTime(initialMs)
              setBlackTime(initialMs)
              setSyncedCurrent(defaultPlayer)
              await gameRef.update({
                whiteTime: initialMs,
                blackTime: initialMs,
                currentPlayer: defaultPlayer
              })
            }
          } catch (e) {
            console.error('Failed to initialize from Firebase', e)
            // Fallback to local state
            const defaultPlayer = currentPlayer || 'w'
            setWhiteTime(initialMs)
            setBlackTime(initialMs)
            setSyncedCurrent(defaultPlayer)
          }
        } else {
          // No gameRef, use local state
          const defaultPlayer = currentPlayer || 'w'
          setWhiteTime(initialMs)
          setBlackTime(initialMs)
          setSyncedCurrent(defaultPlayer)
        }
      }
      initializeFromFirebase()
    }
  }, [gameStarted, initialTimeMinutes, gameId, gameRef])

  // Keep syncedCurrent in sync with incoming prop (non-local authoritative)
  useEffect(() => {
    if (!isLocal) {
      // For remote games, currentPlayer prop is authoritative
      if (currentPlayer) {
        setSyncedCurrent(currentPlayer)
        // Update Firebase with current player
        if (gameRef) {
          gameRef.update({ currentPlayer }).catch(e => console.error('Failed to update currentPlayer', e))
        }
      } else {
        // Default to White when game starts
        const defaultPlayer = 'w'
        setSyncedCurrent(defaultPlayer)
        if (gameRef && gameStarted) {
          gameRef.update({ currentPlayer: defaultPlayer }).catch(e => console.error('Failed to update currentPlayer', e))
        }
      }
    } else if (currentPlayer) {
      // if remote/local game logic reports a turn change, publish it to storage so other tabs pick up
      try {
        const stored = localStorage.getItem(KEY_CURRENT)
        if (stored !== currentPlayer) {
          localStorage.setItem(KEY_CURRENT, currentPlayer)
          setSyncedCurrent(currentPlayer)
        }
      } catch (e) {}
    }
  }, [currentPlayer, isLocal, gameRef, gameStarted])

  // Listen to storage events to sync between tabs (local only)
  useEffect(() => {
    if (!isLocal) return
    const handler = (e) => {
      if (!e.key) return
      if (e.key === KEY_WHITE) {
        const v = e.newValue ? parseInt(e.newValue, 10) : null
        setWhiteTime(v)
      }
      if (e.key === KEY_BLACK) {
        const v = e.newValue ? parseInt(e.newValue, 10) : null
        setBlackTime(v)
      }
      if (e.key === KEY_CURRENT) {
        setSyncedCurrent(e.newValue)
      }
      if (e.key === KEY_INITIAL) {
        // if initial changes, we could re-init – ignore for now
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [isLocal, KEY_WHITE, KEY_BLACK, KEY_CURRENT, KEY_INITIAL])

  // Listen to Firebase updates for remote games (clock times and current player)
  useEffect(() => {
    if (isLocal || !gameRef || !gameStarted) return

    // Firebase v8 API: use .onSnapshot() on the document reference
    const unsubscribe = gameRef.onSnapshot((doc) => {
      if (!doc.exists) return
      const gameData = doc.data()
      
      // Update clock times from Firebase (only if they differ significantly to avoid unnecessary updates)
      if (gameData.whiteTime != null) {
        setWhiteTime(prev => {
          // Only update if the difference is significant (more than 500ms) to avoid flicker
          const diff = Math.abs((prev || 0) - gameData.whiteTime)
          return diff > 500 ? gameData.whiteTime : prev
        })
      }
      if (gameData.blackTime != null) {
        setBlackTime(prev => {
          // Only update if the difference is significant (more than 500ms) to avoid flicker
          const diff = Math.abs((prev || 0) - gameData.blackTime)
          return diff > 500 ? gameData.blackTime : prev
        })
      }
      
      // Update current player from Firebase
      if (gameData.currentPlayer && gameData.currentPlayer !== syncedCurrent) {
        setSyncedCurrent(gameData.currentPlayer)
      }
    }, (error) => {
      console.error('Firebase snapshot error:', error)
    })

    return () => unsubscribe()
  }, [isLocal, gameRef, gameStarted, syncedCurrent])

  // When syncedCurrent changes, start/stop the running interval depending on whether this tab should run
  useEffect(() => {
    // clear any previous interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    if (isGameOver) {
      // Stop both clocks when game is over
      return
    }

    // For local games: only run timer if it's the local player's turn
    // For remote games: run timer if it's any player's turn (we'll sync via Firebase)
    const shouldRunBase = isLocal ? (localPlayer && syncedCurrent === localPlayer) : (syncedCurrent === 'w' || syncedCurrent === 'b')
    const shouldRun = gameStarted && shouldRunBase

    if (shouldRun) {
      // Store the current player for the interval closure
      const activePlayer = syncedCurrent
      
      intervalRef.current = setInterval(() => {
        // Use refs to access latest values without recreating interval
        const currentWhite = whiteTimeRef.current
        const currentBlack = blackTimeRef.current
        const currentGameRef = gameRefRef.current
        const currentOnTimeOut = onTimeOutRef.current
        
        // decrement the correct clock
        if (isLocal) {
          // read latest from storage to avoid drift
          const wNow = readMs(KEY_WHITE)
          const bNow = readMs(KEY_BLACK)
          // pick current values
          let w = wNow != null ? wNow : (currentWhite != null ? currentWhite : 0)
          let b = bNow != null ? bNow : (currentBlack != null ? currentBlack : 0)

          if (localPlayer === 'w' && activePlayer === 'w') {
            w = w - 1000
            if (w <= 0) {
              writeMs(KEY_WHITE, 0)
              setWhiteTime(0)
              // Stop both clocks on timeout
              if (intervalRef.current) {
                clearInterval(intervalRef.current)
                intervalRef.current = null
              }
              if (currentOnTimeOut) currentOnTimeOut('white')
              return
            }
            writeMs(KEY_WHITE, w)
            setWhiteTime(w)
          } else if (localPlayer === 'b' && activePlayer === 'b') {
            b = b - 1000
            if (b <= 0) {
              writeMs(KEY_BLACK, 0)
              setBlackTime(0)
              // Stop both clocks on timeout
              if (intervalRef.current) {
                clearInterval(intervalRef.current)
                intervalRef.current = null
              }
              if (currentOnTimeOut) currentOnTimeOut('black')
              return
            }
            writeMs(KEY_BLACK, b)
            setBlackTime(b)
          }
        } else {
          // Remote game: update local state and sync to Firebase
          if (activePlayer === 'w') {
            const currentTime = currentWhite != null ? currentWhite : 0
            const next = currentTime - 1000
            if (next <= 0) {
              // Stop both clocks on timeout
              if (intervalRef.current) {
                clearInterval(intervalRef.current)
                intervalRef.current = null
              }
              // Update Firebase to stop clocks
              if (currentGameRef) {
                currentGameRef.update({ whiteTime: 0, currentPlayer: null }).catch(e => console.error('Failed to update timeout', e))
              }
              setWhiteTime(0)
              if (currentOnTimeOut) currentOnTimeOut('white')
            } else {
              setWhiteTime(next)
              // Update Firebase with new time every second
              if (currentGameRef) {
                currentGameRef.update({ whiteTime: next }).catch(e => console.error('Failed to update whiteTime', e))
              }
            }
          } else if (activePlayer === 'b') {
            const currentTime = currentBlack != null ? currentBlack : 0
            const next = currentTime - 1000
            if (next <= 0) {
              // Stop both clocks on timeout
              if (intervalRef.current) {
                clearInterval(intervalRef.current)
                intervalRef.current = null
              }
              // Update Firebase to stop clocks
              if (currentGameRef) {
                currentGameRef.update({ blackTime: 0, currentPlayer: null }).catch(e => console.error('Failed to update timeout', e))
              }
              setBlackTime(0)
              if (currentOnTimeOut) currentOnTimeOut('black')
            } else {
              setBlackTime(next)
              // Update Firebase with new time every second
              if (currentGameRef) {
                currentGameRef.update({ blackTime: next }).catch(e => console.error('Failed to update blackTime', e))
              }
            }
          }
        }
      }, 1000)
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
    // Remove whiteTime and blackTime from dependencies - we use refs instead
    // Only recreate interval when syncedCurrent, gameStarted, or isGameOver changes
  }, [syncedCurrent, isLocal, localPlayer, isGameOver, gameStarted])

  // Format time for display (mm:ss)
  const formatTime = (timeInMs) => {
    if (timeInMs === null) return '--:--'
    const totalSeconds = Math.floor(timeInMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  // Predefined time options UI (unchanged)
  const timePresets = [1, 3, 5, 10, 15, 30]

  // Time setup UI (only shown if game not started AND this tab/player can set initial AND no initial persisted)
  if (!gameStarted) {
    const storedInitial = isLocal ? readMs(KEY_INITIAL) : null
    const initialPresent = storedInitial != null || initialTimeMinutes != null
    if (canSetInitial && !initialPresent) {
      return (
        <div className="chess-clock-setup">
          <h3>Select Time Control</h3>
          <div className="time-presets">
            {timePresets.map(mins => (
              <button
                key={mins}
                className={`time-preset-btn ${timeInput === mins ? 'selected' : ''}`}
                onClick={() => {
                  setTimeInput(mins)
                  if (isLocal) writeMs(KEY_INITIAL, mins)
                  if (onSetInitial) onSetInitial(mins)
                }}
              >
                {mins} min
              </button>
            ))}
          </div>
          <div className="custom-time">
            <label>
              Custom time (1-60 min):
              <input
                type="number"
                min="1"
                max="60"
                value={timeInput || ''}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(60, parseInt(e.target.value) || 1))
                  setTimeInput(v)
                  if (isLocal) writeMs(KEY_INITIAL, v)
                  if (onSetInitial) onSetInitial(v)
                }}
              />
            </label>
          </div>
        </div>
      )
    }
    // else: initial already present or this tab cannot set — show static clocks with initial time (paused)
    const displayWhiteStatic = storedInitial != null ? storedInitial * 60 * 1000 : (initialTimeMinutes != null ? initialTimeMinutes * 60 * 1000 : (whiteTime || null))
    const displayBlackStatic = storedInitial != null ? storedInitial * 60 * 1000 : (initialTimeMinutes != null ? initialTimeMinutes * 60 * 1000 : (blackTime || null))
    return (
      <>
        <div className={`chess-clock black ${syncedCurrent === 'b' ? 'active' : ''}`} aria-label="Black clock">
          {formatTime(displayBlackStatic)}
        </div>
        <div className={`chess-clock white ${syncedCurrent === 'w' ? 'active' : ''}`} aria-label="White clock">
          {formatTime(displayWhiteStatic)}
        </div>
      </>
    )
  }

  const isLowTime = (time) => time !== null && time <= 30000

  // When not local, we still may want to show the clock values
  const displayWhite = isLocal ? (whiteTime != null ? whiteTime : readMs(KEY_WHITE)) : whiteTime
  const displayBlack = isLocal ? (blackTime != null ? blackTime : readMs(KEY_BLACK)) : blackTime

  return (
    <>
      <div
        className={`chess-clock black ${syncedCurrent === 'b' ? 'active' : ''} ${isLowTime(displayBlack) ? 'low-time' : ''}`}
        aria-label="Black clock"
      >
        {formatTime(displayBlack)}
      </div>
      <div
        className={`chess-clock white ${syncedCurrent === 'w' ? 'active' : ''} ${isLowTime(displayWhite) ? 'low-time' : ''}`}
        aria-label="White clock"
      >
        {formatTime(displayWhite)}
      </div>
    </>
  )
}

export default ChessClock