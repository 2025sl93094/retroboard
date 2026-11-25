const COLUMNS = ["went_well", "didnt_go_well", "action_items"];

// ── User token (persisted per browser) ───────────────────────────────────────

function getUserToken() {
  let token = localStorage.getItem("retro_user_token");
  if (!token) {
    token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    localStorage.setItem("retro_user_token", token);
  }
  return token;
}

const USER_TOKEN = getUserToken();

// ── Facilitator state ─────────────────────────────────────────────────────────

let _boardState = {
  phase: "collecting",
  notes_revealed: false,
  columns_locked: false,
  voting_ends_at: null,
};
let _timerInterval = null;

// ── Socket.IO ─────────────────────────────────────────────────────────────────

const socket = io();

socket.on("connect", () => {
  socket.emit("join_board", { board_id: BOARD_ID });
});

socket.on("presence", ({ count }) => {
  const el = document.getElementById("presence");
  if (el) el.textContent = count === 1 ? "● 1 person active" : `● ${count} people active`;
});

let _suppressNextBoardUpdate = false;

socket.on("board_updated", () => {
  if (_suppressNextBoardUpdate) {
    _suppressNextBoardUpdate = false;
    return;
  }
  loadBoard();
});

socket.on("board_state", (state) => {
  _boardState = state;
  applyBoardState(state);
});

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  await loadBoard();
  document.getElementById("exportBtn").href = `/api/boards/${BOARD_ID}/export`;
  document.getElementById("copyBtn").addEventListener("click", copyLink);

  document.querySelectorAll(".btn-add").forEach(btn => {
    btn.addEventListener("click", () => addNote(btn.dataset.column));
  });

  document.querySelectorAll(".note-input").forEach(input => {
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        addNote(input.id.replace("input-", ""));
      }
    });
  });

  if (IS_FACILITATOR) {
    document.getElementById("facilitatorBar").style.display = "flex";
  }
}

// ── Load Board ───────────────────────────────────────────────────────────────

let _votedNotes = new Set();

async function loadBoard() {
  const boardUrl = IS_FACILITATOR
    ? `/api/boards/${BOARD_ID}?facilitator_token=${FACILITATOR_TOKEN}`
    : `/api/boards/${BOARD_ID}`;

  const [boardRes, votesRes] = await Promise.all([
    fetch(boardUrl),
    fetch(`/api/boards/${BOARD_ID}/my_votes?user_token=${USER_TOKEN}`),
  ]);
  const data      = await boardRes.json();
  const votesData = await votesRes.json();

  _votedNotes = new Set(votesData.voted_notes || []);

  document.getElementById("boardTitle").textContent = data.title;
  document.title = `${data.title} · RetroBoard`;

  // Sync facilitator state from full board data on initial load
  if (data.phase !== undefined) {
    _boardState = {
      phase: data.phase,
      notes_revealed: data.notes_revealed,
      columns_locked: data.columns_locked,
      voting_ends_at: data.voting_ends_at,
    };
    applyBoardState(_boardState);
  }

  COLUMNS.forEach(col => renderColumn(col, data.columns[col] || []));
}

function renderColumn(column, notes) {
  const list  = document.getElementById(`notes-${column}`);
  const count = document.getElementById(`count-${column}`);
  count.textContent = notes.length;

  list.innerHTML = "";
  if (notes.length === 0) {
    list.innerHTML = `<p class="empty-state">No notes yet — add one below</p>`;
    return;
  }

  notes
    .slice()
    .sort((a, b) => b.votes - a.votes)
    .forEach(note => list.appendChild(buildNoteCard(note, column)));
}

