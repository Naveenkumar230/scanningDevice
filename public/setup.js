// ================================================================
// Setup panel controller
//   - Corner "Setup" button opens/closes a slide-in panel over the
//     dashboard (no page navigation, so live SSE stays connected)
//   - Polls /api/pairing/status while the panel is open, and shows
//     an amber dot on the corner button whenever the station is NOT
//     yet paired, so it's noticeable even with the panel closed.
//   - Pairing/admin API calls are unchanged from the old setup.html.
// ================================================================

const setupBtn = document.getElementById("setupBtn");
const setupDot = document.getElementById("setupDot");
const setupOverlay = document.getElementById("setupOverlay");
const setupScrim = document.getElementById("setupScrim");
const setupCloseBtn = document.getElementById("setupCloseBtn");

const statusEyebrow = document.getElementById("statusEyebrow");
const pairedView = document.getElementById("pairedView");
const unpairedView = document.getElementById("unpairedView");
const machineIdDisplay = document.getElementById("machineIdDisplay");

let setupPollTimer = null;

function openSetup() {
  setupOverlay.classList.remove("hidden");
  requestAnimationFrame(() => setupOverlay.classList.add("open"));
  refreshStatus();
  if (!setupPollTimer) setupPollTimer = setInterval(refreshStatus, 2000);
}

function closeSetup() {
  setupOverlay.classList.remove("open");
  setTimeout(() => setupOverlay.classList.add("hidden"), 200);
}

setupBtn.addEventListener("click", openSetup);
setupCloseBtn.addEventListener("click", closeSetup);
setupScrim.addEventListener("click", closeSetup);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && setupOverlay.classList.contains("open")) closeSetup();
});

// ---------------- pairing status (also drives the corner dot) ----------------
async function refreshStatus() {
  try {
    const res = await fetch("/api/pairing/status");
    const data = await res.json();

    if (!data.knownYet) {
      statusEyebrow.textContent = "waiting for the station to start up…";
      unpairedView.classList.remove("hidden");
      pairedView.classList.add("hidden");
      setupDot.classList.add("visible");
      return;
    }

    if (data.paired) {
      statusEyebrow.textContent = "paired";
      machineIdDisplay.textContent = data.machineId;
      pairedView.classList.remove("hidden");
      unpairedView.classList.add("hidden");
      setupDot.classList.remove("visible");
    } else {
      statusEyebrow.textContent = "not paired yet";
      unpairedView.classList.remove("hidden");
      pairedView.classList.add("hidden");
      setupDot.classList.add("visible");
    }
  } catch (e) {
    statusEyebrow.textContent = "could not reach dashboard server";
  }
}

// Check once on page load too, so the corner dot is correct even
// before anyone opens the panel.
refreshStatus();
setInterval(refreshStatus, 5000);

// ---------------- pairing form ----------------
document.getElementById("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const machineId = document.getElementById("pairMachineId").value.trim();
  const password = document.getElementById("pairPassword").value;
  const msg = document.getElementById("pairMsg");
  if (!machineId) { msg.textContent = "Enter a machine ID first."; return; }
  msg.textContent = "Submitting… the station checks for this about once a second.";
  await fetch("/api/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineId, password }),
  });
  setTimeout(refreshStatus, 1500);
});

// ---------------- admin form ----------------
document.getElementById("adminForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const action = document.getElementById("adminAction").value;
  const newValue = document.getElementById("adminNewValue").value.trim();
  const password = document.getElementById("adminPassword").value;
  const msg = document.getElementById("adminMsg");

  if (!password) { msg.textContent = "Enter the current admin password."; return; }
  if (action !== "delete_pairing" && !newValue) { msg.textContent = "Enter the new value."; return; }

  msg.textContent = "Submitting…";
  await fetch("/api/admin/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, password, newValue }),
  });

  setTimeout(async () => {
    const res = await fetch("/api/admin/result");
    const data = await res.json();
    msg.textContent = data.pending
      ? "Still waiting for the station to respond…"
      : `${data.result === "success" ? "✅" : "❌"} ${data.message}`;
    refreshStatus();
  }, 1500);
});