import React, { useEffect, useState, useMemo } from 'react'
import BoardSquare from './BoardSquare'

function Board({ board, position }) {
  // Memoize board transformation to avoid recalculation
  const currBoard = useMemo(() => {
    if (!board || board.length === 0) return []
    return position === 'w' ? board.flat() : board.flat().reverse()
  }, [board, position])

  // Memoize position calculations
  const squares = useMemo(() => {
    return currBoard.map((piece, i) => {
      const x = position === 'w' ? i % 8 : Math.abs((i % 8) - 7)
      const y = position === 'w'
        ? Math.abs(Math.floor(i / 8) - 7)
        : Math.floor(i / 8)
      const isBlackSquare = (x + y) % 2 === 1
      const letter = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'][x]
      const squarePosition = `${letter}${y + 1}`
      
      return {
        piece,
        isBlack: isBlackSquare,
        position: squarePosition,
        key: `${squarePosition}-${piece ? piece.type + piece.color : 'empty'}`
      }
    })
  }, [currBoard, position])

  return (
    <div className="board">
      {squares.map((square) => (
        <div key={square.key} className="square">
          <BoardSquare
            piece={square.piece}
            black={square.isBlack}
            position={square.position}
          />
        </div>
      ))}
    </div>
  )
}

// Memoize Board component to prevent re-renders when props haven't changed
export default React.memo(Board, (prevProps, nextProps) => {
  // Custom comparison: only re-render if board or position actually changed
  if (prevProps.position !== nextProps.position) return false
  
  // Deep comparison of board array
  if (prevProps.board === nextProps.board) return true
  
  if (!prevProps.board || !nextProps.board) return false
  if (prevProps.board.length !== nextProps.board.length) return false
  
  // Compare board state (only check if structure changed, not every piece)
  // For performance, we do a shallow comparison of each row
  for (let i = 0; i < prevProps.board.length; i++) {
    if (prevProps.board[i] !== nextProps.board[i]) {
      // Row changed, need to check if content is different
      const prevRow = prevProps.board[i] || []
      const nextRow = nextProps.board[i] || []
      if (prevRow.length !== nextRow.length) return false
      for (let j = 0; j < prevRow.length; j++) {
        if (prevRow[j] !== nextRow[j]) return false
      }
    }
  }
  
  return true // Props are the same, skip re-render (return true = don't re-render)
})
