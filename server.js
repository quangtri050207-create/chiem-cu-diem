const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Các file HTML/CSS/JS của dự án nằm ở thư mục gốc repository.
// Không dùng thư mục "public" vì repository hiện không có thư mục này.
app.use(express.static(__dirname, { index: 'index.html' }));

// ---------- CONFIG ----------
const ROWS = 5, COLS = 6, TOTAL = ROWS * COLS;
const TEAM_IDS = ['t1', 't2', 't3', 't4', 't5', 't6'];
const START_TROOPS = 100;
const ZERO_BID_PENALTY = 5;
const ADJACENCY_BONUS = 10;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'admin123';

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/questions.json'), 'utf8'));

function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildTiles() {
  // 12 tiles x10 sao, 10 tiles x15 sao, 8 tiles x20 sao
  const stars = [
    ...Array(12).fill(10),
    ...Array(10).fill(15),
    ...Array(8).fill(20)
  ];
  const order = shuffledIndices(TOTAL);
  const specials = shuffledIndices(TOTAL).slice(0, 5);
  const specialTypes = ['treasure', 'treasure', 'delete', 'delete', 'swap'];
  const tiles = [];
  for (let i = 0; i < TOTAL; i++) {
    const row = Math.floor(i / COLS), col = i % COLS;
    const star = stars[order.indexOf(i)];
    const specialPos = specials.indexOf(i);
    const type = specialPos >= 0 ? specialTypes[specialPos] : 'normal';
    tiles.push({ idx: i, row, col, star, baseStar: star, type, owner: null, revealed: false });
  }
  return tiles;
}

function freshTeams() {
  const teams = {};
  TEAM_IDS.forEach((id, i) => {
    teams[id] = { id, name: `Đội ${i + 1}`, troops: START_TROOPS };
  });
  return teams;
}

function freshState() {
  return {
    phase: 'lobby', // lobby | bidding | tile_select | question | special | round_end | game_over
    round: 0,
    tiles: buildTiles(),
    teams: freshTeams(),
    bids: {},           // teamId -> number (secret until revealed)
    bidSubmitted: {},   // teamId -> true
    currentWinner: null,
    currentTileIdx: null,
    currentQuestionShown: null, // {question, options} (no correctIndex)
    lastAnswerCorrect: null,
    pendingSpecial: null, // {type, teamId}
    log: []
  };
}

let G = freshState();

// ---------- SCORING ----------
function bonusTileSet() {
  const bonus = new Set();
  const owner = idx => G.tiles[idx].owner;
  // horizontal runs
  for (let r = 0; r < ROWS; r++) {
    let runStart = 0;
    for (let c = 1; c <= COLS; c++) {
      const cur = c < COLS ? owner(r * COLS + c) : Symbol('end');
      const prev = owner(r * COLS + (c - 1));
      if (cur !== prev) {
        const runLen = c - runStart;
        if (runLen >= 3 && prev) {
          for (let k = runStart; k < c; k++) bonus.add(r * COLS + k);
        }
        runStart = c;
      }
    }
  }
  // vertical runs
  for (let c = 0; c < COLS; c++) {
    let runStart = 0;
    for (let r = 1; r <= ROWS; r++) {
      const cur = r < ROWS ? owner(r * COLS + c) : Symbol('end');
      const prev = owner((r - 1) * COLS + c);
      if (cur !== prev) {
        const runLen = r - runStart;
        if (runLen >= 3 && prev) {
          for (let k = runStart; k < r; k++) bonus.add(k * COLS + c);
        }
        runStart = r;
      }
    }
  }
  return bonus;
}

function teamScore(teamId) {
  const bonus = bonusTileSet();
  let total = 0;
  G.tiles.forEach(t => {
    if (t.owner === teamId) total += t.star + (bonus.has(t.idx) ? ADJACENCY_BONUS : 0);
  });
  return total;
}

function scoreboard() {
  return TEAM_IDS.map(id => ({ id, name: G.teams[id].name, troops: G.teams[id].troops, score: teamScore(id) }))
    .sort((a, b) => b.score - a.score);
}

// ---------- STATE BROADCAST (redacted per-role) ----------
function publicTiles() {
  const bonus = bonusTileSet();
  return G.tiles.map(t => ({
    idx: t.idx, row: t.row, col: t.col, star: t.star, owner: t.owner,
    type: t.revealed ? t.type : (t.owner ? t.type : 'hidden'),
    bonus: bonus.has(t.idx)
  }));
}

