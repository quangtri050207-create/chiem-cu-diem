const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname, { index: 'index.html' }));

const ROWS = 5, COLS = 6, TOTAL = ROWS * COLS;
const TEAM_IDS = ['t1', 't2', 't3', 't4', 't5', 't6'];
const START_TROOPS = 100;
const ZERO_BID_PENALTY = 5;
const ADJACENCY_BONUS = 10;
const BID_DURATION_MS = 10000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'admin123';

// Có thể đổi bằng biến môi trường TEAM_ACCOUNTS_JSON trên Render.
// Ví dụ: {"doi1":{"teamId":"t1","password":"abc"}}
const defaultAccounts = {
  doi1: { teamId: 't1', password: 'doi1@123' },
  doi2: { teamId: 't2', password: 'doi2@123' },
  doi3: { teamId: 't3', password: 'doi3@123' },
  doi4: { teamId: 't4', password: 'doi4@123' },
  doi5: { teamId: 't5', password: 'doi5@123' },
  doi6: { teamId: 't6', password: 'doi6@123' }
};
let TEAM_ACCOUNTS = defaultAccounts;
try {
  if (process.env.TEAM_ACCOUNTS_JSON) TEAM_ACCOUNTS = JSON.parse(process.env.TEAM_ACCOUNTS_JSON);
} catch (error) {
  console.error('TEAM_ACCOUNTS_JSON không hợp lệ, dùng tài khoản mặc định.');
}

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/questions.json'), 'utf8'));
let bidTimer = null;

function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildTiles() {
  const stars = [...Array(12).fill(10), ...Array(10).fill(15), ...Array(8).fill(20)];
  const order = shuffledIndices(TOTAL);
  const specials = shuffledIndices(TOTAL).slice(0, 5);
  const specialTypes = ['treasure', 'treasure', 'delete', 'delete', 'swap'];
  return Array.from({ length: TOTAL }, (_, i) => {
    const specialPos = specials.indexOf(i);
    const star = stars[order.indexOf(i)];
    return {
      idx: i, row: Math.floor(i / COLS), col: i % COLS, star, baseStar: star,
      type: specialPos >= 0 ? specialTypes[specialPos] : 'normal', owner: null, revealed: false
    };
  });
}

function freshTeams() {
  const teams = {};
  TEAM_IDS.forEach((id, i) => { teams[id] = { id, name: `Đội ${i + 1}`, troops: START_TROOPS }; });
  return teams;
}

function freshState() {
  return {
    phase: 'lobby', round: 0, tiles: buildTiles(), teams: freshTeams(), bids: {},
    bidSubmitted: {}, bidEndsAt: null, currentWinner: null, currentTileIdx: null,
    currentQuestionShown: null, lastAnswerCorrect: null, pendingSpecial: null, log: []
  };
}
let G = freshState();

function bonusTileSet() {
  const bonus = new Set();
  const owner = idx => G.tiles[idx].owner;
  for (let r = 0; r < ROWS; r++) {
    let runStart = 0;
    for (let c = 1; c <= COLS; c++) {
      const cur = c < COLS ? owner(r * COLS + c) : Symbol('end');
      const prev = owner(r * COLS + c - 1);
      if (cur !== prev) {
        if (c - runStart >= 3 && prev) for (let k = runStart; k < c; k++) bonus.add(r * COLS + k);
        runStart = c;
      }
    }
  }
  for (let c = 0; c < COLS; c++) {
    let runStart = 0;
    for (let r = 1; r <= ROWS; r++) {
      const cur = r < ROWS ? owner(r * COLS + c) : Symbol('end');
      const prev = owner((r - 1) * COLS + c);
      if (cur !== prev) {
        if (r - runStart >= 3 && prev) for (let k = runStart; k < r; k++) bonus.add(k * COLS + c);
        runStart = r;
      }
    }
  }
  return bonus;
}

