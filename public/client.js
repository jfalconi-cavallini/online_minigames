/* global io */
const socket = io();

// DOM refs
const feed = document.getElementById("feed");
const nameInput = document.getElementById("name");
const setNameBtn = document.getElementById("setName");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("join");
const gameSel = document.getElementById("game");
const selectGameBtn = document.getElementById("selectGame");
const resetGameBtn = document.getElementById("resetGame");

// Game panels
const guessPanel = document.getElementById("guess-ui");
const guessLetter = document.getElementById("guessLetter");
const sendGuess = document.getElementById("sendGuess");
const guessStatus = document.getElementById("guessStatus");

const tttPanel = document.getElementById("tictactoe-ui");
const tttBoard = document.getElementById("ttt-board");
const tttStatus = document.getElementById("tttStatus");

const ginPanel = document.getElementById("gin-ui");
const ginDrawStock = document.getElementById("ginDrawStock");
const ginDrawDiscard = document.getElementById("ginDrawDiscard");
const ginInfo = document.getElementById("ginInfo");
const ginTop = document.getElementById("ginTop");
const ginHand = document.getElementById("ginHand");

// Card tiles above buttons
const ginStockCard = document.getElementById("ginStockCard");
const ginDiscardCard = document.getElementById("ginDiscardCard");
const ginStockCount = document.getElementById("ginStockCount");

let currentRoomState = null;

// Server-authoritative hand (exact order server sent on last update)
let myGinHand = [];
// Local visual order (array of card strings), for drag-reordering
let myGinOrder = [];

// ----- helpers -----
function addLine(html, cls = "") {
  const p = document.createElement("p");
  p.className = cls;
  p.innerHTML = html;
  feed.appendChild(p);
  feed.scrollTop = feed.scrollHeight;
}

function setActiveGameUI(type) {
  guessPanel.classList.remove("active");
  tttPanel.classList.remove("active");
  ginPanel.classList.remove("active");
  if (type === "guess") guessPanel.classList.add("active");
  if (type === "tictactoe") tttPanel.classList.add("active");
  if (type === "gin") ginPanel.classList.add("active");
}

