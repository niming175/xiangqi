/* Shared Xiangqi rules for the browser client and Node room server. */
(function (root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else root.XiangqiRules = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SIZE = 10;
  const PIECE_NAMES = {
    red: { general: '帥', advisor: '仕', elephant: '相', horse: '馬', chariot: '車', cannon: '炮', soldier: '兵' },
    black: { general: '將', advisor: '士', elephant: '象', horse: '馬', chariot: '車', cannon: '砲', soldier: '卒' }
  };

  function newPiece(side, type) { return { side, type }; }
  function initialBoard() {
    const board = Array.from({ length: SIZE }, () => Array(9).fill(null));
    const back = ['chariot', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'chariot'];
    for (let x = 0; x < 9; x++) {
      board[0][x] = newPiece('black', back[x]); board[9][x] = newPiece('red', back[x]);
      board[3][x] = x % 2 === 0 ? newPiece('black', 'soldier') : null;
      board[6][x] = x % 2 === 0 ? newPiece('red', 'soldier') : null;
    }
    board[2][1] = newPiece('black', 'cannon'); board[2][7] = newPiece('black', 'cannon');
    board[7][1] = newPiece('red', 'cannon'); board[7][7] = newPiece('red', 'cannon');
    return board;
  }
  function inside(x, y) { return x >= 0 && x < 9 && y >= 0 && y < 10; }
  function palace(side, x, y) { return x >= 3 && x <= 5 && (side === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2); }
  function crossedRiver(side, y) { return side === 'red' ? y <= 4 : y >= 5; }
  function findGeneral(board, side) {
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
      const p = board[y][x]; if (p && p.side === side && p.type === 'general') return { x, y };
    }
    return null;
  }
  function pseudoMoves(board, x, y) {
    const piece = board[y][x]; if (!piece) return [];
    const { side, type } = piece; const moves = [];
    const add = (tx, ty) => {
      if (!inside(tx, ty)) return false;
      const target = board[ty][tx]; if (target && target.side === side) return false;
      moves.push({ x: tx, y: ty }); return !target;
    };
    if (type === 'general') {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const tx = x + dx, ty = y + dy; if (inside(tx, ty) && palace(side, tx, ty)) add(tx, ty);
      }
      const dir = side === 'red' ? -1 : 1;
      for (let ty = y + dir; inside(x, ty); ty += dir) {
        const target = board[ty][x]; if (!target) continue;
        if (target.side !== side && target.type === 'general') moves.push({ x, y: ty });
        break;
      }
    } else if (type === 'advisor') {
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const tx = x + dx, ty = y + dy; if (inside(tx, ty) && palace(side, tx, ty)) add(tx, ty);
      }
    } else if (type === 'elephant') {
      for (const [dx, dy] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
        const tx = x + dx, ty = y + dy;
        if (inside(tx, ty) && (side === 'red' ? ty >= 5 : ty <= 4) && !board[y + dy / 2][x + dx / 2]) add(tx, ty);
      }
    } else if (type === 'horse') {
      for (const [dx, dy, lx, ly] of [[1, 2, 0, 1], [-1, 2, 0, 1], [1, -2, 0, -1], [-1, -2, 0, -1], [2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0]]) {
        const tx = x + dx, ty = y + dy; if (inside(tx, ty) && !board[y + ly][x + lx]) add(tx, ty);
      }
    } else if (type === 'chariot' || type === 'cannon') {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let screened = false;
        for (let tx = x + dx, ty = y + dy; inside(tx, ty); tx += dx, ty += dy) {
          const target = board[ty][tx];
          if (type === 'chariot') {
            if (!target) moves.push({ x: tx, y: ty });
            else { if (target.side !== side) moves.push({ x: tx, y: ty }); break; }
          } else if (!screened) {
            if (!target) moves.push({ x: tx, y: ty }); else screened = true;
          } else if (target) { if (target.side !== side) moves.push({ x: tx, y: ty }); break; }
        }
      }
    } else if (type === 'soldier') {
      add(x, y + (side === 'red' ? -1 : 1));
      if (crossedRiver(side, y)) { add(x - 1, y); add(x + 1, y); }
    }
    return moves;
  }
  function isAttacked(board, x, y, bySide) {
    for (let sy = 0; sy < 10; sy++) for (let sx = 0; sx < 9; sx++) {
      const p = board[sy][sx];
      if (p && p.side === bySide && pseudoMoves(board, sx, sy).some(m => m.x === x && m.y === y)) return true;
    }
    return false;
  }
  function inCheck(board, side) {
    const general = findGeneral(board, side);
    return general ? isAttacked(board, general.x, general.y, side === 'red' ? 'black' : 'red') : true;
  }
  function legalMoves(board, x, y) {
    const piece = board[y][x]; if (!piece) return [];
    return pseudoMoves(board, x, y).filter(move => {
      const copy = board.map(row => row.slice()); copy[move.y][move.x] = copy[y][x]; copy[y][x] = null;
      return !inCheck(copy, piece.side);
    });
  }
  function anyLegalMove(board, side) {
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
      const p = board[y][x]; if (p && p.side === side && legalMoves(board, x, y).length) return true;
    }
    return false;
  }
  return { PIECE_NAMES, initialBoard, inside, legalMoves, inCheck, anyLegalMove };
});
