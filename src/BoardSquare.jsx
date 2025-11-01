import React, { useEffect, useState, useMemo } from 'react'
import Square from './Square'
import Piece from './Piece'
import { useDrop } from 'react-dnd'
import { handleMove } from './Game'
import { gameSubject } from './Game'
import Promote from './Promote'

function BoardSquare({
  piece,
  black,
  position,
}) {
  const [promotion, setPromotion] = useState(null)
  const [, drop] = useDrop({
    accept: 'piece',
    drop: (item) => {
      const [fromPosition] = item.id.split('_')
      handleMove(fromPosition, position)
    },
  })
  useEffect(() => {
    const subscribe = gameSubject.subscribe(
      ({ pendingPromotion }) =>
        pendingPromotion && pendingPromotion.to === position
          ? setPromotion(pendingPromotion)
          : setPromotion(null)
    )
    return () => subscribe.unsubscribe()
  }, [position])
  
  // Memoize piece rendering to avoid unnecessary re-renders
  const pieceContent = useMemo(() => {
    if (promotion) {
      return <Promote promotion={promotion} />
    }
    if (piece) {
      return <Piece piece={piece} position={position} />
    }
    return null
  }, [promotion, piece, position])
  
  return (
    <div className="board-square" ref={drop}>
      <Square black={black}>
        {pieceContent}
      </Square>
    </div>
  )
}

// Memoize BoardSquare to prevent re-renders when props haven't changed
export default React.memo(BoardSquare, (prevProps, nextProps) => {
  // Only re-render if piece, black, or position changed
  return (
    prevProps.piece === nextProps.piece &&
    prevProps.black === nextProps.black &&
    prevProps.position === nextProps.position
  )
})
