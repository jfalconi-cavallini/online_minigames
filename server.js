// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const rooms = Object.create(null);
function ensureRoom(code) {
  if (!rooms[code]) {
    rooms[code] = { code, players: [], names: {}, gameType: "guess", state: null };
    initGuess(rooms[code]);
  }
  return rooms[code];
}
function removeFromArray(a, v) { const i = a.indexOf(v); if (i >= 0) a.splice(i, 1); }
function systemMsg(room, msg) { io.to(room.code).emit("system", msg); }
function emitRoomState(room) {
  if (!room) return;
  const payload = { gameType: room.gameType, state: null };
  if (room.gameType === "gin") {
    const g = room.state;
    payload.state = ginPublicView(g);
    // private hands
    for (const id of g.players) {
      const s = io.sockets.sockets.get(id);
      if (s) s.emit("ginPrivate", { hand: g.hands[id] || [] });
    }
  } else {
    payload.state = room.state;
  }
  io.to(room.code).emit("roomState", payload);
}

/* ---------------- Guess ---------------- */
function initGuess(room) {
  room.gameType = "guess";
  room.state = {
    secret: String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    history: [],
    winner: null,
  };
}
function handleGuess(room, socket, guess) {
  if (room.gameType !== "guess") return;
  const g = (guess || "").toString().trim().toLowerCase().slice(0, 1);
  if (!g) return;
  const name = room.names[socket.id] || socket.id.slice(0, 5);
  let result = "miss";
  if (g === room.state.secret) {
    room.state.winner = name;
    result = "hit";
    room.state.secret = String.fromCharCode(97 + Math.floor(Math.random() * 26));
  }
  room.state.history.push({ name, guess: g, result });
}

/* --------------- Tic-Tac-Toe --------------- */
function initTicTacToe(room) {
  room.gameType = "tictactoe";
  const p1 = room.players[0] || null;
  const p2 = room.players[1] || null;
  const marks = {};
  if (p1) marks[p1] = "X";
  if (p2) marks[p2] = "O";
  room.state = { board: Array(9).fill(null), turn: "X", winner: null, draw: false, marks };
}
function tttCheckWinner(b) {
  const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b2,c] of wins) if (b[a] && b[a] === b[b2] && b[a] === b[c]) return b[a];
  return null;
}
function handleTttMove(room, socket, idx) {
  if (room.gameType !== "tictactoe") return;
  const s = room.state;
  if (s.winner || s.draw) return;
  const mark = s.marks[socket.id];
  if (!mark || mark !== s.turn) return;
  if (idx < 0 || idx >= 9 || s.board[idx]) return;
  s.board[idx] = mark;
  const w = tttCheckWinner(s.board);
  if (w) s.winner = w;
  else if (s.board.every(Boolean)) s.draw = true;
  else s.turn = (s.turn === "X") ? "O" : "X";
}

