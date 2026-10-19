(() => {
  'use strict';

  const Rules = window.XiangqiRules;
  const PIECE_NAMES = Rules.PIECE_NAMES;
  const FILES = '一二三四五六七八九';
  const boardEl = document.getElementById('board');
  const squaresEl = document.getElementById('squares');
  const piecesEl = document.getElementById('pieces');
  const moveListEl = document.getElementById('move-list');
  const moveCountEl = document.getElementById('move-count');
  const undoButton = document.getElementById('undo-button');
  const restartButton = document.getElementById('restart-button');
  const exitGameButton = document.getElementById('exit-game-button');
  const statusMessage = document.getElementById('status-message');
  const turnTitle = document.getElementById('turn-title');
  const turnStone = document.getElementById('turn-stone');
  const checkBanner = document.getElementById('check-banner');
  const sideStrips = { red: document.getElementById('red-player'), black: document.getElementById('black-player') };
  const sideStatus = { red: document.getElementById('red-status'), black: document.getElementById('black-status') };
  const onlineButton = document.getElementById('online-button');
  const onlineOverlay = document.getElementById('online-overlay');
  const onlineActions = document.getElementById('online-actions');
  const joinRoomPanel = document.getElementById('join-room-panel');
  const activeRoom = document.getElementById('active-room');
  const onlineError = document.getElementById('online-error');
  const roomCodeInput = document.getElementById('room-code-input');
  const roomCodeDisplay = document.getElementById('room-code-display');
  const roomLinkLine = document.getElementById('room-link-line');
  const roomLinkDisplay = document.getElementById('room-link-display');
  const roomResultTitle = document.getElementById('room-result-title');
  const roomRole = document.getElementById('room-role');
  const gameTimer = document.getElementById('game-timer');
  const timerValue = document.getElementById('timer-value');
  const timerState = document.getElementById('timer-state');
  const gameStartOverlay = document.getElementById('game-start-overlay');
  const exitCountdownOverlay = document.getElementById('exit-countdown-overlay');
  const exitCountdownValue = document.getElementById('exit-countdown-value');
  const exitCountdownMessage = document.getElementById('exit-countdown-message');
  const roomStatusText = document.getElementById('room-status-text');

  let state;
  let onlineSession = null;
  let eventSource = null;
  let onlinePending = false;
  let timerInterval = null;
  let exitCountdownInterval = null;
  let suppressClick = false;
  const squareNodes = [];

  function reset() {
    state = { board: Rules.initialBoard(), turn: 'red', selected: null, targets: [], history: [], moves: [], lastMove: null, gameOver: false, winner: null, check: false };
    render();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  function applyOnlineState(next) {
    state = { ...next, selected: null, targets: [], history: [] };
    onlinePending = false;
    render();
    updateRoomDialog();
    maybeStartAnnouncement();
  }

  function connectRoom() {
    if (!onlineSession) return;
    if (eventSource) eventSource.close();
    const { roomCode, token } = onlineSession;
    eventSource = new EventSource(`/api/rooms/${encodeURIComponent(roomCode)}/events?token=${encodeURIComponent(token)}`);
    eventSource.addEventListener('state', event => {
      try { applyOnlineState(JSON.parse(event.data)); onlineSession.connected = true; renderStatus(); updateRoomDialog(); maybeStartAnnouncement(); }
      catch { onlineError.textContent = '收到无法识别的棋局数据。'; }
    });
    eventSource.addEventListener('closed', () => returnToLocal());
    eventSource.onopen = () => { onlineSession.connected = true; renderStatus(); maybeStartAnnouncement(); };
    eventSource.onerror = () => { if (onlineSession) { onlineSession.connected = false; renderStatus(); } };
  }

  function beginOnline(result) {
    const round = result.state.round || 1;
    onlineSession = { roomCode: result.roomCode, playerColor: result.playerColor, token: result.token, connected: false, announcedRound: result.announcedRound || (result.startAnnounced || result.state.startedAt ? round : 0) };
    sessionStorage.setItem('xiangqi-online-room', JSON.stringify(onlineSession));
    onlineButton.classList.add('online-active');
    onlineButton.textContent = `在线 · ${result.roomCode}`;
    onlineActions.hidden = true;
    joinRoomPanel.hidden = true;
    activeRoom.hidden = false;
    onlineError.textContent = '';
    applyOnlineState(result.state);
    connectRoom();
  }

  function updateRoomDialog() {
    if (!onlineSession) return;
    roomCodeDisplay.textContent = onlineSession.roomCode;
    const creator = onlineSession.playerColor === 'red';
    const inviteUrl = new URL(window.location.href);
    inviteUrl.search = '';
    inviteUrl.hash = '';
    inviteUrl.searchParams.set('room', onlineSession.roomCode);
    roomLinkDisplay.value = inviteUrl.href;
    roomLinkLine.hidden = !creator;
    roomResultTitle.textContent = state.exitedBy
      ? (state.exitedBy === onlineSession.playerColor ? '你已退出本局' : '对方已经退出')
      : creator ? '房间创建成功' : '已成功加入房间';
    roomRole.textContent = creator ? '你是红方 · 先行' : '你是黑方 · 后手';
    roomStatusText.textContent = state.exitDeadline
      ? state.exitRequestedBy === onlineSession.playerColor ? '你已退出，30 秒内可再次进入以继续本局。' : '对方已经退出，正在等待对方再次进入。'
      : state.exitedBy
      ? state.restartVotes[onlineSession.playerColor] ? '已提出重新开始，正在等待对方确认。' : state.restartVotes[onlineSession.playerColor === 'red' ? 'black' : 'red'] ? '对方希望重新开始，点击“重新开始”即可确认。' : '棋盘已锁定。双方都确认后即可重新开始。'
      : state.gameOver
      ? `${state.winner === onlineSession.playerColor ? '你赢得了' : '对手赢得了'}本局。`
      : !onlineSession.connected ? '正在连接对局服务…'
      : state.opponentConnected ? (creator ? '对手已加入，双方均已就绪，可以开始对弈。' : '已连接到红方，双方均已就绪，可以开始对弈。')
      : creator ? '请分享房间码或邀请链接，等待对手加入。' : '已加入房间，正在等待创建方连接。';
    document.getElementById('leave-room-button').hidden = Boolean(state.exitDeadline || state.exitedBy);
  }

  function renderTimer() {
    if (!onlineSession || !state.startedAt) {
      gameTimer.hidden = true;
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      return;
    }
    gameTimer.hidden = false;
    const endAt = state.pausedAt || state.finishedAt || Date.now();
    const seconds = Math.max(0, Math.floor((endAt - state.startedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    timerValue.textContent = hours > 0
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    timerState.textContent = state.exitDeadline ? '退出倒计时中' : state.exitedBy ? '对局已退出' : state.gameOver ? '本局结束' : '对局进行中';
    const stopped = state.gameOver || Boolean(state.exitedBy) || Boolean(state.exitDeadline);
    gameTimer.classList.toggle('finished', stopped);
    if (!stopped && !timerInterval) timerInterval = window.setInterval(renderTimer, 1000);
    if (stopped && timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  function maybeStartAnnouncement() {
    const round = state.round || 1;
    if (!onlineSession || !onlineSession.connected || !state.startedAt || state.exitedBy || state.exitDeadline || !state.opponentConnected || onlineSession.announcedRound >= round) return;
    onlineSession.announcedRound = round;
    sessionStorage.setItem('xiangqi-online-room', JSON.stringify(onlineSession));
    onlineOverlay.hidden = true;
    gameStartOverlay.hidden = false;
    window.setTimeout(() => { gameStartOverlay.hidden = true; }, 2700);
  }

  function renderExitCountdown() {
    if (!onlineSession || !state.exitDeadline) {
      exitCountdownOverlay.hidden = true;
      if (exitCountdownInterval) { clearInterval(exitCountdownInterval); exitCountdownInterval = null; }
      return;
    }
    onlineOverlay.hidden = true;
    exitCountdownOverlay.hidden = false;
    exitCountdownMessage.textContent = state.exitRequestedBy === onlineSession.playerColor ? '你已退出，是否返回本局？' : '对方已经退出';
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((state.exitDeadline - Date.now()) / 1000));
      exitCountdownValue.textContent = String(seconds).padStart(2, '0');
      if (seconds === 0) returnToLocal();
    };
    tick();
    if (!exitCountdownInterval) exitCountdownInterval = window.setInterval(tick, 200);
  }

  async function createRoom() {
    onlineError.textContent = '';
    try { beginOnline(await api('/api/rooms', { method: 'POST', body: '{}' })); }
    catch (error) { onlineError.textContent = error.message; }
  }

  async function joinRoom(sharedCode = null) {
    onlineError.textContent = '';
    const code = (sharedCode || roomCodeInput.value).trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { onlineError.textContent = '请输入 6 位房间码。'; return; }
    roomCodeInput.value = code;
    try { beginOnline(await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: '{}' })); }
    catch (error) {
      onlineOverlay.hidden = false;
      onlineActions.hidden = true;
      joinRoomPanel.hidden = false;
      activeRoom.hidden = true;
      onlineError.textContent = error.message.includes('黑方席位已有人')
        ? '这个房间已被加入，请向房主索取一个新的房间链接。'
        : error.message.includes('房间不存在')
          ? '房间不存在或已过期，请检查分享链接，或让房主重新创建房间。'
          : error.message;
    }
  }

  function joinFromShareLink() {
    const sharedCode = new URLSearchParams(window.location.search).get('room');
    if (sharedCode === null) return false;
    sessionStorage.removeItem('xiangqi-online-room');
    onlineOverlay.hidden = false;
    onlineActions.hidden = true;
    joinRoomPanel.hidden = false;
    activeRoom.hidden = true;
    onlineError.textContent = '正在通过邀请链接加入房间…';
    joinRoom(sharedCode);
    return true;
  }

  async function resumeRoom() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('xiangqi-online-room') || 'null');
      if (!saved || !saved.roomCode || !saved.token) return;
      const data = await api(`/api/rooms/${encodeURIComponent(saved.roomCode)}/state?token=${encodeURIComponent(saved.token)}`);
      beginOnline({ ...saved, state: data.state });
    } catch { sessionStorage.removeItem('xiangqi-online-room'); }
  }

  function returnToLocal() {
    if (eventSource) eventSource.close();
    eventSource = null; onlineSession = null; onlinePending = false;
    if (exitCountdownInterval) { clearInterval(exitCountdownInterval); exitCountdownInterval = null; }
    sessionStorage.removeItem('xiangqi-online-room');
    onlineButton.classList.remove('online-active'); onlineButton.textContent = '⇄ 在线对战';
    onlineActions.hidden = false; joinRoomPanel.hidden = true; activeRoom.hidden = true; onlineError.textContent = '';
    gameStartOverlay.hidden = true; exitCountdownOverlay.hidden = true; onlineOverlay.hidden = true;
    reset();
  }

  async function leaveOnlineGame() {
    if (!onlineSession) return returnToLocal();
    try { await api(`/api/rooms/${encodeURIComponent(onlineSession.roomCode)}/leave`, { method: 'POST', body: JSON.stringify({ token: onlineSession.token }) }); }
    catch { /* the room may already have expired */ }
    returnToLocal();
  }

  async function exitOnlineGame() {
    if (!onlineSession || state.exitDeadline || state.exitedBy) return;
    exitGameButton.disabled = true;
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(onlineSession.roomCode)}/exit`, {
        method: 'POST', body: JSON.stringify({ token: onlineSession.token })
      });
      onlineOverlay.hidden = true;
      applyOnlineState(result.state);
    } catch (error) {
      statusMessage.textContent = error.message;
      exitGameButton.disabled = false;
    }
  }

  async function reenterOnlineGame() {
    if (!onlineSession || !state.exitDeadline) return;
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(onlineSession.roomCode)}/reenter`, {
        method: 'POST', body: JSON.stringify({ token: onlineSession.token })
      });
      applyOnlineState(result.state);
    } catch (error) {
      statusMessage.textContent = error.message;
    }
  }

  async function restartOnlineGame() {
    if (!onlineSession || state.exitDeadline || (!state.exitedBy && !state.gameOver) || state.restartVotes?.[onlineSession.playerColor]) return;
    restartButton.disabled = true;
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(onlineSession.roomCode)}/restart`, {
        method: 'POST', body: JSON.stringify({ token: onlineSession.token })
      });
      applyOnlineState(result.state);
    } catch (error) {
      statusMessage.textContent = error.message;
      restartButton.disabled = false;
    }
  }

  async function submitOnlineMove(to) {
    const from = state.selected;
    if (!from || !onlineSession || onlinePending) return;
    onlinePending = true; state.selected = null; state.targets = []; render();
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(onlineSession.roomCode)}/move`, {
        method: 'POST', body: JSON.stringify({ token: onlineSession.token, version: state.version, from, to })
      });
      applyOnlineState(result.state);
    } catch (error) {
      onlinePending = false;
      try {
        const latest = await api(`/api/rooms/${encodeURIComponent(onlineSession.roomCode)}/state?token=${encodeURIComponent(onlineSession.token)}`);
        applyOnlineState(latest.state);
      } catch { render(); }
      onlineError.textContent = error.message;
      statusMessage.textContent = error.message;
    }
  }

  function coordinate(move, side) {
    const file = side === 'red' ? 9 - move.x : move.x + 1;
    return `${FILES[file - 1]}${10 - move.y}`;
  }

  function describeMove(piece, from, to, side) {
    const forward = side === 'red' ? -1 : 1;
    const sameFile = from.x === to.x;
    let action = sameFile ? (to.y === from.y + forward ? '进' : to.y === from.y - forward ? '退' : '平') : (to.x === from.x ? '平' : (to.y - from.y === forward || to.y === from.y - forward ? (Math.abs(to.y - from.y) === 1 && piece.type === 'soldier' ? '平' : '进') : '平'));
    if (['chariot', 'cannon', 'soldier', 'general'].includes(piece.type) && !sameFile) action = '平';
    if (piece.type === 'horse' || piece.type === 'elephant' || piece.type === 'advisor') action = to.y < from.y ? '进' : to.y > from.y ? '退' : '平';
    const distance = piece.type === 'horse' || piece.type === 'elephant' || piece.type === 'advisor' ? '' : (sameFile ? String(Math.abs(to.y - from.y)) : FILES[(side === 'red' ? 9 - to.x : to.x + 1) - 1]);
    return { text: `${PIECE_NAMES[side][piece.type]}${FILES[(side === 'red' ? 9 - from.x : from.x + 1) - 1]}${action}${distance}`, from: coordinate(from, side), to: coordinate(to, side) };
  }

  function choose(x, y) {
    if (state.gameOver || state.exitDeadline || state.exitedBy || onlinePending || (onlineSession && (!state.opponentConnected || onlineSession.playerColor !== state.turn))) return;
    const piece = state.board[y][x];
    if (state.selected) {
      const target = state.targets.find(m => m.x === x && m.y === y);
      if (target) { play(target); return; }
    }
    if (piece && piece.side === state.turn) {
      state.selected = { x, y }; state.targets = Rules.legalMoves(state.board, x, y);
    } else { state.selected = null; state.targets = []; }
    render();
  }

  function startDrag(event, x, y, node) {
    if (event.button !== 0 || state.gameOver || state.exitDeadline || state.exitedBy || onlinePending || (onlineSession && (!state.opponentConnected || onlineSession.playerColor !== state.turn))) return;
    const piece = state.board[y][x];
    if (!piece || piece.side !== state.turn) return;
    event.preventDefault();
    state.selected = { x, y };
    state.targets = Rules.legalMoves(state.board, x, y);
    state.drag = { x, y, pointerId: event.pointerId, node, startX: event.clientX, startY: event.clientY, moved: false };
    node.classList.add('selected', 'dragging');
    node.setPointerCapture(event.pointerId);
    renderSquares();
    renderStatus();
  }

  function moveDrag(event) {
    const drag = state.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) drag.moved = true;
    if (!drag.moved) return;
    const rect = boardEl.getBoundingClientRect();
    drag.node.style.left = `${((event.clientX - rect.left) / rect.width) * 100}%`;
    drag.node.style.top = `${((event.clientY - rect.top) / rect.height) * 100}%`;
  }

  function finishDrag(event, cancelled = false) {
    const drag = state.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    state.drag = null;
    if (drag.moved && !cancelled) {
      const rect = boardEl.getBoundingClientRect();
      const colStep = 100 / 9;
      const rowStep = 100 / 10;
      const px = ((event.clientX - rect.left) / rect.width) * 100;
      const py = ((event.clientY - rect.top) / rect.height) * 100;
      const col = Math.round((px - 5.555) / colStep);
      const row = Math.round((py - 5) / rowStep);
      const nearIntersection = Math.abs(px - (5.555 + col * colStep)) <= colStep * 0.42 && Math.abs(py - (5 + row * rowStep)) <= rowStep * 0.42;
      const legal = state.targets.some(move => move.x === col && move.y === row);
      if (nearIntersection && Rules.inside(col, row) && legal) {
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 500);
        play({ x: col, y: row });
        return;
      }
      state.selected = null;
      state.targets = [];
    }
    render();
  }

  function play(to) {
    const from = state.selected;
    if (!from) return;
    if (onlineSession) { submitOnlineMove(to); return; }
    const board = state.board;
    const piece = board[from.y][from.x];
    const captured = board[to.y][to.x];
    state.history.push({ board: board.map(row => row.map(p => p && { ...p })), turn: state.turn, lastMove: state.lastMove, moves: state.moves.slice(), gameOver: state.gameOver, winner: state.winner });
    const notation = describeMove(piece, from, to, state.turn);
    board[to.y][to.x] = piece; board[from.y][from.x] = null;
    state.lastMove = { from, to };
    state.moves.push({ side: state.turn, notation, captured: Boolean(captured) });
    state.turn = state.turn === 'red' ? 'black' : 'red';
    state.selected = null; state.targets = [];
    state.check = Rules.inCheck(board, state.turn);
    if (captured && captured.type === 'general') {
      state.gameOver = true; state.winner = piece.side; state.check = false;
    } else if (!Rules.anyLegalMove(board, state.turn)) {
      state.gameOver = true; state.winner = piece.side;
    }
    render();
  }

  function undo() {
    const previous = state.history.pop();
    if (!previous) return;
    state.board = previous.board; state.turn = previous.turn; state.lastMove = previous.lastMove;
    state.moves = previous.moves; state.gameOver = previous.gameOver; state.winner = previous.winner;
    state.selected = null; state.targets = []; state.check = Rules.inCheck(state.board, state.turn);
    render();
  }

  function makeSquares() {
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
      const square = document.createElement('button');
      square.type = 'button'; square.className = 'square'; square.style.setProperty('--x', x); square.style.setProperty('--y', y);
      square.setAttribute('role', 'gridcell'); square.setAttribute('aria-label', `${coordinate({ x, y }, 'red')}位置`);
      square.addEventListener('click', () => choose(x, y));
      squaresEl.appendChild(square); squareNodes.push(square);
    }
  }

  function renderPieces() {
    piecesEl.replaceChildren();
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) {
      const piece = state.board[y][x];
      if (!piece) continue;
      const node = document.createElement('button');
      node.type = 'button'; node.className = `piece ${piece.side}`;
      if (state.selected && state.selected.x === x && state.selected.y === y) node.classList.add('selected');
      if (state.lastMove && state.lastMove.to.x === x && state.lastMove.to.y === y) node.classList.add('last-move-piece');
      node.style.setProperty('--x', x); node.style.setProperty('--y', y);
      node.textContent = PIECE_NAMES[piece.side][piece.type];
      node.setAttribute('aria-label', `${piece.side === 'red' ? '红方' : '黑方'}${PIECE_NAMES[piece.side][piece.type]}`);
      node.addEventListener('pointerdown', event => startDrag(event, x, y, node));
      node.addEventListener('pointermove', moveDrag);
      node.addEventListener('pointerup', event => finishDrag(event));
      node.addEventListener('pointercancel', event => finishDrag(event, true));
      node.addEventListener('click', event => { event.stopPropagation(); choose(x, y); });
      piecesEl.appendChild(node);
    }
  }

  function renderSquares() {
    squareNodes.forEach((square, index) => {
      const y = Math.floor(index / 9), x = index % 9;
      square.className = 'square';
      if (state.selected && state.selected.x === x && state.selected.y === y) square.classList.add('selected');
      if (state.targets.some(m => m.x === x && m.y === y)) {
        square.classList.add('target');
        if (state.board[y][x]) square.classList.add('capture');
      }
      if (state.lastMove && ((state.lastMove.from.x === x && state.lastMove.from.y === y) || (state.lastMove.to.x === x && state.lastMove.to.y === y))) square.classList.add('last-move');
    });
  }

  function renderMoves() {
    moveCountEl.textContent = `${state.moves.length} 手`;
    if (!state.moves.length) {
      moveListEl.innerHTML = '<div class="empty-moves"><span>♧</span><p>棋局尚未开始</p><small>每一步都会记录在这里</small></div>';
      return;
    }
    moveListEl.replaceChildren();
    for (let i = 0; i < state.moves.length; i += 2) {
      const row = document.createElement('div'); row.className = 'move-row';
      const number = document.createElement('span'); number.className = 'move-number'; number.textContent = `${Math.floor(i / 2) + 1}.`; row.appendChild(number);
      state.moves.slice(i, i + 2).forEach(move => {
        const cell = document.createElement('span'); cell.className = `move-cell ${move.side}-move`;
        const name = document.createElement('span'); name.className = 'move-piece'; name.textContent = move.notation.text;
        const dest = document.createElement('span'); dest.className = 'move-dest'; dest.textContent = move.notation.to;
        cell.append(name, dest); row.appendChild(cell);
      });
      if (row.children.length === 2) row.appendChild(document.createElement('span'));
      moveListEl.appendChild(row);
    }
    moveListEl.scrollTop = moveListEl.scrollHeight;
  }

  function renderStatus() {
    const active = state.gameOver ? state.winner : state.turn;
    const paused = Boolean(state.exitDeadline || state.exitedBy);
    turnTitle.textContent = paused ? '对局暂停' : state.gameOver ? `${state.winner === 'red' ? '红方' : '黑方'}获胜` : `${state.turn === 'red' ? '红方' : '黑方'}行棋`;
    turnStone.textContent = PIECE_NAMES[active].general;
    turnStone.className = `turn-stone ${active === 'red' ? 'red-stone' : 'black-stone'}`;
    checkBanner.hidden = !state.check || state.gameOver || paused;
    sideStrips.red.classList.toggle('active', !state.gameOver && !paused && state.turn === 'red');
    sideStrips.black.classList.toggle('active', !state.gameOver && !paused && state.turn === 'black');
    sideStatus.red.textContent = paused ? '对局暂停' : state.gameOver ? (state.winner === 'red' ? '胜利' : '对局结束') : state.turn === 'red' ? (state.check ? '红方被将军' : '轮到红方') : '等待行棋';
    sideStatus.black.textContent = paused ? '对局暂停' : state.gameOver ? (state.winner === 'black' ? '胜利' : '对局结束') : state.turn === 'black' ? (state.check ? '黑方被将军' : '轮到黑方') : '等待行棋';
    if (state.exitDeadline) {
      statusMessage.textContent = state.exitRequestedBy === onlineSession?.playerColor
        ? '你已退出，对局暂停中。可在倒计时结束前再次进入。'
        : '对方已经退出，对局暂停中。等待对方再次进入或结束本局。';
    } else if (state.exitedBy) {
      if (state.exitedBy === onlineSession?.playerColor) statusMessage.textContent = '你已经退出本局，棋盘已锁定。';
      else statusMessage.textContent = '对方已经退出，本局结束。棋盘已锁定。';
      if (state.restartVotes?.[onlineSession?.playerColor]) statusMessage.textContent += ' 已提出重新开始，等待对方确认。';
      else if (state.restartVotes?.[onlineSession?.playerColor === 'red' ? 'black' : 'red']) statusMessage.textContent += ' 对方请求重新开始，点击按钮确认。';
    }
    else if (state.gameOver) statusMessage.textContent = onlineSession ? `${state.winner === onlineSession.playerColor ? '你赢得' : '对手赢得'}本局。` : `${state.winner === 'red' ? '红方' : '黑方'}赢得本局。可以悔棋或重新开始。`;
    else if (onlineSession && !onlineSession.connected) statusMessage.textContent = '与对局服务器连接中断，正在尝试恢复…';
    else if (onlineSession && !state.opponentConnected) statusMessage.textContent = '房间已创建，等待对手加入后开始。';
    else if (onlineSession && onlinePending) statusMessage.textContent = '正在提交这步棋…';
    else if (onlineSession && state.turn !== onlineSession.playerColor) statusMessage.textContent = `等待${state.turn === 'red' ? '红方' : '黑方'}行棋。`;
    else if (state.check) statusMessage.textContent = `${state.turn === 'red' ? '红方' : '黑方'}正被将军，请先解将。`;
    else if (state.selected) statusMessage.textContent = `已选中${PIECE_NAMES[state.turn][state.board[state.selected.y][state.selected.x].type]}，请选择高亮位置。`;
    else statusMessage.textContent = `请选择一枚${state.turn === 'red' ? '红' : '黑'}方棋子开始。`;
    boardEl.classList.toggle('game-exited', paused);
    undoButton.disabled = onlineSession !== null || state.history.length === 0;
    restartButton.hidden = Boolean(onlineSession && (state.exitDeadline || (!state.exitedBy && !state.gameOver)));
    restartButton.disabled = onlineSession
      ? Boolean(state.exitDeadline) || (!state.exitedBy && !state.gameOver) || Boolean(state.restartVotes?.[onlineSession.playerColor])
      : state.history.length === 0;
    restartButton.textContent = onlineSession && (state.exitedBy || state.gameOver)
      ? state.restartVotes?.[onlineSession.playerColor] ? '等待对方确认' : state.restartVotes?.[onlineSession.playerColor === 'red' ? 'black' : 'red'] ? '同意重新开始' : '重新开始'
      : '＋ 重新开始';
    exitGameButton.hidden = !onlineSession || paused;
    exitGameButton.disabled = false;
    updateRoomDialog();
    renderTimer();
    renderExitCountdown();
  }

  function render() { renderSquares(); renderPieces(); renderMoves(); renderStatus(); }

  undoButton.addEventListener('click', undo);
  restartButton.addEventListener('click', () => { if (onlineSession) restartOnlineGame(); else reset(); });
  onlineButton.addEventListener('click', () => { onlineOverlay.hidden = false; updateRoomDialog(); });
  document.getElementById('close-online-dialog').addEventListener('click', () => { onlineOverlay.hidden = true; });
  onlineOverlay.addEventListener('click', event => { if (event.target === onlineOverlay) onlineOverlay.hidden = true; });
  document.getElementById('create-room-button').addEventListener('click', createRoom);
  document.getElementById('open-join-button').addEventListener('click', () => { onlineActions.hidden = true; joinRoomPanel.hidden = false; roomCodeInput.focus(); });
  document.getElementById('back-to-online-menu').addEventListener('click', () => { joinRoomPanel.hidden = true; onlineActions.hidden = false; onlineError.textContent = ''; });
  document.getElementById('join-room-button').addEventListener('click', joinRoom);
  roomCodeInput.addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
  roomCodeInput.addEventListener('input', () => { roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
  document.getElementById('leave-room-button').addEventListener('click', exitOnlineGame);
  exitGameButton.addEventListener('click', exitOnlineGame);
  document.getElementById('reenter-game-button').addEventListener('click', reenterOnlineGame);
  document.getElementById('leave-game-button').addEventListener('click', leaveOnlineGame);
  document.getElementById('copy-room-code').addEventListener('click', async event => {
    try { await navigator.clipboard.writeText(onlineSession.roomCode); event.currentTarget.textContent = '已复制'; }
    catch { roomCodeInput.value = onlineSession.roomCode; roomCodeInput.focus(); roomCodeInput.select(); event.currentTarget.textContent = '选中房间码'; }
  });
  document.getElementById('copy-room-link').addEventListener('click', async event => {
    try { await navigator.clipboard.writeText(roomLinkDisplay.value); event.currentTarget.textContent = '已复制'; }
    catch {
      roomLinkDisplay.focus();
      roomLinkDisplay.select();
      event.currentTarget.textContent = '选中链接';
    }
  });
  boardEl.addEventListener('click', event => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, true);
  boardEl.addEventListener('keydown', event => {
    if (event.key === 'Escape') { state.selected = null; state.targets = []; render(); }
  });

  makeSquares();
  boardEl.addEventListener('pointerup', finishDrag);
  boardEl.addEventListener('pointercancel', event => finishDrag(event, true));
  reset();
  if (!joinFromShareLink()) resumeRoom();
})();
