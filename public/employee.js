// ================================================================
// Employee detail page
//   Reads ?code=BF11921 from the URL, fetches /api/operator/:code,
//   and renders every login/logout the operator has ever had, plus
//   every tag scanned in each session.
// ================================================================

const clockEl = document.getElementById("clock");
const employeeTitle = document.getElementById("employeeTitle");
const employeeBody = document.getElementById("employeeBody");

function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString();
}
setInterval(tickClock, 1000);
tickClock();

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(totalSeconds) {
  if (totalSeconds == null) return "—";
  const whole = Math.floor(totalSeconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return (h > 0 ? h + "h " : "") + m + "m " + s + "s";
}

const params = new URLSearchParams(window.location.search);
const code = (params.get("code") || "").trim();

let lastRenderedJson = null;

async function load() {
  if (!code) {
    employeeTitle.textContent = "No employee selected";
    employeeBody.innerHTML = `<p class="empty-msg">Go back and click an employee ID, or search for one.</p>`;
    return;
  }

  employeeTitle.textContent = code;

  try {
    const res = await fetch(`/api/operator/${encodeURIComponent(code)}`);
    if (!res.ok) {
      employeeBody.innerHTML = `<p class="empty-msg">No sessions found for ${escapeHtml(code)}.</p>`;
      return;
    }
    const data = await res.json();
    const json = JSON.stringify(data);
    if (json === lastRenderedJson) return; // nothing changed, skip re-render
    lastRenderedJson = json;
    render(data);
  } catch (err) {
    employeeBody.innerHTML = `<p class="empty-msg">Could not load employee data — is the server running?</p>`;
  }
}

load();
setInterval(load, 3000);

function render(data) {
  const badge = data.isCurrentlyActive
    ? `<span class="badge badge-active">Currently logged in</span>`
    : `<span class="badge badge-idle">Not currently logged in</span>`;

  const totalTagsScanned = data.totals.totalPieces; // one accepted scan == one piece

  const summaryHtml = `
    <div class="result-heading">
      <h3>${escapeHtml(data.operatorCode)}</h3>
      ${badge}
    </div>
    <div class="active-grid" style="margin-bottom:22px;">
      <div class="stat-block">
        <div class="stat-label">Total Logins / Logouts</div>
        <div class="stat-value">${data.sessionCount}</div>
      </div>
      <div class="stat-block">
        <div class="stat-label">Total Tags Scanned</div>
        <div class="stat-value teal">${totalTagsScanned}</div>
      </div>
      <div class="stat-block">
        <div class="stat-label">Total Time On Station</div>
        <div class="stat-value amber">${escapeHtml(data.totals.totalDurationFormatted)}</div>
      </div>
    </div>
  `;

  const sessionsHtml = data.sessions
    .map((s, idx) => {
      const sessionNumber = data.sessions.length - idx; // oldest = #1
      return `
      <div class="session-card">
        <div class="session-card-head">
          <span>Session #${sessionNumber} — Login ${escapeHtml(s.loginTime)} → ${s.logoutTime ? escapeHtml(s.logoutTime) : "still active"}</span>
          <span>${s.status === "active" ? "IN PROGRESS" : escapeHtml(s.durationFormatted || "")}</span>
        </div>
        <div class="active-grid" style="margin-bottom:12px;">
          <div class="stat-block">
            <div class="stat-label">Tags Scanned This Login</div>
            <div class="stat-value teal">${s.pieceCount}</div>
          </div>
        </div>
        ${
          s.tags.length
            ? `<table class="scan-table">
                <thead><tr><th>#</th><th>Label</th><th>Internal ID</th><th>Time</th></tr></thead>
                <tbody>
                  ${s.tags
                    .map(
                      (t, i) => `<tr>
                        <td>${i + 1}</td>
                        <td>${escapeHtml(t.labelNumber || "—")}</td>
                        <td>${escapeHtml(t.internalId || "—")}</td>
                        <td>${escapeHtml(t.timestamp)}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<p class="no-results">No tags scanned during this login.</p>`
        }
      </div>`;
    })
    .join("");

  employeeBody.innerHTML = summaryHtml + sessionsHtml;
}

// ================================================================
// TAG SEARCH (same behavior as the home page search)
//   - Fabric tag number -> renders full scan history right here
//   - Operator code -> navigates to that operator's own detail page
// ================================================================

const tagSearchForm = document.getElementById("tagSearchForm");
const tagSearchInput = document.getElementById("tagSearchInput");
const tagSearchResults = document.getElementById("tagSearchResults");

tagSearchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  runTagSearch(tagSearchInput.value);
});

async function runTagSearch(query) {
  const q = query.trim();
  if (!q) {
    tagSearchResults.classList.add("hidden");
    tagSearchResults.innerHTML = "";
    return;
  }
  tagSearchResults.classList.remove("hidden");
  tagSearchResults.innerHTML = `<p class="no-results">Searching…</p>`;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderTagSearchResults(data);
  } catch (err) {
    tagSearchResults.innerHTML = `<p class="no-results">Search failed — is the server running?</p>`;
  }
}

function renderTagSearchResults(data) {
  if (!data || data.type === "empty") {
    tagSearchResults.innerHTML = `<p class="no-results">Type an operator code or fabric tag number.</p>`;
    return;
  }

  if (data.type === "operator") {
    window.location.href = `employee.html?code=${encodeURIComponent(data.operatorCode)}`;
    return;
  }

  if (data.type === "tag") {
    tagSearchResults.innerHTML = renderTagResult(data);
    return;
  }

  if (data.type === "fuzzy") {
    if (data.results.length === 0) {
      tagSearchResults.innerHTML = `<p class="no-results">No matches for that operator code or tag number.</p>`;
      return;
    }
    tagSearchResults.innerHTML = `
      <div class="result-heading"><h3>Did you mean…</h3></div>
      <div class="fuzzy-list">
        ${data.results
          .map((r) => `<span class="fuzzy-chip" data-value="${escapeHtml(r.value)}" data-kind="${r.kind}">${r.kind === "operator" ? "👤" : "🏷️"} ${escapeHtml(r.value)}</span>`)
          .join("")}
      </div>
    `;
    tagSearchResults.querySelectorAll(".fuzzy-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        if (chip.dataset.kind === "operator") {
          window.location.href = `employee.html?code=${encodeURIComponent(chip.dataset.value)}`;
          return;
        }
        tagSearchInput.value = chip.dataset.value;
        runTagSearch(chip.dataset.value);
      });
    });
    return;
  }

  tagSearchResults.innerHTML = `<p class="no-results">No results.</p>`;
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