function stateFor(role, teamId) {
  return {
    phase: G.phase,
    round: G.round,
    tiles: publicTiles(),
    teams: G.teams,
    bidSubmitted: G.bidSubmitted,
    myBid: teamId ? (G.bids[teamId] ?? null) : null,
    revealedBids: (G.phase !== 'bidding') ? G.bids : null,
    currentWinner: G.currentWinner,
    currentTileIdx: G.currentTileIdx,
    currentQuestion: (G.phase === 'question' &&
      (role === 'host' || role === 'screen' || teamId === G.currentWinner))
      ? G.currentQuestionShown : null,
    lastAnswerCorrect: G.lastAnswerCorrect,
    pendingSpecial: G.pendingSpecial,
    scoreboard: scoreboard(),
    log: G.log.slice(-12)
  };
}

function broadcast() {
  for (const [id, sock] of io.of('/').sockets) {
    const { role, teamId } = sock.data;
    if (role) sock.emit('state', stateFor(role, teamId));
  }
}

function addLog(msg) {
  G.log.push(msg);
  if (G.log.length > 50) G.log.shift();
}

// ---------- GAME FLOW ----------
function allTilesClaimed() {
  return G.tiles.every(t => t.owner !== null);
}

function startRound() {
  G.round += 1;
  G.bids = {};
  G.bidSubmitted = {};
  G.currentWinner = null;
  G.currentTileIdx = null;
  G.currentQuestionShown = null;
  G.lastAnswerCorrect = null;
  G.pendingSpecial = null;
  G.phase = 'bidding';
  addLog(`Vòng ${G.round} bắt đầu — các đội đặt quân lệnh bí mật.`);
}

function resolveAuction() {
  TEAM_IDS.forEach(id => { if (!(id in G.bids)) G.bids[id] = 0; });
  const maxBid = Math.max(...TEAM_IDS.map(id => G.bids[id]));
  const topTeams = TEAM_IDS.filter(id => G.bids[id] === maxBid);
  const winner = topTeams[Math.floor(Math.random() * topTeams.length)];

  TEAM_IDS.forEach(id => {
    if (G.bids[id] === 0) {
      G.teams[id].troops = Math.max(0, G.teams[id].troops - ZERO_BID_PENALTY);
    }
  });
  G.teams[winner].troops = Math.max(0, G.teams[winner].troops - maxBid);

  G.currentWinner = winner;
  G.phase = 'tile_select';
  addLog(`${G.teams[winner].name} thắng đấu giá với ${maxBid} quân lệnh và được chọn ô đất.`);
}

function maybeAllBidsIn() {
  if (TEAM_IDS.every(id => G.bidSubmitted[id])) resolveAuction();
}

function applySpecialIfNeeded(tile) {
  if (tile.type === 'treasure') {
    tile.star = tile.baseStar * 2;
    addLog(`Ô ${tile.idx + 1} là KHO BÁU! Sao của ô x2 = ${tile.star}.`);
    finishRound();
  } else if (tile.type === 'delete' || tile.type === 'swap') {
    G.pendingSpecial = { type: tile.type, teamId: G.currentWinner };
    G.phase = 'special';
    addLog(tile.type === 'delete'
      ? `Ô đặc biệt: XÓA ĐẤT! ${G.teams[G.currentWinner].name} hãy chọn 1 ô đối thủ để xóa.`
      : `Ô đặc biệt: ĐỔI ĐẤT! ${G.teams[G.currentWinner].name} hãy chọn 2 ô đã có chủ để hoán đổi.`);
  } else {
    finishRound();
  }
}

function finishRound() {
  G.phase = 'round_end';
  if (allTilesClaimed()) {
    G.phase = 'game_over';
    addLog('Tất cả các ô đã có chủ — trận đấu kết thúc!');
  }
}