function buildNoteCard(note, column) {
  const card = document.createElement("div");
  card.dataset.id = note.id;

  if (note.hidden) {
    card.className = "note-card hidden-note";
    card.innerHTML = `
      <p class="note-text note-hidden-placeholder">🔒 Hidden note</p>
      <div class="note-actions">
        <button class="btn-vote" disabled title="Reveal notes to vote">▲ <span class="vote-count">${note.votes}</span></button>
      </div>
    `;
    return card;
  }

  card.className = "note-card";
  const voted = _votedNotes.has(note.id);

  card.innerHTML = `
    <p class="note-text">${escapeHtml(note.text)}</p>
    <div class="note-actions">
      <button class="btn-vote ${voted ? "voted" : ""}"
        data-id="${note.id}" data-column="${column}"
        title="${voted ? "Remove your vote" : "Upvote"}">
        ▲ <span class="vote-count">${note.votes}</span>
      </button>
      <button class="btn-delete" data-id="${note.id}" data-column="${column}" title="Delete note">✕</button>
    </div>
  `;

  card.querySelector(".btn-vote").addEventListener("click", e => voteNote(e.currentTarget));
  card.querySelector(".btn-delete").addEventListener("click", e => deleteNote(e.currentTarget));
  return card;
}

// ── Add Note ─────────────────────────────────────────────────────────────────

async function addNote(column) {
  if (_boardState.columns_locked && !IS_FACILITATOR) {
    showToast("Columns are locked by the facilitator");
    return;
  }

  const input = document.getElementById(`input-${column}`);
  const btn   = document.querySelector(`.btn-add[data-column="${column}"]`);
  const text  = input.value.trim();

  if (!text) { input.focus(); return; }

  btn.disabled = true;
  _suppressNextBoardUpdate = true;
  try {
    const res = await fetch(`/api/boards/${BOARD_ID}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column, text }),
    });
    if (!res.ok) {
      _suppressNextBoardUpdate = false;
      const err = await res.json();
      showToast(err.error || "Failed to add note");
      return;
    }
    const note = await res.json();
    input.value = "";

    const list  = document.getElementById(`notes-${column}`);
    const count = document.getElementById(`count-${column}`);
    const empty = list.querySelector(".empty-state");
    if (empty) empty.remove();
    const card = buildNoteCard(note, column);
    card.classList.add("is-new");
    list.appendChild(card);
    count.textContent = list.querySelectorAll(".note-card").length;
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// ── Vote ─────────────────────────────────────────────────────────────────────

async function voteNote(btn) {
  const noteId = btn.dataset.id;
  _suppressNextBoardUpdate = true;
  const res = await fetch(`/api/boards/${BOARD_ID}/notes/${noteId}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_token: USER_TOKEN }),
  });
  if (!res.ok) {
    _suppressNextBoardUpdate = false;
    const err = await res.json();
    showToast(err.error || "Vote failed");
    return;
  }
  const data = await res.json();

  if (data.action === "added") {
    _votedNotes.add(noteId);
    btn.classList.add("voted");
    btn.title = "Remove your vote";
  } else {
    _votedNotes.delete(noteId);
    btn.classList.remove("voted");
    btn.title = "Upvote";
  }
  btn.classList.remove("pop");
  void btn.offsetWidth;
  btn.classList.add("pop");
  btn.querySelector(".vote-count").textContent = data.votes;
  showToast(data.action === "added" ? "Vote added ▲" : "Vote removed");
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteNote(btn) {
  if (!confirm("Delete this note?")) return;
  const noteId = btn.dataset.id;
  _suppressNextBoardUpdate = true;
  const res = await fetch(`/api/boards/${BOARD_ID}/notes/${noteId}`, { method: "DELETE" });
  if (!res.ok) {
    _suppressNextBoardUpdate = false;
    return;
  }
  const card   = btn.closest(".note-card");
  const list   = card.closest(".notes-list");
  const column = list.id.replace("notes-", "");
  const count  = document.getElementById(`count-${column}`);
  card.remove();
  const remaining = list.querySelectorAll(".note-card").length;
  count.textContent = remaining;
  if (remaining === 0) {
    list.innerHTML = `<p class="empty-state">No notes yet — add one below</p>`;
  }
  showToast("Note deleted");
}

// ── Copy Link ─────────────────────────────────────────────────────────────────

async function copyLink() {
  const url = `${location.origin}/board/${BOARD_ID}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Board link copied to clipboard ✓");
  } catch {
    showToast("Copy: " + url);
  }
}

async function copyFacLink() {
  const url = `${location.origin}/board/${BOARD_ID}?facilitator=${FACILITATOR_TOKEN}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Facilitator link copied ✓");
  } catch {
    showToast("Copy: " + url);
  }
}