/* ---------------- Gin Rummy (MVP) ---------------- */
const SUITS = ["♠","♥","♦","♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(`${r}${s}`);
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function ginHasTwo(room) { return room.state && room.state.players.length === 2; }
function ginPublicView(g) {
  return {
    type: "gin",
    phase: g.phase,
    current: g.current,
    players: g.players,
    waitingForPlayers: g.waitingForPlayers,
    stockCount: g.stock.length,
    discardTop: g.discard[g.discard.length - 1] || null,
    handCounts: Object.fromEntries(Object.entries(g.hands).map(([id, arr]) => [id, arr.length])),
    winner: g.winner || null,
  };
}

/* --- Gin helpers: parsing, meld generation, and "isGin" check --- */
const RANK_TO_VAL = Object.fromEntries(RANKS.map((r, i) => [r, i + 1]));
function parseCard(c) {
  const m = /^(A|2|3|4|5|6|7|8|9|10|J|Q|K)([♠♥♦♣])$/.exec(c);
  if (!m) return null;
  return { rank: m[1], suit: m[2], val: RANK_TO_VAL[m[1]] };
}
function generateSetMelds(hand) {
  const byRank = {};
  hand.forEach((c, i) => {
    const pc = parseCard(c);
    if (!pc) return;
    byRank[pc.rank] = byRank[pc.rank] || [];
    byRank[pc.rank].push(i);
  });
  const melds = [];
  for (const rank in byRank) {
    const idxs = byRank[rank];
    if (idxs.length >= 3) {
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          for (let c = b + 1; c < idxs.length; c++) {
            melds.push([idxs[a], idxs[b], idxs[c]]);
          }
        }
      }
      if (idxs.length === 4) melds.push([...idxs]);
    }
  }
  return melds;
}
function generateRunMelds(hand) {
  const bySuit = {};
  hand.forEach((c, i) => {
    const pc = parseCard(c);
    if (!pc) return;
    bySuit[pc.suit] = bySuit[pc.suit] || [];
    bySuit[pc.suit].push({ i, v: pc.val });
  });
  const melds = [];
  for (const suit in bySuit) {
    const arr = bySuit[suit].slice().sort((a, b) => a.v - b.v);
    const n = arr.length;
    const isConsec = (start, len) => {
      for (let k = 0; k < len - 1; k++) {
        if (arr[start + k + 1].v !== arr[start + k].v + 1) return false;
      }
      return true;
    };
    for (let s = 0; s <= n - 3; s++) {
      if (isConsec(s, 3)) melds.push([arr[s].i, arr[s + 1].i, arr[s + 2].i]);
    }
    for (let s = 0; s <= n - 4; s++) {
      if (isConsec(s, 4)) melds.push([arr[s].i, arr[s + 1].i, arr[s + 2].i, arr[s + 3].i]);
    }
  }
  return melds;
}
function isDisjoint(a, b) {
  const set = new Set(a);
  return b.every(x => !set.has(x));
}
// Hand wins if 10 cards can be partitioned into 3 melds of sizes 4,3,3 (runs or sets)
function isGin(hand) {
  if (!hand || hand.length !== 10) return false;
  const sets = generateSetMelds(hand);
  const runs = generateRunMelds(hand);
  const threes = [...sets, ...runs].filter(m => m.length === 3);
  const fours  = [...sets, ...runs].filter(m => m.length === 4);
  for (const m4 of fours) {
    for (let i = 0; i < threes.length; i++) {
      const m3a = threes[i];
      if (!isDisjoint(m4, m3a)) continue;
      for (let j = i + 1; j < threes.length; j++) {
        const m3b = threes[j];
        if (!isDisjoint(m4, m3b)) continue;
        if (!isDisjoint(m3a, m3b)) continue;
        const union = new Set([...m4, ...m3a, ...m3b]);
        if (union.size === 10) return true;
      }
    }
  }
  return false;
}

/** Fresh init (optionally with chosen seats) */
function ginInit(room, seatsOverride = null) {
  room.gameType = "gin";
  const deck = makeDeck();
  let seats = seatsOverride ? seatsOverride.slice(0,2) : [];
  if (seats.length === 0) {
    for (const id of room.players) { if (seats.length < 2) seats.push(id); }
  }
  const hands = {};
  for (const id of seats) hands[id] = deck.splice(0, 10);
  const discard = deck.splice(0, 1);
  room.state = {
    type: "gin",
    phase: seats.length === 2 ? "draw" : "wait",
    current: seats.length === 2 ? seats[0] : null,
    players: seats,
    hands,
    stock: deck,
    discard,
    waitingForPlayers: seats.length < 2,
    winner: null,
  };
}
/** Ensure seating correctness, deal second hand on join, or redeal if needed. */
function ginEnsureSeating(room) {
  if (room.gameType !== "gin" || !room.state) return;
  const g = room.state;

  const desired = [];
  for (const id of room.players) { if (desired.length < 2) desired.push(id); }

  const same =
    desired.length === g.players.length &&
    desired.every((id, i) => id === g.players[i]);

  if (!same) {
    const newlySeated = desired.filter(id => !g.players.includes(id));
    const removedSeats = g.players.filter(id => !desired.includes(id));

    for (const id of removedSeats) delete g.hands[id];

    if (newlySeated.length === 1 && desired.length === 2 && g.players.length === 1) {
      const newId = newlySeated[0];
      if (!g.hands[newId]) g.hands[newId] = [];
      if (g.stock.length >= 10) {
        g.hands[newId].push(...g.stock.splice(0,10));
        g.players = desired;
        g.waitingForPlayers = false;
        g.phase = "draw";
        if (!g.current || !g.players.includes(g.current)) g.current = g.players[0];
      } else {
        ginInit(room, desired);
      }
    } else {
      ginInit(room, desired);
    }
  }

  if (g.players.length < 2) {
    g.phase = "wait";
    g.current = null;
    g.waitingForPlayers = true;
  }
}