// ---------- SOCKET HANDLERS ----------
io.on('connection', (socket) => {
  socket.data = { role: null, teamId: null };

  socket.on('join', ({ role, teamId, password }) => {
    if (role === 'host') {
      if (password !== HOST_PASSWORD) return socket.emit('joinError', 'Sai mật khẩu ban tổ chức.');
      socket.data.role = 'host';
    } else if (role === 'screen') {
      socket.data.role = 'screen';
    } else if (role === 'team' && TEAM_IDS.includes(teamId)) {
      socket.data.role = 'team';
      socket.data.teamId = teamId;
    } else {
      return socket.emit('joinError', 'Vai trò không hợp lệ.');
    }
    socket.emit('joined', { role: socket.data.role, teamId: socket.data.teamId, teams: G.teams });
    socket.emit('state', stateFor(socket.data.role, socket.data.teamId));
  });

  socket.on('host:setTeamName', ({ teamId, name }) => {
    if (socket.data.role !== 'host' || !G.teams[teamId]) return;
    G.teams[teamId].name = (name || '').slice(0, 30) || G.teams[teamId].name;
    broadcast();
  });

  socket.on('host:startGame', () => {
    if (socket.data.role !== 'host') return;
    G = freshState();
    startRound();
    broadcast();
  });

  socket.on('host:forceReveal', () => {
    if (socket.data.role !== 'host' || G.phase !== 'bidding') return;
    resolveAuction();
    broadcast();
  });

  socket.on('host:nextRound', () => {
    if (socket.data.role !== 'host' || G.phase !== 'round_end') return;
    startRound();
    broadcast();
  });

  socket.on('host:resetGame', () => {
    if (socket.data.role !== 'host') return;
    G = freshState();
    broadcast();
  });

  socket.on('team:submitBid', ({ amount }) => {
    if (socket.data.role !== 'team' || G.phase !== 'bidding') return;
    const teamId = socket.data.teamId;
    if (G.bidSubmitted[teamId]) return;
    const troops = G.teams[teamId].troops;
    const bid = Math.max(0, Math.min(troops, Math.floor(Number(amount) || 0)));
    G.bids[teamId] = bid;
    G.bidSubmitted[teamId] = true;
    addLog(`${G.teams[teamId].name} đã đặt quân lệnh (giữ kín).`);
    maybeAllBidsIn();
    broadcast();
  });

  socket.on('team:selectTile', ({ tileIdx }) => {
    if (socket.data.role !== 'team' || G.phase !== 'tile_select') return;
    if (socket.data.teamId !== G.currentWinner) return;
    const tile = G.tiles[tileIdx];
    if (!tile || tile.owner) return;
    G.currentTileIdx = tileIdx;
    const q = QUESTIONS[tileIdx];
    G.currentQuestionShown = { question: q.question, options: q.options };
    G.phase = 'question';
    addLog(`${G.teams[G.currentWinner].name} chọn ô ${tileIdx + 1} — câu hỏi hiện ra!`);
    broadcast();
  });

  socket.on('team:submitAnswer', ({ optionIndex }) => {
    if (socket.data.role !== 'team' || G.phase !== 'question') return;
    if (socket.data.teamId !== G.currentWinner) return;
    const tile = G.tiles[G.currentTileIdx];
    const q = QUESTIONS[G.currentTileIdx];
    const correct = optionIndex === q.correctIndex;
    G.lastAnswerCorrect = correct;
    if (correct) {
      tile.owner = G.currentWinner;
      tile.revealed = true;
      addLog(`${G.teams[G.currentWinner].name} trả lời ĐÚNG và chiếm được ô ${tile.idx + 1}!`);
      applySpecialIfNeeded(tile);
    } else {
      addLog(`${G.teams[G.currentWinner].name} trả lời SAI — ô ${tile.idx + 1} vẫn bỏ trống.`);
      finishRound();
    }
    broadcast();
  });

  socket.on('team:specialDelete', ({ tileIdx }) => {
    if (socket.data.role !== 'team' || G.phase !== 'special') return;
    if (!G.pendingSpecial || G.pendingSpecial.type !== 'delete' || G.pendingSpecial.teamId !== socket.data.teamId) return;
    const target = G.tiles[tileIdx];
    if (!target || !target.owner || target.owner === socket.data.teamId) return;
    addLog(`${G.teams[socket.data.teamId].name} xóa quyền sở hữu ô ${tileIdx + 1} của ${G.teams[target.owner].name}!`);
    target.owner = null;
    target.revealed = false;
    G.pendingSpecial = null;
    finishRound();
    broadcast();
  });

  socket.on('team:specialSwap', ({ tileA, tileB }) => {
    if (socket.data.role !== 'team' || G.phase !== 'special') return;
    if (!G.pendingSpecial || G.pendingSpecial.type !== 'swap' || G.pendingSpecial.teamId !== socket.data.teamId) return;
    const a = G.tiles[tileA], b = G.tiles[tileB];
    if (!a || !b || !a.owner || !b.owner || tileA === tileB) return;
    [a.owner, b.owner] = [b.owner, a.owner];
    addLog(`${G.teams[socket.data.teamId].name} hoán đổi chủ sở hữu ô ${tileA + 1} và ${tileB + 1}!`);
    G.pendingSpecial = null;
    finishRound();
    broadcast();
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Chiếm Cứ Điểm chạy tại cổng ${PORT} (mật khẩu host: ${HOST_PASSWORD})`));
