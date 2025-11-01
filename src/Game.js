import * as Chess from 'chess.js'
import { BehaviorSubject } from 'rxjs'
import { map } from 'rxjs/operators'
import { auth } from './firebase'
import { fromDocRef } from 'rxfire/firestore'
import { updateDoc } from 'firebase/firestore'

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

        gameSubject = fromDocRef(gameRefFb).pipe(
            map(gameDoc => {
                const game = gameDoc.data()
                const { pendingPromotion, gameData, ...restOfGame } = game
                member = game.members.find(m => m.uid === currentUser.uid)
                const oponent = game.members.find(m => m.uid !== currentUser.uid)
                if (gameData) {
                    chess.load(gameData)
                }
                const isGameOver = chess.game_over()
                return {
                    board: chess.board(),
                    pendingPromotion,
                    isGameOver,
                    position: member.piece,
                        currentPlayer: chess.turn(),
                        member,
                        oponent,
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
    // prevent moves after an external game over (e.g., timeout)
    if (externalGameOver || chess.game_over()) return
    let tempMove = { from, to }
    if (promotion) {
        tempMove.promotion = promotion
    }
    console.log({ tempMove, member }, chess.turn())
    if (gameRef) {
        if (member.piece === chess.turn()) {
            const legalMove = chess.move(tempMove)
            if (legalMove) {
                // save lastMove so UI can display it
                lastMove = legalMove
                updateGame()
            }
        }
    } else {
        const legalMove = chess.move(tempMove)

        if (legalMove) {
            // save lastMove for local mode
            lastMove = legalMove
            updateGame()
        }
    }

}

async function updateGame(pendingPromotion, reset) {
    const isGameOver = chess.game_over()
    if (gameRef) {
        const updatedData = { gameData: chess.fen(), pendingPromotion: pendingPromotion || null, currentPlayer: chess.turn() }
        console.log({ updateGame })
        if (reset) {
            updatedData.status = 'over'
        }
        // include lastMove in the remote game document so subscribers can pick it up
        if (lastMove) {
            updatedData.lastMove = lastMove
        }
        await gameRef.update(updatedData)
        // clear lastMove after publishing
        lastMove = null
    } else {
        const newGame = {
            board: chess.board(),
            pendingPromotion,
            isGameOver,
                position: chess.turn(),
                currentPlayer: chess.turn(),
            result: isGameOver ? getGameResult() : null,
            lastMove: lastMove || null
        }
        localStorage.setItem('savedGame', chess.fen())
        gameSubject.next(newGame)
        // clear lastMove for local
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