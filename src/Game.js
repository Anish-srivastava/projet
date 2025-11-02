import * as Chess from 'chess.js'
import { BehaviorSubject, Observable } from 'rxjs'
import { map } from 'rxjs/operators'
import { auth } from './firebase'
// note: older rxfire exports like `fromDocRef` may not be available in some versions.
// We create a small Observable wrapper around Firestore's onSnapshot instead.

let gameRef
let member
let lastMove = null
let externalGameOver = false

const chess = new Chess()

export let gameSubject

export async function initGame(gameRefFb) {
    const { currentUser } = auth
    if (gameRefFb) {
        gameRef = gameRefFb
        const initialGame = await gameRefFb.get().then(doc => doc.data())
        if (!initialGame) {
            return 'notfound'
        }
        const creator = initialGame.members.find(m => m.creator === true)

        if (initialGame.status === 'waiting' && creator.uid !== currentUser.uid) {
            const currUser = {
                uid: currentUser.uid,
                name: localStorage.getItem('userName'),
                piece: creator.piece === 'w' ? 'b' : 'w'
            }
            const updatedMembers = [...initialGame.members, currUser]
            await gameRefFb.update({ members: updatedMembers, status: 'ready' })

        } else if (!initialGame.members.map(m => m.uid).includes(currentUser.uid)) {
            return 'intruder'
        }
        chess.reset()

        gameSubject = new Observable(subscriber => {
            // Firestore v8 onSnapshot returns an unsubscribe function
            const unsub = gameRefFb.onSnapshot(doc => subscriber.next(doc), err => subscriber.error(err))
            return () => { try { if (typeof unsub === 'function') unsub(); else if (unsub && typeof unsub.unsubscribe === 'function') unsub.unsubscribe() } catch (e) {} }
        }).pipe(
            map(gameDoc => {
                const game = gameDoc.data()
                const { pendingPromotion, gameData, lastMove: remotelastMove, ...restOfGame } = game
                member = game.members.find(m => m.uid === currentUser.uid)
                const opponent = game.members.find(m => m.uid !== currentUser.uid)

                // Validate and load game state
                if (gameData) {
                    try {
                        // chess.load(fen) returns true/false depending on validity in this build.
                        // The library export may not expose a standalone validate_fen function
                        // (different chess.js builds differ). Use chess.load and handle failure.
                        const ok = chess.load(gameData)
                        if (!ok) {
                            console.error('Invalid FEN received (chess.load returned false):', gameData)
                            // Potentially implement recovery logic here
                        }
                    } catch (error) {
                        console.error('Error loading game state:', error)
                    }
                }

                // Handle remote moves
                if (remotelastMove && remotelastMove.timestamp > (lastMove?.timestamp || 0)) {
                    lastMove = remotelastMove // Update local last move
                }

                const isGameOver = chess.game_over()
                
                return {
                    board: chess.board(),
                    pendingPromotion,
                    isGameOver,
                    position: member.piece,
                    currentPlayer: chess.turn(),
                    member,
                    opponent, // Fixed typo in variable name
                    lastMove,
                    moveCount: chess.history().length,
                    result: isGameOver ? getGameResult() : null,
                    ...restOfGame
                }
            })
        )

    } else {
        gameRef = null
        gameSubject = new BehaviorSubject()
        const savedGame = localStorage.getItem('savedGame')
        if (savedGame) {
            chess.load(savedGame)
        }
        updateGame()
    }

}

export async function resetGame() {
    if (gameRef) {
        await updateGame(null, true)
        chess.reset()
    } else {
        chess.reset()
        updateGame()
    }

}

export function handleMove(from, to) {
    const promotions = chess.moves({ verbose: true }).filter(m => m.promotion)
    console.table(promotions)
    let pendingPromotion
    if (promotions.some(p => `${p.from}:${p.to}` === `${from}:${to}`)) {
        pendingPromotion = { from, to, color: promotions[0].color }
        updateGame(pendingPromotion)
    }

    if (!pendingPromotion) {
        move(from, to)
    }
}