function clearNode(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// Big readable tiles (stock/discard)
function setBigTile(el, textOrEmpty) {
  if (!el) return;
  el.className = "card-visual"; // reset class
  if (!textOrEmpty) {
    el.textContent = "";
    el.classList.add("empty");
    return;
  }
  el.textContent = textOrEmpty;
  const red = textOrEmpty.includes("♥") || textOrEmpty.includes("♦");
  el.classList.add(red ? "red" : "black");
}

// Keep local order aligned with server hand while preserving user’s arrangement
function syncLocalOrder() {
  const serverSet = new Set(myGinHand);
  // 1) Drop cards no longer in hand
  myGinOrder = myGinOrder.filter(c => serverSet.has(c));
  // 2) Append any new cards at the end, in server order
  myGinHand.forEach(c => { if (!myGinOrder.includes(c)) myGinOrder.push(c); });
}

// ----- socket events -----
socket.on("system", (msg) => addLine(`<i>${msg}</i>`, "sys"));

socket.on("roomState", (payload) => {
  currentRoomState = payload;
  const { gameType } = payload || { gameType: "guess" };
  setActiveGameUI(gameType);

  if (gameType === "guess") renderGuess(payload);
  if (gameType === "tictactoe") renderTtt(payload);
  if (gameType === "gin") renderGin(payload);
});

socket.on("ginPrivate", ({ hand }) => {
  myGinHand = hand || [];
  syncLocalOrder();
  renderGin(currentRoomState);
});

// ----- Renders -----
function renderGuess(s) {
  const { history = [], winner } = s.state || {};
  guessStatus.textContent = winner ? `Winner: ${winner}` : `Make a guess (a-z)`;
  if (history.length) {
    const last = history[history.length - 1];
    addLine(`<b>Guess</b> — ${last.name} guessed "${last.guess}" (${last.result})`);
  }
}

function renderTtt(s) {
  const st = s.state || {};
  tttBoard.innerHTML = "";
  (st.board || []).forEach((cell, i) => {
    const btn = document.createElement("button");
    btn.textContent = cell || " ";
    btn.style.cursor = cell || st.winner || st.draw ? "not-allowed" : "pointer";
    btn.onclick = () => {
      if (cell || st.winner || st.draw) return;
      socket.emit("tttMove", i);
    };
    tttBoard.appendChild(btn);
  });
  if (st.winner) tttStatus.textContent = `Winner: ${st.winner}`;
  else if (st.draw) tttStatus.textContent = `Draw`;
  else tttStatus.textContent = `Turn: ${st.turn || "-"}`;
}

function renderGin(payload) {
  const st = (payload && payload.state) || {};
  const turn = st.current ? (st.current === socket.id ? "Your turn" : "Opponent's turn") : "Waiting for players";
  ginInfo.textContent = `Phase: ${st.phase || "-"} • ${turn} • Stock: ${st.stockCount ?? 0}`;
  ginTop.textContent = "Top discard: " + (st.discardTop || "(empty)");

  // Big tiles above buttons
  setBigTile(ginStockCard, (st.stockCount > 0) ? "🂠" : "");
  if (ginStockCount) ginStockCount.textContent = `Stock: ${st.stockCount ?? 0}`;
  setBigTile(ginDiscardCard, st.discardTop || "");

  // Enable/disable draw buttons
  const canDraw = (st.phase === "draw" && st.current === socket.id && !st.winner);
  ginDrawStock.disabled   = !(canDraw && (st.stockCount > 0));
  ginDrawDiscard.disabled = !(canDraw && !!st.discardTop);

  // Render hand with local order
  renderGinHand(st);
}

function renderGinHand(st) {
  clearNode(ginHand);
  const canDiscard = (st.current === socket.id) && (st.phase === "discard") && !st.winner;

  myGinOrder.forEach((card) => {
    const tile = document.createElement("div");
    tile.className = "hand-card " + ((card.includes("♥") || card.includes("♦")) ? "red" : "black");
    tile.textContent = card;
    tile.setAttribute("draggable", "true");
    tile.dataset.card = card;

    // Click to discard (maps back to server index)
    tile.addEventListener("click", () => {
      if (!canDiscard) return;
      const serverIdx = myGinHand.indexOf(card);
      if (serverIdx >= 0) socket.emit("ginDiscard", serverIdx);
    });

    // Drag & drop reorder
    tile.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card);
      // small drag image offset
      if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(tile, 42, 60);
    });

    tile.addEventListener("dragover", (e) => {
      e.preventDefault(); // allow drop
      // Decide before/after based on cursor position
      const rect = tile.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      tile.classList.toggle("drop-before", before);
      tile.classList.toggle("drop-after", !before);
    });

    tile.addEventListener("dragleave", () => {
      tile.classList.remove("drop-before", "drop-after");
    });

    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      tile.classList.remove("drop-before", "drop-after");
      const draggedCard = e.dataTransfer.getData("text/plain");
      if (!draggedCard || draggedCard === card) return;
      // Reorder myGinOrder
      const from = myGinOrder.indexOf(draggedCard);
      let to = myGinOrder.indexOf(card);
      if (from < 0 || to < 0) return;

      // Insert before/after based on where dropped
      const rect = tile.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;

      // Remove dragged
      myGinOrder.splice(from, 1);
      // Adjust target index if removing earlier element
      if (from < to) to -= 1;
      // Insert
      myGinOrder.splice(before ? to : to + 1, 0, draggedCard);

      renderGinHand(st); // re-render locally
    });

    ginHand.appendChild(tile);
  });
}

// ----- UI actions -----
setNameBtn.onclick = () => {
  const val = nameInput.value.trim();
  if (val) socket.emit("setName", val);
};

joinBtn.onclick = () => {
  const code = roomInput.value.trim() || "lobby";
  socket.emit("joinRoom", code);
  addLine(`Joined room <b>${code}</b>`);
};

selectGameBtn.onclick = () => {
  const type = gameSel.value;
  socket.emit("selectGame", type);
  addLine(`Game set to <b>${type}</b>`);
};

resetGameBtn.onclick = () => {
  if (!currentRoomState) return;
  const type = currentRoomState.gameType || "guess";
  socket.emit("selectGame", type); // re-init current game
  addLine(`<span class="sys">Game reset (${type})</span>`, "sys");
};

// Guess game
sendGuess.onclick = () => {
  const g = guessLetter.value.trim();
  if (g) socket.emit("guess", g);
  guessLetter.value = "";
  guessLetter.focus();
};
guessLetter.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendGuess.click();
});

// Gin
ginDrawStock.onclick = () => socket.emit("ginDraw", "stock");
ginDrawDiscard.onclick = () => socket.emit("ginDraw", "discard");