/* ---------------- Socket.IO ---------------- */
io.on("connection", (socket) => {
  socket.data.displayName = `Player-${(Math.random()*10000|0)}`;

  socket.on("setName", (name) => {
    const val = (name || "").toString().trim();
    if (val) socket.data.displayName = val;
    const room = socket.data.room ? rooms[socket.data.room] : null;
    if (room) { room.names[socket.id] = socket.data.displayName; emitRoomState(room); }
  });

  socket.on("joinRoom", (code) => {
    const roomCode = (code || "lobby").toString().trim();

    if (socket.data.room) {
      const old = rooms[socket.data.room];
      if (old) {
        removeFromArray(old.players, socket.id);
        delete old.names[socket.id];
        socket.leave(old.code);
        if (old.gameType === "gin") ginEnsureSeating(old);
        emitRoomState(old);
      }
    }

    const room = ensureRoom(roomCode);
    socket.join(roomCode);
    socket.data.room = roomCode;

    if (!room.players.includes(socket.id)) room.players.push(socket.id);
    room.names[socket.id] = socket.data.displayName;

    if (room.gameType === "gin") ginEnsureSeating(room);
    systemMsg(room, `${socket.data.displayName} joined ${roomCode}`);
    emitRoomState(room);
  });

  socket.on("selectGame", (type) => {
    const room = socket.data.room ? rooms[socket.data.room] : null;
    if (!room) return;
    if (!["guess","tictactoe","gin"].includes(type)) return;

    if (type === "guess") initGuess(room);
    if (type === "tictactoe") initTicTacToe(room);
    if (type === "gin") { ginInit(room); ginEnsureSeating(room); }

    systemMsg(room, `${socket.data.displayName} set game to ${type}`);
    emitRoomState(room);
  });

  // Guess
  socket.on("guess", (g) => {
    const room = socket.data.room ? rooms[socket.data.room] : null;
    if (!room || room.gameType !== "guess") return;
    handleGuess(room, socket, g);
    emitRoomState(room);
  });

  // TicTacToe
  socket.on("tttMove", (idx) => {
    const room = socket.data.room ? rooms[socket.data.room] : null;
    if (!room || room.gameType !== "tictactoe") return;
    handleTttMove(room, socket, idx|0);
    emitRoomState(room);
  });

  // Gin: draw (only when 2 players and it's your draw phase)
  socket.on("ginDraw", (from) => {
    const room = socket.data.room ? rooms[socket.data.room] : null;
    if (!room || room.gameType !== "gin") return;
    ginEnsureSeating(room);
    const g = room.state;

    if (!ginHasTwo(room)) { systemMsg(room, "Waiting for a second player…"); return; }
    if (g.phase === "over") return;
    if (g.current !== socket.id || g.phase !== "draw") return;

    if (from === "stock" && g.stock.length > 0) {
      g.hands[socket.id].push(g.stock.pop());
      g.phase = "discard";
    } else if (from === "discard" && g.discard.length > 0) {
      g.hands[socket.id].push(g.discard.pop());
      g.phase = "discard";
    }
    emitRoomState(room);
  });

  // Gin: discard (only when 2 players and it's your discard phase)
  socket.on("ginDiscard", (handIndex) => {
    const room = socket.data.room ? rooms[socket.data.room] : null;
    if (!room || room.gameType !== "gin") return;
    ginEnsureSeating(room);
    const g = room.state;

    if (!ginHasTwo(room)) { systemMsg(room, "Waiting for a second player…"); return; }
    if (g.phase === "over") return;
    if (g.current !== socket.id || g.phase !== "discard") return;

    const hand = g.hands[socket.id] || [];
    const i = handIndex|0;
    if (i < 0 || i >= hand.length) return;

    const [card] = hand.splice(i, 1);
    g.discard.push(card);

    // After discard, hand is 10 → check "gone gin" (3/3/4 partition of valid melds)
    if (isGin(hand)) {
      g.phase = "over";
      g.winner = socket.id;
      systemMsg(room, `${room.names[socket.id] || "Player"} went GIN!`);
      emitRoomState(room);
      return;
    }

    // Pass the turn
    const idx = g.players.indexOf(socket.id);
    g.current = g.players[(idx + 1) % g.players.length];
    g.phase = "draw";

    emitRoomState(room);
  });

  socket.on("disconnect", () => {
    const room = socket.data.room ? rooms[socket.data.room] : null;
    if (!room) return;
    removeFromArray(room.players, socket.id);
    delete room.names[socket.id];
    if (room.gameType === "gin") ginEnsureSeating(room);
    systemMsg(room, `${socket.data.displayName} left`);
    emitRoomState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running http://localhost:${PORT}`));