export function move(from, to, promotion) {
    // Prevent moves after game over
    if (externalGameOver || chess.game_over()) return

    // Construct move object
    let tempMove = { from, to }
    if (promotion) {
        tempMove.promotion = promotion
    }

    if (gameRef) {
        // Online multiplayer game
        if (member.piece === chess.turn()) {
            const legalMove = chess.move(tempMove)
            if (legalMove) {
                // Save move details for animation and highlighting
                lastMove = {
                    ...legalMove,
                    timestamp: Date.now(),  // For move timing
                    player: member.piece    // Track who made the move
                }
                
                // Immediately update local state for responsive UI
                const currentState = {
                    board: chess.board(),
                    lastMove,
                    currentPlayer: chess.turn(),
                    moveCount: chess.history().length,
                    fen: chess.fen()
                }
                
                // Notify local subscribers immediately
                // If gameSubject is a Subject (local mode) notify subscribers immediately for snappy UI.
                // In remote mode gameSubject is an Observable from Firestore and does not support .next().
                if (gameSubject && typeof gameSubject.next === 'function') {
                    try {
                        gameSubject.next({
                            ...currentState,
                            pendingPromotion: null,
                            isGameOver: chess.game_over(),
                            position: member.piece,
                            member,
                            result: chess.game_over() ? getGameResult() : null
                        })
                    } catch (e) {
                        // swallow errors from optimistic publish; Firestore update will be authoritative
                        console.warn('gameSubject.next failed (likely remote Observable):', e)
                    }
                }

                // Then update Firebase (this will trigger updates for other players)
                // Dispatch a lightweight event so local UI components (clocks) can react immediately
                // before the remote snapshot arrives. This avoids a visible delay where the
                // mover's clock keeps running until Firestore round-trip completes.
                try {
                    window.dispatchEvent(new CustomEvent('move-made', { detail: { currentPlayer: chess.turn(), lastMove } }))
                } catch (e) {}
                updateGame()
            }
        }
    } else {
        // Local game mode
        const legalMove = chess.move(tempMove)
        if (legalMove) {
            lastMove = {
                ...legalMove,
                timestamp: Date.now(),
                player: chess.turn() === 'w' ? 'b' : 'w' // Previous player
            }
            updateGame()
        }
    }
}

async function updateGame(pendingPromotion, reset) {
    const isGameOver = chess.game_over()
    
    if (gameRef) {
        // Online multiplayer game
        const updatedData = {
            gameData: chess.fen(),
            pendingPromotion: pendingPromotion || null,
            currentPlayer: chess.turn(),
            moveCount: chess.history().length,
            updatedAt: Date.now() // For synchronization
        }

        if (reset) {
            updatedData.status = 'over'
        }

        if (lastMove) {
            // Include detailed move information
            updatedData.lastMove = {
                ...lastMove,
                fen: chess.fen(), // Include full position for validation
                moveNumber: chess.history().length
            }
        }

        try {
            // Batch update to ensure atomic operation
            console.log('updateGame: writing to Firestore', updatedData)
            await gameRef.update(updatedData)
            console.log('updateGame: write successful')
            
            // Verify the move was recorded
            const snapshot = await gameRef.get()
            const currentData = snapshot.data()
            
            if (currentData.moveCount !== updatedData.moveCount) {
                // Move wasn't recorded properly, try to recover
                console.warn('Move sync issue detected, resyncing...')
                await gameRef.update({
                    gameData: chess.fen(),
                    currentPlayer: chess.turn(),
                    moveCount: chess.history().length
                })
            }
        } catch (error) {
            console.error('Failed to update game:', error)
            // Optionally implement retry logic here
        }

        lastMove = null // Clear after successful sync
    } else {
        // Local game mode
        const newGame = {
            board: chess.board(),
            pendingPromotion,
            isGameOver,
            position: chess.turn(),
            currentPlayer: chess.turn(),
            result: isGameOver ? getGameResult() : null,
            lastMove: lastMove || null,
            moveCount: chess.history().length
        }
        
        localStorage.setItem('savedGame', chess.fen())
        gameSubject.next(newGame)
        lastMove = null
    }


}
 
export async function endGameByTimeout(loserColor) {
    // mark external game over and publish result
    externalGameOver = true
    const winner = loserColor === 'white' ? 'Black' : 'White'
    const result = `TIMEOUT - ${winner} wins`
    if (gameRef) {
        // update remote doc
        await gameRef.update({ status: 'over', result, currentPlayer: chess.turn() })
    } else {
        // publish locally
        const newGame = {
            board: chess.board(),
            pendingPromotion: null,
            isGameOver: true,
            position: chess.turn(),
            currentPlayer: chess.turn(),
            result,
            lastMove: lastMove || null
        }
        gameSubject.next(newGame)
    }
}
function getGameResult() {
    if (chess.in_checkmate()) {
        const winner = chess.turn() === "w" ? 'BLACK' : 'WHITE'
        return `CHECKMATE - WINNER - ${winner}`
    } else if (chess.in_draw()) {
        let reason = '50 - MOVES - RULE'
        if (chess.in_stalemate()) {
            reason = 'STALEMATE'
        } else if (chess.in_threefold_repetition()) {
            reason = 'REPETITION'
        } else if (chess.insufficient_material()) {
            reason = "INSUFFICIENT MATERIAL"
        }
        return `DRAW - ${reason}`
    } else {
        return 'UNKNOWN REASON'
    }
}