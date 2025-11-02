import React, { useEffect, useRef, useState } from 'react'
import './ChessClock.css'

/*
  Revised ChessClock
  - Keeps independent countdowns for White and Black (ms precision)
  - Only the owning client (see `localPlayer` prop) ticks the active clock
  - Supports local multi-tab mode (basic owner election using session/tab id)
  - Supports remote mode via `gameRef` (Firestore doc) with snapshot updates
  - Exposes `onTimeOut(loserColor)` callback when a clock reaches zero
  - Supports `perspective` prop to render top/bottom clock order

  Props (keeps compatibility with earlier interface but clarifies behavior):
    - gameStarted (bool)     : whether the game has started
    - currentPlayer ('w'|'b'): authoritative turn value when available (from Game.js)
    - isGameOver (bool)      : whether the game is finished (stops clocks)
    - onTimeOut(fn)          : called with 'w' or 'b' when a player's time runs out
    - isLocal (bool)         : whether we run in local multi-tab mode (uses localStorage)
    - localPlayer ('w'|'b')  : which side this client controls (if any). When set, only this
                               client will decrement the active clock for its side.
    - initialTimeMinutes     : initial minutes per player (fallback)
    - gameId (string)        : used as localStorage key prefix
    - gameRef                : optional Firebase doc ref for remote games (v8 style .onSnapshot/.update)
    - canSetInitial, onSetInitial: UI helpers for pre-start time selection (kept for compatibility)
    - perspective ('white'|'black'): which side is shown on the bottom for this client
*/

const SYNC_INTERVAL = 100 // ms between sync writes to storage/Firebase
const LOW_TIME_THRESHOLD = 30 * 1000 // 30s, for low-time UI if desired

// simple localStorage helpers
const readMs = (key) => {
  try {
    const v = localStorage.getItem(key)
    return v == null ? null : parseInt(v, 10)
  } catch (e) {
    return null
  }
}
const writeMs = (key, v) => {
  try { localStorage.setItem(key, String(v)) } catch (e) {}
}

