// ================================================================
// Dashboard client
//   - Opens an SSE connection to /api/events for live updates
//   - Renders the active session, stats strip, and activity feed
//   - Handles the search bar (operator code OR fabric tag label)
// ================================================================

const statusLight = document.getElementById("statusLight");
const connState = document.getElementById("connState");
const clockEl = document.getElementById("clock");
const rosterBody = document.getElementById("rosterBody");
const statsStrip = document.getElementById("statsStrip");
const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

let latestSnapshot = null;

// ---------------- clock ----------------
function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString();
}
setInterval(tickClock, 1000);
tickClock();

// ---------------- SSE ----------------
function connect() {
  const es = new EventSource("/api/events");

  es.onopen = () => {
    connState.textContent = "live";
    connState.className = "conn-pill conn-live";
  };

  es.onmessage = (e) => {
    try {
      latestSnapshot = JSON.parse(e.data);
      render(latestSnapshot);
    } catch (err) {
      console.error("Bad snapshot payload", err);
    }
  };

  es.onerror = () => {
    connState.textContent = "reconnecting…";
    connState.className = "conn-pill conn-lost";
    statusLight.classList.remove("live");
  };
}
connect();

// ---------------- render dispatch ----------------
function render(snapshot) {
  statusLight.classList.toggle("live", !!snapshot.activeSession);
  renderRoster(snapshot.roster);
  renderStats(snapshot.stats);
}

// ---------------- render: roster (one row per operator) ----------------
function renderRoster(roster) {
  if (!roster || roster.length === 0) {
    rosterBody.innerHTML = `<p class="empty-msg">No operators recorded yet.</p>`;
    return;
  }

  const rows = roster
    .map((op) => {
      const statusHtml = op.isActive
        ? `<span class="status-pill status-active">● Logged in</span>`
        : `<span class="status-pill status-closed">Logged out · ${escapeHtml((op.lastLogoutTime || "").split(" ")[1] || "—")}</span>`;

      return `
        <div class="roster-row ${op.isActive ? "roster-row-active" : "roster-row-closed"}" data-code="${escapeHtml(op.operatorCode)}">
          <span class="roster-emp" data-code="${escapeHtml(op.operatorCode)}">${escapeHtml(op.operatorCode)}</span>
          <span class="roster-cell">${op.sessionCount}</span>
          <span class="roster-cell roster-pieces">${op.totalPieces}</span>
          <span class="roster-cell">${statusHtml}</span>
        </div>`;
    })
    .join("");

  rosterBody.innerHTML = `
    <div class="roster-head-row">
      <span>Employee ID</span>
      <span>Logins Today</span>
      <span>Total Pieces</span>
      <span>Status</span>
    </div>
    ${rows}
  `;

  rosterBody.querySelectorAll(".roster-emp, .roster-row").forEach((el) => {
    el.addEventListener("click", () => {
      const code = el.dataset.code;
      if (!code) return;
      window.location.href = `employee.html?code=${encodeURIComponent(code)}`;
    });
  });
}

function formatDuration(totalSeconds) {
  const whole = Math.floor(totalSeconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return (h > 0 ? h + "h " : "") + m + "m " + s + "s";
}

// ---------------- render: stats strip ----------------
function renderStats(stats) {
  statsStrip.innerHTML = `
    <div class="strip-item">
      <div class="stat-label">Operators Logged Today</div>
      <div class="stat-value">${stats.totalOperators}</div>
    </div>
    <div class="strip-item">
      <div class="stat-label">Sessions Recorded</div>
      <div class="stat-value">${stats.totalSessions}</div>
    </div>
    <div class="strip-item">
      <div class="stat-label">Total Pieces</div>
      <div class="stat-value teal">${stats.totalPieces}</div>
    </div>
  `;
}

// ---------------- search ----------------
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch(searchInput.value);
});

async function runSearch(query) {
  const q = query.trim();
  if (!q) {
    searchResults.classList.add("hidden");
    searchResults.innerHTML = "";
    return;
  }
  searchResults.classList.remove("hidden");
  searchResults.innerHTML = `<p class="no-results">Searching…</p>`;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSearchResults(data);
  } catch (err) {
    searchResults.innerHTML = `<p class="no-results">Search failed — is the server running?</p>`;
  }
}

function renderSearchResults(data) {
  if (!data || data.type === "empty") {
    searchResults.innerHTML = `<p class="no-results">Type an operator code or fabric tag number.</p>`;
    return;
  }

  if (data.type === "operator") {
    // Operator matches always go to their own detail page, not inline.
    window.location.href = `employee.html?code=${encodeURIComponent(data.operatorCode)}`;
    return;
  }

  if (data.type === "tag") {
    searchResults.innerHTML = renderTagResult(data);
    return;
  }

  if (data.type === "fuzzy") {
    if (data.results.length === 0) {
      searchResults.innerHTML = `<p class="no-results">No matches for that operator code or tag number.</p>`;
      return;
    }
    searchResults.innerHTML = `
      <div class="result-heading"><h3>Did you mean…</h3></div>
      <div class="fuzzy-list">
        ${data.results
          .map((r) => `<span class="fuzzy-chip" data-value="${escapeHtml(r.value)}" data-kind="${r.kind}">${r.kind === "operator" ? "👤" : "🏷️"} ${escapeHtml(r.value)}</span>`)
          .join("")}
      </div>
    `;
    searchResults.querySelectorAll(".fuzzy-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        if (chip.dataset.kind === "operator") {
          window.location.href = `employee.html?code=${encodeURIComponent(chip.dataset.value)}`;
          return;
        }
        searchInput.value = chip.dataset.value;
        runSearch(chip.dataset.value);
      });
    });
    return;
  }

  searchResults.innerHTML = `<p class="no-results">No results.</p>`;
}

function renderTagResult(data) {
  return `
    <div class="result-heading">
      <h3>Tag ${escapeHtml(data.labelNumber)}</h3>
      <span class="badge badge-idle">Internal ID: ${escapeHtml(data.internalId)}</span>
    </div>
    <div class="active-grid" style="margin-bottom:16px;">
      <div class="stat-block">
        <div class="stat-label">Accepted Scans</div>
        <div class="stat-value teal">${data.totalAcceptedScans}</div>
      </div>
      <div class="stat-block">
        <div class="stat-label">Duplicates Ignored</div>
        <div class="stat-value" style="color:var(--rust)">${data.totalDuplicatesIgnored}</div>
      </div>
      <div class="stat-block">
        <div class="stat-label">Unattributed Scans</div>
        <div class="stat-value" style="color:var(--amber)">${data.totalUnattributed}</div>
      </div>
    </div>
    <table class="scan-table">
      <thead><tr><th>Time</th><th>Event</th><th>Operator</th></tr></thead>
      <tbody>
        ${data.scans
          .map(
            (s) => `<tr>
              <td>${escapeHtml(s.timestamp)}</td>
              <td>${escapeHtml((s.eventType || "").replace(/_/g, " "))}</td>
              <td>${escapeHtml(s.operatorCode || "—")}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

// ---------------- utils ----------------
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}