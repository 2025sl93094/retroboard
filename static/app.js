const COLUMNS = ["went_well", "didnt_go_well", "action_items"];

// ── Anonymous avatars ─────────────────────────────────────────────────────────

const ANIMALS = [
  { emoji: '🦊', color: '#f97316' },
  { emoji: '🐬', color: '#3b82f6' },
  { emoji: '🐸', color: '#22c55e' },
  { emoji: '🦁', color: '#eab308' },
  { emoji: '🐼', color: '#6b7280' },
  { emoji: '🦋', color: '#a855f7' },
  { emoji: '🐧', color: '#0ea5e9' },
  { emoji: '🦄', color: '#ec4899' },
  { emoji: '🐻', color: '#78350f' },
  { emoji: '🦅', color: '#0d9488' },
];

function getAvatar() {
  let idx = localStorage.getItem("retro_avatar_idx");
  if (idx === null) {
    idx = Math.floor(Math.random() * ANIMALS.length);
    localStorage.setItem("retro_avatar_idx", String(idx));
  }
  return ANIMALS[+idx];
}

const MY_AVATAR = getAvatar();

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

// ── Socket.IO ─────────────────────────────────────────────────────────────────

const socket = io();

socket.on("connect", () => {
  socket.emit("join_board", { board_id: BOARD_ID, avatar: MY_AVATAR.emoji, color: MY_AVATAR.color });
});

socket.on("presence", ({ count, users }) => {
  const el = document.getElementById("presence");
  if (!el) return;
  const chips = (users || []).map(u =>
    `<span class="avatar-chip" style="--chip-color:${u.color}">${u.avatar}</span>`
  ).join('');
  el.innerHTML = chips + `<span class="presence-count">${count} active</span>`;
});

let _suppressNextBoardUpdate = false;

socket.on("board_updated", () => {
  if (_suppressNextBoardUpdate) {
    _suppressNextBoardUpdate = false;
    return;
  }
  loadBoard();
});

socket.on("typing_update", ({ typing }) => {
  COLUMNS.forEach(col => {
    const el = document.getElementById(`typing-${col}`);
    if (!el) return;
    const here = typing.filter(t => t.column === col && t.avatar !== MY_AVATAR.emoji);
    if (here.length === 0) { el.innerHTML = ""; return; }
    const chips = here.map(t =>
      `<span class="avatar-chip" style="--chip-color:${t.color}">${t.avatar}</span>`
    ).join('');
    el.innerHTML = chips + '<span class="typing-label">typing…</span>';
  });
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
    input.addEventListener("input", () => emitTyping(input.id.replace("input-", "")));
  });
}

// ── Typing indicator ──────────────────────────────────────────────────────────

let _typingTimer = null;

function emitTyping(column) {
  socket.emit("typing_start", { board_id: BOARD_ID, column });
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => {
    socket.emit("typing_stop", { board_id: BOARD_ID });
  }, 2000);
}

// ── Load Board ───────────────────────────────────────────────────────────────

let _votedNotes = new Set();

async function loadBoard() {
  const [boardRes, votesRes] = await Promise.all([
    fetch(`/api/boards/${BOARD_ID}`),
    fetch(`/api/boards/${BOARD_ID}/my_votes?user_token=${USER_TOKEN}`),
  ]);
  const data      = await boardRes.json();
  const votesData = await votesRes.json();

  _votedNotes = new Set(votesData.voted_notes || []);

  document.getElementById("boardTitle").textContent = data.title;
  document.title = `${data.title} · RetroBoard`;

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
  card.className = "note-card";
  card.dataset.id = note.id;

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
  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Board link copied to clipboard ✓");
  } catch {
    showToast("Copy: " + window.location.href);
  }
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