export default function ChessClock({
  gameStarted,
  currentPlayer,
  isGameOver,
  onTimeOut = () => {},
  isLocal = false,
  localPlayer = null,
  initialTimeMinutes = 5,
  gameId = 'local',
  gameRef = null,
  canSetInitial = false,
  onSetInitial = null,
  perspective = 'white'
}) {
  // state shown to UI
  const [whiteTime, setWhiteTime] = useState(null)
  const [blackTime, setBlackTime] = useState(null)
  const [syncedCurrent, setSyncedCurrent] = useState(currentPlayer || 'w')

  // refs for accurate timing without re-subscribing
  const rafRef = useRef(null)
  const lastTsRef = useRef(null)
  const lastSyncRef = useRef(0)
  const whiteRef = useRef(null)
  const blackRef = useRef(null)
  const onTimeOutRef = useRef(onTimeOut)
  const gameRefRef = useRef(gameRef)
  // last-remote values + timestamp used by non-owner tabs to interpolate
  const lastRemoteAtRef = useRef(null)
  const lastRemoteWhiteRef = useRef(null)
  const lastRemoteBlackRef = useRef(null)

  // persist refs when props change
  useEffect(() => { onTimeOutRef.current = onTimeOut }, [onTimeOut])
  useEffect(() => { gameRefRef.current = gameRef }, [gameRef])

  // storage keys
  const prefix = `rc_${gameId}`
  const KEY_WHITE = `${prefix}_whiteTime`
  const KEY_BLACK = `${prefix}_blackTime`
  const KEY_CURRENT = `${prefix}_currentPlayer`
  const KEY_INITIAL = `${prefix}_initialMinutes`

  // Tab identity (for basic owner election in local multi-tab mode)
  const tabIdRef = useRef(null)
  useEffect(() => {
    let id = sessionStorage.getItem('rc_tab_id')
    if (!id) {
      id = Math.random().toString(36).slice(2)
      sessionStorage.setItem('rc_tab_id', id)
    }
    tabIdRef.current = id
  }, [])

  // BroadcastChannel for fast cross-tab sync when available (local mode)
  const channelRef = useRef(null)
  useEffect(() => {
    if (!isLocal) return
    try {
      if ('BroadcastChannel' in window) {
        channelRef.current = new BroadcastChannel(`rc_channel_${gameId}`)
        // Handle incoming broadcast messages (fast cross-tab sync)
        channelRef.current.onmessage = (ev) => {
          try {
            const msg = ev.data
            if (!msg) return
            // tick message: update times and current player immediately
            if (msg.type === 'tick' || msg.type === 'snapshot') {
              const now = performance.now()
              if (typeof msg.whiteTime === 'number') {
                setWhiteTime(msg.whiteTime)
                lastRemoteWhiteRef.current = msg.whiteTime
              }
              if (typeof msg.blackTime === 'number') {
                setBlackTime(msg.blackTime)
                lastRemoteBlackRef.current = msg.blackTime
              }
              if (msg.currentPlayer) setSyncedCurrent(msg.currentPlayer)
              lastRemoteAtRef.current = now
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      channelRef.current = null
    }

    return () => {
      try { if (channelRef.current) channelRef.current.close() } catch (e) {}
      channelRef.current = null
    }
  }, [isLocal, gameId])

  // Initialize times when game starts (either from localStorage or Firebase or fallback)
  useEffect(() => {
    if (!gameStarted) return

    const initialMs = Math.round((initialTimeMinutes || 5) * 60 * 1000)

    if (isLocal) {
      // read values from storage if present
      const w = readMs(KEY_WHITE)
      const b = readMs(KEY_BLACK)
      const cur = localStorage.getItem(KEY_CURRENT)
      const storedInitial = readMs(KEY_INITIAL)
      if (storedInitial == null) writeMs(KEY_INITIAL, initialTimeMinutes)

      if (w == null || b == null) {
        writeMs(KEY_WHITE, initialMs)
        writeMs(KEY_BLACK, initialMs)
        localStorage.setItem(KEY_CURRENT, currentPlayer || 'w')
        setWhiteTime(initialMs)
        setBlackTime(initialMs)
        setSyncedCurrent(currentPlayer || 'w')
        lastRemoteWhiteRef.current = initialMs
        lastRemoteBlackRef.current = initialMs
        lastRemoteAtRef.current = performance.now()
      } else {
        setWhiteTime(w)
        setBlackTime(b)
        setSyncedCurrent(cur || currentPlayer || 'w')
        lastRemoteWhiteRef.current = w
        lastRemoteBlackRef.current = b
        lastRemoteAtRef.current = performance.now()
      }
    } else {
      // remote: ask Firebase doc for existing times, else initialize it
      const initRemote = async () => {
        if (!gameRef) {
          setWhiteTime(initialMs)
          setBlackTime(initialMs)
          setSyncedCurrent(currentPlayer || 'w')
          return
        }
        try {
          const doc = await gameRef.get()
          if (doc && doc.exists) {
            const data = doc.data()
            const wv = data.whiteTime != null ? data.whiteTime : initialMs
            const bv = data.blackTime != null ? data.blackTime : initialMs
            setWhiteTime(wv)
            setBlackTime(bv)
            setSyncedCurrent(data.currentPlayer || currentPlayer || 'w')
            lastRemoteWhiteRef.current = wv
            lastRemoteBlackRef.current = bv
            lastRemoteAtRef.current = performance.now()
          } else {
            setWhiteTime(initialMs)
            setBlackTime(initialMs)
            setSyncedCurrent(currentPlayer || 'w')
            lastRemoteWhiteRef.current = initialMs
            lastRemoteBlackRef.current = initialMs
            lastRemoteAtRef.current = performance.now()
            await gameRef.update({ whiteTime: initialMs, blackTime: initialMs, currentPlayer: currentPlayer || 'w' })
          }
        } catch (e) {
          console.error('ChessClock: firebase init failed', e)
          setWhiteTime(initialMs)
          setBlackTime(initialMs)
          setSyncedCurrent(currentPlayer || 'w')
        }
      }
      initRemote()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameStarted])

  // Keep syncedCurrent in sync with incoming prop if provided
  useEffect(() => {
    if (currentPlayer) setSyncedCurrent(currentPlayer)
  }, [currentPlayer])

  // Listen to localStorage changes (other tabs) when in local mode
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isLocal) return
    const onStorage = (e) => {
      if (!e.key) return
      if (e.key === KEY_WHITE) setWhiteTime(e.newValue ? parseInt(e.newValue, 10) : null)
      if (e.key === KEY_BLACK) setBlackTime(e.newValue ? parseInt(e.newValue, 10) : null)
      if (e.key === KEY_CURRENT) setSyncedCurrent(e.newValue)
      // record remote-received values so non-owner can interpolate
      try {
        const now = performance.now()
        if (e.key === KEY_WHITE && e.newValue) lastRemoteWhiteRef.current = parseInt(e.newValue, 10)
        if (e.key === KEY_BLACK && e.newValue) lastRemoteBlackRef.current = parseInt(e.newValue, 10)
        if (e.key === KEY_WHITE || e.key === KEY_BLACK) lastRemoteAtRef.current = now
      } catch (err) {}
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [isLocal])

  // Listen to Firebase snapshots to keep UI in sync with authoritative remote state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!gameRef || isLocal) return
    let unsub = null
    try {
      unsub = gameRef.onSnapshot(doc => {
        if (!doc.exists) return
        const d = doc.data()
        // Immediately apply authoritative times from server and record timestamp so
        // non-owner clients can locally interpolate the ticking clock between updates.
        if (d.whiteTime != null) {
          setWhiteTime(d.whiteTime)
          lastRemoteWhiteRef.current = d.whiteTime
        }
        if (d.blackTime != null) {
          setBlackTime(d.blackTime)
          lastRemoteBlackRef.current = d.blackTime
        }
        if (d.currentPlayer && d.currentPlayer !== syncedCurrent) setSyncedCurrent(d.currentPlayer)
        lastRemoteAtRef.current = performance.now()
        // broadcast snapshot to other local tabs for immediate UI sync (if available)
        try {
          if (isLocal && channelRef.current) channelRef.current.postMessage({ type: 'snapshot', whiteTime: d.whiteTime, blackTime: d.blackTime, currentPlayer: d.currentPlayer })
        } catch (e) {}
      }, err => console.error('ChessClock snapshot err', err))
    } catch (e) {
      console.error('ChessClock: snapshot subscribe failed', e)
    }
    return () => { if (unsub) unsub() }
  }, [gameRef, isLocal])

  // optimistic local turn flip handler (Game.js can dispatch a move-made event for snappy UI)
  useEffect(() => {
    const handler = (e) => {
      try {
        const nx = e && e.detail && e.detail.currentPlayer
        if (nx) setSyncedCurrent(nx)
      } catch (e) {}
    }
    window.addEventListener('move-made', handler)
    return () => window.removeEventListener('move-made', handler)
  }, [])

  // determine whether THIS client should run the ticking loop
  // - if `localPlayer` is set, only that player client should tick when it's their turn
  // - otherwise, in local multi-tab mode we elect a basic owner tab to avoid duplicate ticking
  const amOwnerRef = useRef(false)
  useEffect(() => {
    if (localPlayer) {
      amOwnerRef.current = true // this client is a player and is allowed to tick its side when active
      return
    }
    if (!isLocal) {
      amOwnerRef.current = false
      return
    }
    // basic local owner election: first tab to set owner key becomes owner
    const ownerKey = `${prefix}_owner`
    const tabId = tabIdRef.current
    try {
      const owner = localStorage.getItem(ownerKey)
      if (!owner) localStorage.setItem(ownerKey, tabId)
      amOwnerRef.current = (localStorage.getItem(ownerKey) === tabId)
    } catch (e) {
      amOwnerRef.current = true // fallback: allow ticking
    }
    // try to release ownership on unload (best effort)
    const onUnload = () => {
      try {
        const curr = localStorage.getItem(ownerKey)
        if (curr === tabId) localStorage.removeItem(ownerKey)
      } catch (e) {}
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, localPlayer, gameId])

  // Core ticking loop using requestAnimationFrame + elapsed delta
  useEffect(() => {
    // stop if game not running
    if (!gameStarted || isGameOver) return

    // cancel existing loop
    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    lastTsRef.current = performance.now()
    lastSyncRef.current = performance.now()

    const tick = (now) => {
      const last = lastTsRef.current || now
      const dt = Math.max(0, now - last)
      lastTsRef.current = now

      // only the owning client should decrement the active clock
      const active = syncedCurrent // 'w' or 'b'
      const canRun = amOwnerRef.current && (!localPlayer || syncedCurrent === localPlayer)

  if (canRun) {
        // read current values (prefer refs if available)
        const w = whiteRef.current != null ? whiteRef.current : (readMs(KEY_WHITE) || 0)
        const b = blackRef.current != null ? blackRef.current : (readMs(KEY_BLACK) || 0)

        if (active === 'w') {
          const next = Math.max(0, w - dt)
          whiteRef.current = next
          setWhiteTime(next)
          // sync periodically
          if (now - lastSyncRef.current >= SYNC_INTERVAL) {
            lastSyncRef.current = now
            if (isLocal) {
              writeMs(KEY_WHITE, next)
              try { if (channelRef.current) channelRef.current.postMessage({ type: 'tick', whiteTime: next, blackTime: blackRef.current || readMs(KEY_BLACK), currentPlayer: syncedCurrent }) } catch (e) {}
            } else if (gameRefRef.current) {
              gameRefRef.current.update({ whiteTime: next }).catch(e => console.error(e))
            }
            if (next <= 0) {
              try { onTimeOutRef.current('w') } catch (e) {}
            }
          }
        } else if (active === 'b') {
          const next = Math.max(0, b - dt)
          blackRef.current = next
          setBlackTime(next)
          if (now - lastSyncRef.current >= SYNC_INTERVAL) {
            lastSyncRef.current = now
            if (isLocal) {
              writeMs(KEY_BLACK, next)
              try { if (channelRef.current) channelRef.current.postMessage({ type: 'tick', whiteTime: whiteRef.current || readMs(KEY_WHITE), blackTime: next, currentPlayer: syncedCurrent }) } catch (e) {}
            } else if (gameRefRef.current) {
              gameRefRef.current.update({ blackTime: next }).catch(e => console.error(e))
            }
            if (next <= 0) {
              try { onTimeOutRef.current('b') } catch (e) {}
            }
          }
        }
      }
      else {
        // Non-owner interpolation: locally display the active player's clock decreasing
        // between authoritative updates. We don't write back to storage/Firestore here.
        try {
          const lastAt = lastRemoteAtRef.current || now
          const age = Math.max(0, now - lastAt)
          if (syncedCurrent === 'w') {
            const base = lastRemoteWhiteRef.current != null ? lastRemoteWhiteRef.current : (whiteRef.current != null ? whiteRef.current : (readMs(KEY_WHITE) || 0))
            const display = Math.max(0, base - age)
            setWhiteTime(display)
          } else if (syncedCurrent === 'b') {
            const base = lastRemoteBlackRef.current != null ? lastRemoteBlackRef.current : (blackRef.current != null ? blackRef.current : (readMs(KEY_BLACK) || 0))
            const display = Math.max(0, base - age)
            setBlackTime(display)
          }
        } catch (e) {}
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    // We deliberately exclude many dependencies; we use refs for live values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameStarted, isGameOver, syncedCurrent])

  // keep refs in sync with state for read access inside rAF loop
  useEffect(() => { whiteRef.current = whiteTime }, [whiteTime])
  useEffect(() => { blackRef.current = blackTime }, [blackTime])

  // formatting helper
  const format = (ms) => {
    if (ms == null) return '--:--'
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  // display order based on perspective prop
  const topColor = perspective === 'white' ? 'b' : 'w'
  const bottomColor = perspective === 'white' ? 'w' : 'b'

  const displayFor = (color) => color === 'w' ? (whiteTime != null ? whiteTime : readMs(KEY_WHITE)) : (blackTime != null ? blackTime : readMs(KEY_BLACK))

  const topTime = displayFor(topColor)
  const bottomTime = displayFor(bottomColor)

  const isLow = (t) => t != null && t <= LOW_TIME_THRESHOLD

  // Pre-start UI: allow choosing initial time (this preserves the earlier behaviour)
  if (!gameStarted) {
    const storedInitial = isLocal ? readMs(KEY_INITIAL) : null
    const initialPresent = storedInitial != null || initialTimeMinutes != null
    if (canSetInitial && !initialPresent) {
      const presets = [1, 3, 5, 10, 15, 30]
      return (
        <div className="chess-clock-setup">
          <h3>Select Time Control</h3>
          <div className="time-presets">
            {presets.map(p => (
              <button key={p} onClick={() => { if (isLocal) writeMs(KEY_INITIAL, p); if (onSetInitial) onSetInitial(p) }}>{p} min</button>
            ))}
          </div>
        </div>
      )
    }

    // default static display prior to game start
    const dispWhite = storedInitial != null ? storedInitial * 60 * 1000 : (initialTimeMinutes != null ? initialTimeMinutes * 60 * 1000 : (whiteTime || '--'))
    const dispBlack = storedInitial != null ? storedInitial * 60 * 1000 : (initialTimeMinutes != null ? initialTimeMinutes * 60 * 1000 : (blackTime || '--'))
    return (
      <>
        <div className={`chess-clock ${topColor === 'w' ? 'white' : 'black'}`} aria-label={`${topColor === 'w' ? 'White' : 'Black'} clock`}>{format(topColor === 'w' ? dispWhite : dispBlack)}</div>
        <div className={`chess-clock ${bottomColor === 'w' ? 'white' : 'black'}`} aria-label={`${bottomColor === 'w' ? 'White' : 'Black'} clock`}>{format(bottomColor === 'w' ? dispWhite : dispBlack)}</div>
      </>
    )
  }

  // Running display
  return (
    <>
      <div className={`chess-clock ${topColor === 'w' ? 'white' : 'black'} ${syncedCurrent === topColor ? 'active' : ''} ${isLow(topTime) ? 'low-time' : ''}`} aria-label={`${topColor} clock`}>{format(topTime)}</div>
      <div className={`chess-clock ${bottomColor === 'w' ? 'white' : 'black'} ${syncedCurrent === bottomColor ? 'active' : ''} ${isLow(bottomTime) ? 'low-time' : ''}`} aria-label={`${bottomColor} clock`}>{format(bottomTime)}</div>
      {(topTime === 0 || bottomTime === 0) && (
        <div className="time-over">{topTime === 0 ? `${topColor === 'w' ? 'White' : 'Black'} ran out of time` : `${bottomColor === 'w' ? 'White' : 'Black'} ran out of time`}</div>
      )}
    </>
  )
}
