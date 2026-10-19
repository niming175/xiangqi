'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const Rules = require('./rules.js');

const HOST = process.env.GAME_HOST || '127.0.0.1';
const PORT = Number(process.env.GAME_PORT || 4400);
const ROOM_TTL = 6 * 60 * 60 * 1000;
const MAX_ROOMS = 300;
const ROOT = __dirname;
const rooms = new Map();
const FILES = '一二三四五六七八九';
const PIECE_NAMES = Rules.PIECE_NAMES;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function fail(res, status, message) { json(res, status, { error: message }); }
function newToken() { return crypto.randomBytes(24).toString('base64url'); }
function createCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(6), n => alphabet[n % alphabet.length]).join(''); } while (rooms.has(code));
  return code;
}
function playerForToken(room, token) {
  if (typeof token !== 'string' || token.length < 30 || token.length > 80) return null;
  for (const side of ['red', 'black']) if (room.players[side]?.token === token) return side;
  return null;
}
function moveNotation(piece, from, to, side) {
  const sameFile = from.x === to.x;
  const forward = side === 'red' ? -1 : 1;
  let action = sameFile ? (to.y < from.y ? '进' : '退') : '平';
  if (['horse', 'elephant', 'advisor'].includes(piece.type)) action = to.y < from.y ? '进' : to.y > from.y ? '退' : '平';
  if (piece.type === 'soldier' && !sameFile && to.y === from.y) action = '平';
  const number = sameFile ? String(Math.abs(to.y - from.y)) : FILES[(side === 'red' ? 9 - to.x : to.x + 1) - 1];
  const file = FILES[(side === 'red' ? 9 - from.x : from.x + 1) - 1];
  return { text: `${PIECE_NAMES[side][piece.type]}${file}${action}${['horse', 'elephant', 'advisor'].includes(piece.type) ? '' : number}`, to: FILES[(side === 'red' ? 9 - to.x : to.x + 1) - 1] + String(10 - to.y) };
}
function snapshot(room, side) {
  return {
    roomCode: room.code, version: room.version, board: room.board, turn: room.turn,
    moves: room.moves, lastMove: room.lastMove, gameOver: room.gameOver,
    winner: room.winner, check: room.check, playerColor: side,
    startedAt: room.startedAt, finishedAt: room.finishedAt,
    exitedBy: room.exitedBy, exitRequestedBy: room.exitRequestedBy,
    exitDeadline: room.exitDeadline, pausedAt: room.pausedAt,
    restartVotes: room.restartVotes, round: room.round,
    opponentConnected: Boolean(room.players[side === 'red' ? 'black' : 'red']?.connected)
  };
}
function publish(room) {
  for (const side of ['red', 'black']) {
    const player = room.players[side];
    if (player?.stream && !player.stream.destroyed) player.stream.write(`event: state\ndata: ${JSON.stringify(snapshot(room, side))}\n\n`);
  }
}
function closeRoom(room, reason) {
  for (const side of ['red', 'black']) {
    const player = room.players[side];
    const stream = player?.stream;
    if (stream && !stream.destroyed) { stream.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`); stream.end(); }
    if (player) { player.stream = null; player.connected = false; }
  }
  if (room.exitTimer) clearTimeout(room.exitTimer);
  rooms.delete(room.code);
}
function touch(room) { room.updatedAt = Date.now(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 8192) { reject(Object.assign(new Error('请求内容过大'), { status: 413 })); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error('请求格式无效'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function originMatches(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const forwardedHost = req.headers['x-forwarded-host'];
    return originHost === (forwardedHost || req.headers.host);
  } catch { return false; }
}
function getRoom(code) { return rooms.get(String(code || '').toUpperCase()); }
function setStream(req, res, room, side) {
  const player = room.players[side];
  if (player.stream && player.stream !== res) player.stream.end();
  player.stream = res; player.connected = true; touch(room);
  if (room.players.red?.connected && room.players.black?.connected && !room.startedAt && !room.exitDeadline && !room.exitedBy) room.startedAt = Date.now();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff'
  });
  res.write(`event: state\ndata: ${JSON.stringify(snapshot(room, side))}\n\n`);
  publish(room);
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 20000);
  res.on('close', () => {
    clearInterval(heartbeat);
    if (player.stream === res) {
      player.stream = null; player.connected = false; touch(room); publish(room);
    }
  });
}

async function handleApi(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originMatches(req)) return fail(res, 403, '来源不匹配');
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    if (rooms.size >= MAX_ROOMS) return fail(res, 503, '房间暂时已满，请稍后再试');
    const body = await readBody(req);
    if (body && Object.keys(body).length) return fail(res, 400, '创建请求不应包含数据');
    const code = createCode(); const token = newToken();
    const room = {
      code, board: Rules.initialBoard(), turn: 'red', version: 0, moves: [], lastMove: null,
      gameOver: false, winner: null, check: false, startedAt: null, finishedAt: null,
      exitedBy: null, exitRequestedBy: null, exitDeadline: null, pausedAt: null, exitTimer: null,
      restartVotes: { red: false, black: false }, round: 1, updatedAt: Date.now(),
      players: { red: { token, connected: false, stream: null }, black: null }
    };
    rooms.set(code, room);
    return json(res, 201, { roomCode: code, playerColor: 'red', token, state: snapshot(room, 'red') });
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|state|events|move|leave|exit|reenter|restart))?$/i);
  if (!roomMatch) return fail(res, 404, '接口不存在');
  const room = getRoom(roomMatch[1]);
  if (!room) return fail(res, 404, '房间不存在或已过期');
  const action = roomMatch[2] || 'state';

  if (req.method === 'POST' && action === 'join') {
    await readBody(req);
    if (room.exitDeadline || room.exitedBy) return fail(res, 409, '本局正在退出或已经结束，无法加入');
    if (room.players.black) return fail(res, 409, '黑方席位已有人');
    const token = newToken(); room.players.black = { token, connected: false, stream: null }; touch(room);
    publish(room);
    return json(res, 200, { roomCode: room.code, playerColor: 'black', token, state: snapshot(room, 'black') });
  }

  if (req.method === 'POST' && action === 'leave') {
    const body = await readBody(req);
    const side = playerForToken(room, body.token);
    if (!side) return fail(res, 401, '房间令牌无效');
    closeRoom(room, 'left');
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && action === 'exit') {
    const body = await readBody(req);
    const side = playerForToken(room, body.token);
    if (!side) return fail(res, 401, '房间令牌无效');
    if (!room.exitDeadline) {
      const now = Date.now();
      room.exitRequestedBy = side;
      room.exitDeadline = now + 30000;
      room.pausedAt = now;
      room.restartVotes = { red: false, black: false };
      room.version++;
      touch(room);
      publish(room);
      const deadline = room.exitDeadline;
      room.exitTimer = setTimeout(() => {
        if (room.exitDeadline === deadline) closeRoom(room, 'expired');
      }, Math.max(0, deadline - Date.now()));
    }
    return json(res, 200, { state: snapshot(room, side) });
  }

  if (req.method === 'POST' && action === 'reenter') {
    const body = await readBody(req);
    const side = playerForToken(room, body.token);
    if (!side) return fail(res, 401, '房间令牌无效');
    if (!room.exitDeadline) return fail(res, 409, '当前没有待恢复的退出状态');
    const now = Date.now();
    if (now >= room.exitDeadline) {
      closeRoom(room, 'expired');
      return fail(res, 410, '退出倒计时已结束');
    }
    if (room.exitTimer) clearTimeout(room.exitTimer);
    if (room.pausedAt) {
      const pausedDuration = now - room.pausedAt;
      if (room.startedAt) room.startedAt += pausedDuration;
      if (room.finishedAt) room.finishedAt += pausedDuration;
    }
    room.exitRequestedBy = null; room.exitDeadline = null; room.pausedAt = null; room.exitTimer = null;
    room.version++; touch(room); publish(room);
    return json(res, 200, { state: snapshot(room, side) });
  }

  if (req.method === 'POST' && action === 'restart') {
    const body = await readBody(req);
    const side = playerForToken(room, body.token);
    if (!side) return fail(res, 401, '房间令牌无效');
    if (room.exitDeadline) return fail(res, 409, '请先结束退出倒计时或再次进入');
    if (!room.exitedBy && !room.gameOver) return fail(res, 409, '当前对局还不能重新开始');
    room.restartVotes[side] = true;
    if (room.restartVotes.red && room.restartVotes.black) {
      room.board = Rules.initialBoard(); room.turn = 'red'; room.moves = []; room.lastMove = null;
      room.gameOver = false; room.winner = null; room.check = false;
      room.exitedBy = null; room.exitRequestedBy = null; room.exitDeadline = null; room.pausedAt = null;
      room.restartVotes = { red: false, black: false };
      room.startedAt = room.players.red.connected && room.players.black.connected ? Date.now() : null;
      room.finishedAt = null; room.round++; room.version++;
    }
    touch(room); publish(room);
    return json(res, 200, { state: snapshot(room, side) });
  }

  if (req.method === 'GET' && (action === 'state' || action === 'events')) {
    const side = playerForToken(room, url.searchParams.get('token'));
    if (!side) return fail(res, 401, '房间令牌无效');
    if (action === 'events') return setStream(req, res, room, side);
    touch(room); return json(res, 200, { state: snapshot(room, side) });
  }

  if (req.method === 'POST' && action === 'move') {
    const body = await readBody(req);
    const side = playerForToken(room, body.token);
    if (!side) return fail(res, 401, '房间令牌无效');
    if (room.exitDeadline || room.exitedBy) return fail(res, 409, '本局暂不可行棋');
    if (!room.players.black) return fail(res, 409, '请等待对手加入房间');
    if (room.gameOver) return fail(res, 409, '本局已经结束');
    if (!Number.isInteger(body.version) || body.version !== room.version) return fail(res, 409, '棋局已更新，请等待同步');
    if (side !== room.turn) return fail(res, 403, '还没有轮到你');
    const from = body.from, to = body.to;
    if (!from || !to || !Number.isInteger(from.x) || !Number.isInteger(from.y) || !Number.isInteger(to.x) || !Number.isInteger(to.y) || !Rules.inside(from.x, from.y) || !Rules.inside(to.x, to.y)) return fail(res, 400, '落子位置无效');
    const piece = room.board[from.y][from.x];
    if (!piece || piece.side !== side) return fail(res, 400, '起点没有你的棋子');
    if (!Rules.legalMoves(room.board, from.x, from.y).some(move => move.x === to.x && move.y === to.y)) return fail(res, 400, '这步棋不合法');
    const captured = room.board[to.y][to.x];
    room.board[to.y][to.x] = piece; room.board[from.y][from.x] = null;
    room.lastMove = { from, to };
    room.moves.push({ side, notation: moveNotation(piece, from, to, side), captured: Boolean(captured) });
    room.turn = side === 'red' ? 'black' : 'red'; room.version++;
    room.check = Rules.inCheck(room.board, room.turn);
    if (captured?.type === 'general' || !Rules.anyLegalMove(room.board, room.turn)) {
      room.gameOver = true; room.winner = side; room.check = false; room.finishedAt = Date.now();
    }
    touch(room); publish(room);
    return json(res, 200, { state: snapshot(room, side) });
  }

  return fail(res, 405, '请求方法不支持');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return fail(res, 404, '仅提供局域网对局接口；页面由 Nginx 提供');
  } catch (error) {
    if (!res.headersSent && !res.destroyed) fail(res, error.status || 500, error.status ? error.message : '服务暂时无法处理请求');
    else if (!res.destroyed) res.end();
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.updatedAt > ROOM_TTL) {
    for (const side of ['red', 'black']) room.players[side]?.stream?.end();
    rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => console.log(`Xiangqi room service listening on http://${HOST}:${PORT}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