function teamScore(teamId) {
  const bonus = bonusTileSet();
  return G.tiles.reduce((total, tile) => total + (tile.owner === teamId ? tile.star + (bonus.has(tile.idx) ? ADJACENCY_BONUS : 0) : 0), 0);
}
function scoreboard() {
  return TEAM_IDS.map(id => ({ id, name: G.teams[id].name, troops: G.teams[id].troops, score: teamScore(id) }))
    .sort((a, b) => b.score - a.score);
}
function publicTiles() {
  const bonus = bonusTileSet();
  return G.tiles.map(t => ({ idx: t.idx, row: t.row, col: t.col, star: t.star, owner: t.owner, type: t.revealed ? t.type : (t.owner ? t.type : 'hidden'), bonus: bonus.has(t.idx) }));
}
function stateFor(role, teamId) {
  return {
    phase: G.phase, round: G.round, tiles: publicTiles(), teams: G.teams,
    bidSubmitted: G.bidSubmitted, bidEndsAt: G.bidEndsAt,
    myBid: teamId ? (G.bids[teamId] ?? null) : null,
    revealedBids: G.phase !== 'bidding' ? G.bids : null,
    currentWinner: G.currentWinner, currentTileIdx: G.currentTileIdx,
    currentQuestion: G.phase === 'question' && (role === 'host' || role === 'screen' || teamId === G.currentWinner) ? G.currentQuestionShown : null,
    lastAnswerCorrect: G.lastAnswerCorrect, pendingSpecial: G.pendingSpecial,
    scoreboard: scoreboard(), log: G.log.slice(-12)
  };
}
function broadcast() {
  for (const [, sock] of io.of('/').sockets) {
    if (sock.data.role) sock.emit('state', stateFor(sock.data.role, sock.data.teamId));
  }
}
function addLog(msg) { G.log.push(msg); if (G.log.length > 50) G.log.shift(); }
function allTilesClaimed() { return G.tiles.every(t => t.owner !== null); }

function clearBidTimer() {
  if (bidTimer) clearTimeout(bidTimer);
  bidTimer = null;
}
function startBidTimer() {
  clearBidTimer();
  G.bidEndsAt = Date.now() + BID_DURATION_MS;
  const round = G.round;
  bidTimer = setTimeout(() => {
    if (G.phase === 'bidding' && G.round === round) {
      addLog('Hết 10 giây — các đội chưa đặt quân được tính là đặt 0.');
      resolveAuction();
      broadcast();
    }
  }, BID_DURATION_MS);
}
function startRound() {
  G.round += 1; G.bids = {}; G.bidSubmitted = {}; G.currentWinner = null;
  G.currentTileIdx = null; G.currentQuestionShown = null; G.lastAnswerCorrect = null; G.pendingSpecial = null; G.phase = 'bidding';
  addLog(`Vòng ${G.round} bắt đầu — thời gian đặt quân lệnh: 10 giây.`);
  startBidTimer();
}
function resolveAuction() {
  if (G.phase !== 'bidding') return;
  clearBidTimer(); G.bidEndsAt = null;
  TEAM_IDS.forEach(id => { if (!(id in G.bids)) G.bids[id] = 0; });
  const maxBid = Math.max(...TEAM_IDS.map(id => G.bids[id]));
  const topTeams = TEAM_IDS.filter(id => G.bids[id] === maxBid);
  const winner = topTeams[Math.floor(Math.random() * topTeams.length)];
  TEAM_IDS.forEach(id => { if (G.bids[id] === 0) G.teams[id].troops = Math.max(0, G.teams[id].troops - ZERO_BID_PENALTY); });
  G.teams[winner].troops = Math.max(0, G.teams[winner].troops - maxBid);
  G.currentWinner = winner; G.phase = 'tile_select';
  addLog(`${G.teams[winner].name} thắng đấu giá với ${maxBid} quân lệnh và được chọn ô đất.`);
}
function maybeAllBidsIn() { if (TEAM_IDS.every(id => G.bidSubmitted[id])) resolveAuction(); }
function applySpecialIfNeeded(tile) {
  if (tile.type === 'treasure') { tile.star = tile.baseStar * 2; addLog(`Ô ${tile.idx + 1} là KHO BÁU! Sao x2 = ${tile.star}.`); finishRound(); }
  else if (tile.type === 'delete' || tile.type === 'swap') { G.pendingSpecial = { type: tile.type, teamId: G.currentWinner }; G.phase = 'special'; addLog(tile.type === 'delete' ? 'Ô đặc biệt: XÓA ĐẤT!' : 'Ô đặc biệt: ĐỔI ĐẤT!'); }
  else finishRound();
}
function finishRound() { G.phase = 'round_end'; if (allTilesClaimed()) { G.phase = 'game_over'; addLog('Tất cả các ô đã có chủ — trận đấu kết thúc!'); } }