// ── Board State ───────────────────────────────────────────────────────────────

function applyBoardState(state) {
  const banner = document.getElementById("statusBanner");
  const phaseBadge = document.getElementById("phaseBadge");
  const timerEl = document.getElementById("timerCountdown");

  // Always show the status banner
  banner.style.display = "flex";

  // Phase badge
  const phaseLabels = { collecting: "Collecting", voting: "Voting", discussing: "Discussing" };
  phaseBadge.textContent = phaseLabels[state.phase] || state.phase;
  phaseBadge.className = `phase-chip phase-${state.phase}`;

  // Update phase buttons active state (facilitator only)
  document.querySelectorAll(".btn-phase").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.phase === state.phase);
  });

  // Update reveal button
  const btnReveal = document.getElementById("btnReveal");
  if (btnReveal) {
    btnReveal.textContent = state.notes_revealed ? "🙈 Hide Notes" : "👁 Reveal Notes";
    btnReveal.classList.toggle("active", state.notes_revealed);
  }

  // Update lock button
  const btnLock = document.getElementById("btnLock");
  if (btnLock) {
    btnLock.textContent = state.columns_locked ? "🔓 Unlock Columns" : "🔒 Lock Columns";
    btnLock.classList.toggle("active-lock", state.columns_locked);
  }

  // Show/hide add-note areas based on lock state
  document.querySelectorAll(".add-note-area").forEach(area => {
    area.style.display = (state.columns_locked && !IS_FACILITATOR) ? "none" : "";
  });

  // Timer countdown
  clearInterval(_timerInterval);
  timerEl.textContent = "";
  if (state.voting_ends_at) {
    startTimerCountdown(state.voting_ends_at);
  }
}

function startTimerCountdown(endsAtIso) {
  const endsAt = new Date(endsAtIso).getTime();
  const timerEl = document.getElementById("timerCountdown");

  function tick() {
    const remaining = endsAt - Date.now();
    if (remaining <= 0) {
      clearInterval(_timerInterval);
      timerEl.textContent = "⏰ Time's up!";
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `⏱ ${mins}:${String(secs).padStart(2, "0")}`;
  }

  tick();
  _timerInterval = setInterval(tick, 1000);
}

// ── Facilitator actions ───────────────────────────────────────────────────────

async function facReveal() {
  const res = await fetch(`/api/boards/${BOARD_ID}/facilitator/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ facilitator_token: FACILITATOR_TOKEN }),
  });
  if (!res.ok) { showToast("Action failed"); return; }
  const state = await res.json();
  _boardState = state;
  applyBoardState(state);
  showToast(state.notes_revealed ? "Notes revealed to all" : "Notes hidden");
}

async function facLock() {
  const res = await fetch(`/api/boards/${BOARD_ID}/facilitator/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ facilitator_token: FACILITATOR_TOKEN }),
  });
  if (!res.ok) { showToast("Action failed"); return; }
  const state = await res.json();
  _boardState = state;
  applyBoardState(state);
  showToast(state.columns_locked ? "Columns locked" : "Columns unlocked");
}

async function facPhase(phase) {
  const res = await fetch(`/api/boards/${BOARD_ID}/facilitator/phase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ facilitator_token: FACILITATOR_TOKEN, phase }),
  });
  if (!res.ok) { showToast("Action failed"); return; }
  const state = await res.json();
  _boardState = state;
  applyBoardState(state);
}

async function facTimer(minutes) {
  const res = await fetch(`/api/boards/${BOARD_ID}/facilitator/timer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ facilitator_token: FACILITATOR_TOKEN, minutes }),
  });
  if (!res.ok) { showToast("Action failed"); return; }
  const state = await res.json();
  _boardState = state;
  applyBoardState(state);
  showToast(minutes > 0 ? `Timer set for ${minutes}m` : "Timer stopped");
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Start ─────────────────────────────────────────────────────────────────────

init();