io.on('connection', socket => {
  socket.data = { role: null, teamId: null };
  socket.on('join', ({ role, teamId, username, password }) => {
    if (role === 'host') {
      if (password !== HOST_PASSWORD) return socket.emit('joinError', 'Sai mật khẩu ban tổ chức.');
      socket.data.role = 'host';
    } else if (role === 'screen') socket.data.role = 'screen';
    else if (role === 'team') {
      const account = TEAM_ACCOUNTS[username];
      if (!account || account.password !== password || !TEAM_IDS.includes(account.teamId)) return socket.emit('joinError', 'Sai tên đăng nhập hoặc mật khẩu đội.');
      socket.data.role = 'team'; socket.data.teamId = account.teamId;
    } else return socket.emit('joinError', 'Vai trò không hợp lệ.');
    socket.emit('joined', { role: socket.data.role, teamId: socket.data.teamId, teams: G.teams });
    socket.emit('state', stateFor(socket.data.role, socket.data.teamId));
  });
  socket.on('host:setTeamName', ({ teamId, name }) => { if (socket.data.role === 'host' && G.teams[teamId]) { G.teams[teamId].name = (name || '').slice(0, 30) || G.teams[teamId].name; broadcast(); } });
  socket.on('host:startGame', () => { if (socket.data.role === 'host') { clearBidTimer(); G = freshState(); startRound(); broadcast(); } });
  socket.on('host:forceReveal', () => { if (socket.data.role === 'host' && G.phase === 'bidding') { resolveAuction(); broadcast(); } });
  socket.on('host:nextRound', () => { if (socket.data.role === 'host' && G.phase === 'round_end') { startRound(); broadcast(); } });
  socket.on('host:resetGame', () => { if (socket.data.role === 'host') { clearBidTimer(); G = freshState(); broadcast(); } });
  socket.on('team:submitBid', ({ amount }) => {
    if (socket.data.role !== 'team' || G.phase !== 'bidding') return;
    const teamId = socket.data.teamId; if (G.bidSubmitted[teamId]) return;
    const bid = Math.max(0, Math.min(G.teams[teamId].troops, Math.floor(Number(amount) || 0)));
    G.bids[teamId] = bid; G.bidSubmitted[teamId] = true; addLog(`${G.teams[teamId].name} đã đặt quân lệnh (giữ kín).`); maybeAllBidsIn(); broadcast();
  });
  socket.on('team:selectTile', ({ tileIdx }) => {
    if (socket.data.role !== 'team' || G.phase !== 'tile_select' || socket.data.teamId !== G.currentWinner) return;
    const tile = G.tiles[tileIdx]; if (!tile || tile.owner) return;
    G.currentTileIdx = tileIdx; const q = QUESTIONS[tileIdx]; G.currentQuestionShown = { question: q.question, options: q.options }; G.phase = 'question'; addLog(`${G.teams[G.currentWinner].name} chọn ô ${tileIdx + 1} — câu hỏi hiện ra!`); broadcast();
  });
  socket.on('team:submitAnswer', ({ optionIndex }) => {
    if (socket.data.role !== 'team' || G.phase !== 'question' || socket.data.teamId !== G.currentWinner) return;
    const tile = G.tiles[G.currentTileIdx], q = QUESTIONS[G.currentTileIdx]; G.lastAnswerCorrect = optionIndex === q.correctIndex;
    if (G.lastAnswerCorrect) { tile.owner = G.currentWinner; tile.revealed = true; addLog(`${G.teams[G.currentWinner].name} trả lời ĐÚNG và chiếm ô ${tile.idx + 1}!`); applySpecialIfNeeded(tile); }
    else { addLog(`${G.teams[G.currentWinner].name} trả lời SAI — ô vẫn bỏ trống.`); finishRound(); }
    broadcast();
  });
  socket.on('team:specialDelete', ({ tileIdx }) => {
    if (socket.data.role !== 'team' || G.phase !== 'special' || !G.pendingSpecial || G.pendingSpecial.type !== 'delete' || G.pendingSpecial.teamId !== socket.data.teamId) return;
    const target = G.tiles[tileIdx]; if (!target || !target.owner || target.owner === socket.data.teamId) return;
    target.owner = null; target.revealed = false; G.pendingSpecial = null; finishRound(); broadcast();
  });
  socket.on('team:specialSwap', ({ tileA, tileB }) => {
    if (socket.data.role !== 'team' || G.phase !== 'special' || !G.pendingSpecial || G.pendingSpecial.type !== 'swap' || G.pendingSpecial.teamId !== socket.data.teamId) return;
    const a = G.tiles[tileA], b = G.tiles[tileB]; if (!a || !b || !a.owner || !b.owner || tileA === tileB) return;
    [a.owner, b.owner] = [b.owner, a.owner]; G.pendingSpecial = null; finishRound(); broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Chiếm Cứ Điểm chạy tại cổng ${PORT}`));
