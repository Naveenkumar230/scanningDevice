#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <string>
#include <regex>
#include <unordered_map>
#include <unordered_set>
#include <chrono>
#include <thread>
#include <mutex>
#include <atomic>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <functional>
#include <iomanip>
#include <opencv2/opencv.hpp>
#include <zbar.h>
#include <curl/curl.h>

#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <pthread.h>

using namespace std;
using namespace cv;
using namespace zbar;

// Prints the raw QR payload once per accepted "tap" (i.e. right before it's
// handed off to LOGIN/LOGOUT/TAG SCANNED/DUPLICATE IGNORED handling) --
// NOT on every single frame the code is visible in. Leave this ON while
// troubleshooting -- it tells you immediately what was decoded and what
// happened with it, without flooding the terminal.
const bool SCAN_DEBUG_MODE = true;

// Prints the periodic "[PERF] Scan loop running at ~N scans/sec" line.
// Turn this ON only when you actually need to check camera/loop speed --
// it's just noise for normal day-to-day operation.
const bool SHOW_PERF_STATS = false;

// ================================================================
// SECTION A: CAMERA + STREAMING -- UNTOUCHED, guarantees max camera speed
// ================================================================

mutex frameMutex;
Mat latestFrame;
atomic<bool> hasFrame(false);
atomic<bool> running(true);

mutex jpegMutex;
vector<uchar> latestJpeg;

// Scan zone, in full-frame (1456x1088) coordinates. Covers most of the
// frame while leaving a small margin on each edge. Adjust these four
// numbers directly if you need it bigger/smaller or shifted --
// (x, y, width, height).
const Rect SCAN_ROI(100, 60, 1250, 950);

void captureThread(VideoCapture &cap) {
    Mat frame;
    while (running) {
        if (!cap.read(frame)) {
            continue;
        }
        lock_guard<mutex> lock(frameMutex);
        latestFrame = frame;
        hasFrame = true;
    }
}

void previewEncodeThread() {
    vector<int> jpegParams = { IMWRITE_JPEG_QUALITY, 40 };
    while (running) {
        Mat frameCopy;
        {
            lock_guard<mutex> lock(frameMutex);
            if (!hasFrame) { continue; }
            frameCopy = latestFrame;
        }
        // Draw the active scan zone on the frame BEFORE shrinking it, so it
        // lines up with real coordinates. This shows up in the browser
        // stream (http://<pi-ip>:8080) as a yellow box -- hold the QR code
        // inside that box.
        rectangle(frameCopy, SCAN_ROI, Scalar(0, 255, 255), 4);

        Mat small;
        resize(frameCopy, small, Size(320, 240));
        vector<uchar> buf;
        imencode(".jpg", small, buf, jpegParams);
        {
            lock_guard<mutex> lock(jpegMutex);
            latestJpeg = buf;
        }
        this_thread::sleep_for(chrono::milliseconds(50));
    }
}

void mjpegServerThread(int port) {
    int serverFd = socket(AF_INET, SOCK_STREAM, 0);
    if (serverFd < 0) { cerr << "[STREAM ERROR] Could not create socket." << endl; return; }
    int opt = 1;
    setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = INADDR_ANY;
    address.sin_port = htons(port);
    if (bind(serverFd, (struct sockaddr*)&address, sizeof(address)) < 0) {
        cerr << "[STREAM ERROR] Bind failed on port " << port << endl;
        close(serverFd);
        return;
    }
    listen(serverFd, 5);
    cout << "[STREAM] MJPEG server listening on port " << port << " (view at http://<pi-ip>:" << port << "/stream)" << endl;
    while (running) {
        sockaddr_in clientAddr{};
        socklen_t clientLen = sizeof(clientAddr);
        int clientFd = accept(serverFd, (struct sockaddr*)&clientAddr, &clientLen);
        if (clientFd < 0) continue;
        int nodelay = 1;
        setsockopt(clientFd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
        string header =
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
            "Cache-Control: no-cache\r\n"
            "Connection: close\r\n\r\n";
        send(clientFd, header.c_str(), header.size(), 0);
        while (running) {
            vector<uchar> jpegCopy;
            {
                lock_guard<mutex> lock(jpegMutex);
                if (latestJpeg.empty()) continue;
                jpegCopy = latestJpeg;
            }
            string partHeader =
                "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                to_string(jpegCopy.size()) + "\r\n\r\n";
            if (send(clientFd, partHeader.c_str(), partHeader.size(), MSG_NOSIGNAL) < 0) break;
            if (send(clientFd, (const char*)jpegCopy.data(), jpegCopy.size(), MSG_NOSIGNAL) < 0) break;
            if (send(clientFd, "\r\n", 2, MSG_NOSIGNAL) < 0) break;
            this_thread::sleep_for(chrono::milliseconds(50));
        }
        close(clientFd);
    }
    close(serverFd);
}

// ================================================================
// SECTION A.4: REMOTE DASHBOARD PUSH  (NEW)
//
// The dashboard (server.js) may be hosted on the public internet, where
// it cannot read this device's local SD card. So every event that gets
// written to the local CSV log (see writeLogRow, below) is ALSO POSTed
// as JSON to the dashboard's /api/ingest endpoint over HTTPS. The local
// CSV write always happens first and is never skipped -- it's the
// offline-safe source of truth if the network is down. The HTTP push is
// best-effort: if it fails (no internet, server down, etc.) we just log
// a warning and move on. Nothing blocks on it for more than a couple
// of seconds (CURL timeouts are set below).
//
// Configure via environment variables (set these before launching the
// binary, e.g. in a systemd unit or a small wrapper script):
//   DASHBOARD_URL   -- e.g. "https://your-app.onrender.com/api/ingest"
//   DASHBOARD_API_KEY -- shared secret, must match INGEST_API_KEY on the
//                        server, so randoms on the internet can't inject
//                        fake scan data into your dashboard.
// If DASHBOARD_URL is not set, remote push is silently disabled and the
// station behaves exactly as before (local CSV only).
// ================================================================

string getEnvOrDefault(const char *name, const string &fallback) {
    const char *v = getenv(name);
    return v ? string(v) : fallback;
}

const string DASHBOARD_URL = getEnvOrDefault("DASHBOARD_URL", "");
const string DASHBOARD_API_KEY = getEnvOrDefault("DASHBOARD_API_KEY", "");

// Minimal JSON string escaping -- good enough for our controlled field
// values (QR payloads could theoretically contain quotes/backslashes).
string jsonEscape(const string &raw) {
    string out;
    out.reserve(raw.size() + 8);
    for (char c : raw) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c;
        }
    }
    return out;
}

// libcurl needs a write callback even if we don't care about the
// response body -- this just discards it.
size_t discardResponse(char *ptr, size_t size, size_t nmemb, void *userdata) {
    (void)ptr; (void)userdata;
    return size * nmemb;
}

// Fire-and-forget POST. Called from a detached thread per event so a slow
// or unreachable server never stalls the scan loop.
void postEventAsync(string eventType, string machineId, string operatorCode,
                     string sessionId, string tagFull, string tagInternalId,
                     string tagLabelNumber, string timestamp) {
    if (DASHBOARD_URL.empty()) return; // remote push disabled

    thread([=]() {
        CURL *curl = curl_easy_init();
        if (!curl) return;

        ostringstream json;
        json << "{"
             << "\"eventType\":\"" << jsonEscape(eventType) << "\","
             << "\"machineId\":\"" << jsonEscape(machineId) << "\","
             << "\"operatorCode\":\"" << jsonEscape(operatorCode) << "\","
             << "\"sessionId\":\"" << jsonEscape(sessionId) << "\","
             << "\"tagFull\":\"" << jsonEscape(tagFull) << "\","
             << "\"internalId\":\"" << jsonEscape(tagInternalId) << "\","
             << "\"labelNumber\":\"" << jsonEscape(tagLabelNumber) << "\","
             << "\"timestamp\":\"" << jsonEscape(timestamp) << "\""
             << "}";
        string body = json.str();

        struct curl_slist *headers = NULL;
        headers = curl_slist_append(headers, "Content-Type: application/json");
        if (!DASHBOARD_API_KEY.empty()) {
            string authHeader = "X-API-Key: " + DASHBOARD_API_KEY;
            headers = curl_slist_append(headers, authHeader.c_str());
        }

        curl_easy_setopt(curl, CURLOPT_URL, DASHBOARD_URL.c_str());
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discardResponse);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 3L);

        CURLcode res = curl_easy_perform(curl);
        if (res != CURLE_OK) {
            cerr << "[DASHBOARD PUSH WARNING] Could not reach dashboard: "
                 << curl_easy_strerror(res) << endl;
        }

        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
    }).detach();
}

// ================================================================
// SECTION A.5: MACHINE PAIRING / SETUP
//
// Every station now has to be paired to a unique machine ID before it
// will process ANY operator login or fabric tag scan. This is a one-time
// step per device: scan a "MACHINE_SETUP:<id>" QR code (printed/generated
// separately for each station) OR type the ID in by hand. Once paired,
// the ID is written to machine_config.cfg next to the binary and reused
// forever -- it survives restarts and power cuts, exactly like the
// production log does.
//
// An admin can still change it later, but that requires the password set
// during initial pairing.
// ================================================================

const string MACHINE_CONFIG_PATH = "machine_config.cfg";

// This regex is intentionally very distinct from both the operator QR
// pattern (BF#####) and typical fabric tag payloads, so a setup QR can
// never accidentally be read as an operator card or a tag mid-shift.
const regex MACHINE_SETUP_QR_REGEX(R"(^MACHINE_SETUP:([A-Za-z0-9\-]{3,30})$)");

struct MachineConfig {
    bool paired = false;
    string machineId;
    string passwordHash;
};

MachineConfig machineConfig;

// Forward declaration -- defined in Section B below, alongside
// LOG_FILE_PATH itself. Needed here because the admin web-request poll
// thread (defined in this section) must refresh the log path if the
// machine ID changes.
void finalizeLogFilePath();
extern string LOG_FILE_PATH;

// Machine identity is no longer a compile-time constant -- it's whatever
// was paired at setup time (or re-paired later via the admin menu).
string MACHINE_ID = "";

// Not cryptographic -- this is a simple local admin-lock, not a security
// boundary against a determined attacker. Good enough to stop someone on
// the shop floor from casually re-pairing or wiping the station.
string simpleHash(const string &input) {
    hash<string> hasher;
    size_t h = hasher(input + "::station-pairing-salt::");
    ostringstream oss;
    oss << hex << h;
    return oss.str();
}

bool loadMachineConfig() {
    ifstream f(MACHINE_CONFIG_PATH);
    if (!f.is_open()) return false;
    string line;
    while (getline(f, line)) {
        size_t eq = line.find('=');
        if (eq == string::npos) continue;
        string key = line.substr(0, eq);
        string val = line.substr(eq + 1);
        if (key == "machine_id") machineConfig.machineId = val;
        else if (key == "password_hash") machineConfig.passwordHash = val;
    }
    machineConfig.paired = !machineConfig.machineId.empty();
    if (machineConfig.paired) MACHINE_ID = machineConfig.machineId;
    return machineConfig.paired;
}

void saveMachineConfig() {
    ofstream f(MACHINE_CONFIG_PATH, ios::trunc);
    f << "machine_id=" << machineConfig.machineId << "\n";
    f << "password_hash=" << machineConfig.passwordHash << "\n";
    f.close();
}

// --------------------------------------------------------------
// WEB-DRIVEN PAIRING / ADMIN
//
// No typing happens in this program's own terminal. Instead, the web
// dashboard (server.js) writes small request files into a shared
// "control" folder, and this program polls that folder roughly once a
// second and acts on whatever it finds.
//
// FIXED: LOG_DIR / CONTROL_DIR previously had invalid C++ syntax
// (`const LOG_DIR = ...`) and CONTROL_DIR_OVERRIDE was referenced but
// never declared. Both are proper `string` values now, and the override
// constant is declared right above where it's used.
// --------------------------------------------------------------

const string LOG_DIR = "/home/scanningdevice/sewing_tracker/build/logs";

// Leave empty to use the current working directory (".") for control
// files, or set this to an absolute path if you want it elsewhere.
const string CONTROL_DIR_OVERRIDE = "/home/scanningdevice/sewing_tracker/build/control";
string CONTROL_DIR = CONTROL_DIR_OVERRIDE; // may be reassigned by finalizeControlDir()

const string PAIRING_STATUS_PATH_SUFFIX = "/pairing_status.txt";
const string PAIRING_REQUEST_PATH_SUFFIX = "/pairing_request.txt";
const string ADMIN_REQUEST_PATH_SUFFIX = "/admin_request.txt";
const string ADMIN_RESULT_PATH_SUFFIX = "/admin_result.txt";

void finalizeControlDir() {
    CONTROL_DIR = CONTROL_DIR_OVERRIDE.empty() ? "." : CONTROL_DIR_OVERRIDE;
    // Make sure the folder actually exists so writePairingStatus() below
    // doesn't silently fail on a fresh install.
    string mkdirCmd = "mkdir -p \"" + CONTROL_DIR + "\"";
    system(mkdirCmd.c_str());
    cout << "[INFO] Web pairing/admin control folder: " << CONTROL_DIR << endl;
}

// Parses a simple "key=value" file, one pair per line. Same format as
// machine_config.cfg -- no external JSON library needed.
unordered_map<string, string> readKeyValueFile(const string &path) {
    unordered_map<string, string> out;
    ifstream f(path);
    if (!f.is_open()) return out;
    string line;
    while (getline(f, line)) {
        size_t eq = line.find('=');
        if (eq == string::npos) continue;
        out[line.substr(0, eq)] = line.substr(eq + 1);
    }
    return out;
}

// Called continuously (every ~1s) so the web page always shows current
// pairing state, even before this station is paired.
void writePairingStatus() {
    ofstream f(CONTROL_DIR + PAIRING_STATUS_PATH_SUFFIX, ios::trunc);
    f << "paired=" << (machineConfig.paired ? "true" : "false") << "\n";
    f << "machine_id=" << MACHINE_ID << "\n";
    f.close();
}

// Blocks until the station is paired -- either the camera catches a
// MACHINE_SETUP:<id> QR, or the web page submits a manual ID (which shows
// up here as pairing_request.txt). No keyboard input in this terminal at
// any point.
void runPairingSetup(ImageScanner &scanner) {
    cout << "\n=========================================" << endl;
    cout << "[SETUP] This machine is not paired yet." << endl;
    cout << "[SETUP] Waiting for either:" << endl;
    cout << "         - the MACHINE_SETUP QR code held up to the camera, or" << endl;
    cout << "         - a manual machine ID submitted from the web dashboard" << endl;
    cout << "=========================================" << endl;

    string newId, newPassword;
    string requestPath = CONTROL_DIR + PAIRING_REQUEST_PATH_SUFFIX;

    while (newId.empty()) {
        writePairingStatus();

        // ---- Check 1: has the web page submitted a manual pairing request? ----
        ifstream reqCheck(requestPath);
        if (reqCheck.is_open()) {
            reqCheck.close();
            auto kv = readKeyValueFile(requestPath);
            if (kv.count("machine_id") && !kv["machine_id"].empty()) {
                newId = kv["machine_id"];
                newPassword = kv.count("password") ? kv["password"] : "";
                remove(requestPath.c_str());
                cout << "[SETUP] Machine ID received from web dashboard: " << newId << endl;
                break;
            }
            remove(requestPath.c_str()); // malformed request -- discard it
        }

        // ---- Check 2: has the camera seen a setup QR this frame? ----
        Mat frame, gray;
        {
            lock_guard<mutex> lock(frameMutex);
            if (!hasFrame) { this_thread::sleep_for(chrono::milliseconds(100)); continue; }
            frame = latestFrame.clone();
        }
        cvtColor(frame, gray, COLOR_BGR2GRAY);
        Image zbarImage(gray.cols, gray.rows, "Y800", gray.data, gray.cols * gray.rows);
        if (scanner.scan(zbarImage) > 0) {
            for (Image::SymbolIterator sym = zbarImage.symbol_begin(); sym != zbarImage.symbol_end(); ++sym) {
                string payload = sym->get_data();
                smatch m;
                if (regex_match(payload, m, MACHINE_SETUP_QR_REGEX)) {
                    newId = m[1];
                    break;
                }
            }
        }
        zbarImage.set_data(NULL, 0);
        if (!newId.empty()) {
            cout << "[SETUP] Scanned machine ID from camera: " << newId << endl;
            break;
        }

        this_thread::sleep_for(chrono::milliseconds(200));
    }

    // If pairing came from the camera (no password supplied by a web
    // form), fall back to a default password -- the web page's admin
    // section should prompt the operator to change it immediately.
    if (newPassword.empty()) newPassword = "changeme";

    machineConfig.machineId = newId;
    machineConfig.passwordHash = simpleHash(newPassword);
    machineConfig.paired = true;
    saveMachineConfig();
    MACHINE_ID = newId;
    writePairingStatus();

    cout << "[SETUP] Machine paired as '" << MACHINE_ID << "'." << endl;
    if (newPassword == "changeme") {
        cout << "[SETUP] Using DEFAULT admin password ('changeme') -- change it from the web" << endl;
        cout << "        dashboard's admin panel as soon as possible." << endl;
    }
    cout << "This is permanent across restarts until changed via the web dashboard's admin panel." << endl;
    cout << "=========================================" << endl;
}

// Runs for the whole lifetime of the program, polling for admin actions
// submitted through the password-gated section of the web dashboard.
void adminRequestPollThread() {
    string requestPath = CONTROL_DIR + ADMIN_REQUEST_PATH_SUFFIX;
    string resultPath = CONTROL_DIR + ADMIN_RESULT_PATH_SUFFIX;

    while (running) {
        this_thread::sleep_for(chrono::milliseconds(1000));
        writePairingStatus(); // keep the web page's status display fresh

        ifstream reqCheck(requestPath);
        if (!reqCheck.is_open()) continue;
        reqCheck.close();

        auto kv = readKeyValueFile(requestPath);
        remove(requestPath.c_str()); // consume it either way -- never re-applied twice

        string action = kv.count("action") ? kv["action"] : "";
        string password = kv.count("password") ? kv["password"] : "";
        string newValue = kv.count("new_value") ? kv["new_value"] : "";

        auto writeResult = [&](const string &result, const string &message) {
            ofstream f(resultPath, ios::trunc);
            f << "result=" << result << "\n";
            f << "message=" << message << "\n";
            f.close();
        };

        if (simpleHash(password) != machineConfig.passwordHash) {
            writeResult("error", "Incorrect admin password.");
            cout << "[ADMIN][web] Rejected " << action << " -- incorrect password." << endl;
            continue;
        }

        if (action == "change_id") {
            if (newValue.empty()) {
                writeResult("error", "No new machine ID provided.");
                continue;
            }
            machineConfig.machineId = newValue;
            MACHINE_ID = newValue;
            saveMachineConfig();
            finalizeLogFilePath();
            writeResult("success", "Machine ID updated to '" + MACHINE_ID + "'.");
            cout << "[ADMIN][web] Machine ID changed to '" << MACHINE_ID << "'." << endl;
        } else if (action == "delete_pairing") {
            remove(MACHINE_CONFIG_PATH.c_str());
            writeResult("success", "Pairing deleted. Restart the station to re-pair.");
            cout << "[ADMIN][web] Pairing deleted -- restart required to re-pair." << endl;
        } else if (action == "change_password") {
            if (newValue.empty()) {
                writeResult("error", "No new password provided.");
                continue;
            }
            machineConfig.passwordHash = simpleHash(newValue);
            saveMachineConfig();
            writeResult("success", "Admin password updated.");
            cout << "[ADMIN][web] Password changed." << endl;
        } else {
            writeResult("error", "Unknown action: " + action);
        }
    }
}

// ================================================================
// SECTION B: SESSION STATE
// ================================================================

// Each station gets a uniquely-named local log file
// (production_log_<machineId>.csv), based on the machine ID assigned at
// pairing time. LOG_DIR_OVERRIDE lets you point this at a mounted network
// share instead of the local build folder -- leave empty to just write
// locally.
const string LOG_DIR_OVERRIDE = ""; // e.g. "/mnt/station-logs" -- empty = write locally
string LOG_FILE_PATH = "production_log.csv"; // placeholder until finalizeLogFilePath() runs

void finalizeLogFilePath() {
    string dir = LOG_DIR_OVERRIDE.empty() ? "." : LOG_DIR_OVERRIDE;
    LOG_FILE_PATH = dir + "/production_log_" + MACHINE_ID + ".csv";
    cout << "[INFO] Writing production log to: " << LOG_FILE_PATH << endl;
}

mutex sessionMutex;

// One completed fabric tag scan, split into its parts.
struct ScannedTag {
    string fullRaw;      // exactly what was in the QR, untouched
    string internalId;   // the hidden long number -- not printed on the tag
    string labelNumber;  // the number that IS printed on the tag
};

struct SessionState {
    bool active = false;
    string operatorCode;
    string sessionId;
    chrono::system_clock::time_point loginTime;
    string loginTimeStr;          // human-readable login timestamp
    int pieceCount = 0;
    vector<ScannedTag> scannedTags;   // every fabric tag scanned this session
};
SessionState session;

// --------------------------------------------------------------
// Duplicate-scan protection for FABRIC TAGS ONLY.
//
// Rule: once a fabric tag (matched on its full raw payload) has been
// ACCEPTED as a real scan, that exact tag can never be counted again --
// permanently, not just for a little while.
// --------------------------------------------------------------
unordered_set<string> alreadyScannedTags;

string currentTimestamp() {
    auto now = chrono::system_clock::now();
    time_t t = chrono::system_clock::to_time_t(now);
    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", localtime(&t));
    return string(buf);
}

// Turns a raw seconds count into "Xh Ym Zs" (hours omitted if zero).
string formatDuration(double totalSeconds) {
    int wholeSeconds = static_cast<int>(totalSeconds);
    int hours = wholeSeconds / 3600;
    int minutes = (wholeSeconds % 3600) / 60;
    int seconds = wholeSeconds % 60;

    ostringstream oss;
    if (hours > 0) oss << hours << "h ";
    oss << minutes << "m " << seconds << "s";
    return oss.str();
}

string makeSessionId(const string &operatorCode) {
    return operatorCode + "_" + currentTimestamp();
}

// CSV-safe: strips commas/newlines out of a field so it can't corrupt a row.
string sanitizeForCsv(const string &raw) {
    string out;
    out.reserve(raw.size());
    for (char c : raw) {
        if (c == ',') out += ';';
        else if (c == '\n' || c == '\r') out += ' ';
        else out += c;
    }
    size_t start = out.find_first_not_of(" \t");
    size_t end = out.find_last_not_of(" \t");
    if (start == string::npos) return "";
    return out.substr(start, end - start + 1);
}

// Fabric tags observed so far all follow the same pattern:
//   <hidden internal id>,<printed label number>
ScannedTag parseTagPayload(const string &rawPayload) {
    ScannedTag tag;
    tag.fullRaw = rawPayload;

    size_t commaPos = rawPayload.find(',');
    if (commaPos == string::npos) {
        tag.internalId = rawPayload;
        tag.labelNumber = "";
    } else {
        tag.internalId = rawPayload.substr(0, commaPos);
        tag.labelNumber = rawPayload.substr(commaPos + 1);
    }
    return tag;
}

// event_type: LOGIN / LOGOUT / LOGIN_CONFLICT / SCAN / UNATTRIBUTED_SCAN /
//             DUPLICATE_IGNORED
// For LOGIN/LOGOUT/LOGIN_CONFLICT rows, pass an empty ScannedTag{}.
//
// NOW ALSO pushes the same event to the dashboard server over HTTP (see
// postEventAsync above), right after the local CSV write succeeds. The
// local write is always the source of truth; the HTTP push is best-effort.
void writeLogRow(const string &eventType, const string &operatorCode,
                  const string &sessionId, const ScannedTag &tag) {
    bool fileExists = ifstream(LOG_FILE_PATH).good();
    ofstream logFile(LOG_FILE_PATH, ios::app);
    if (!logFile.is_open()) {
        cerr << "[LOG ERROR] Could not open " << LOG_FILE_PATH << " for writing." << endl;
        return;
    }
    if (!fileExists) {
        logFile << "event_type,machine_id,operator_code,session_id,"
                    "tag_full,tag_internal_id,tag_label_number,timestamp" << "\n";
    }
    string ts = currentTimestamp();
    logFile << eventType << "," << MACHINE_ID << "," << operatorCode << ","
             << sessionId << ","
             << sanitizeForCsv(tag.fullRaw) << ","
             << sanitizeForCsv(tag.internalId) << ","
             << sanitizeForCsv(tag.labelNumber) << ","
             << ts << "\n";
    logFile.close();

    postEventAsync(eventType, MACHINE_ID, operatorCode, sessionId,
                   tag.fullRaw, tag.internalId, tag.labelNumber, ts);
}

// Reconstructs a tag's raw QR payload from its already-split internal ID +
// label number, exactly the way parseTagPayload() originally split it.
string reconstructTagFull(const string &internalId, const string &labelNumber) {
    if (labelNumber.empty()) return internalId;
    return internalId + "," + labelNumber;
}

// Parses "YYYY-MM-DD HH:MM:SS" back into a time_point.
chrono::system_clock::time_point parseTimestampToTimePoint(const string &str) {
    struct tm tmVal{};
    strptime(str.c_str(), "%Y-%m-%d %H:%M:%S", &tmVal);
    tmVal.tm_isdst = -1;
    time_t t = mktime(&tmVal);
    return chrono::system_clock::from_time_t(t);
}

// Splits a CSV line on commas.
vector<string> splitCsvLine(const string &line) {
    vector<string> fields;
    stringstream ss(line);
    string field;
    while (getline(ss, field, ',')) {
        fields.push_back(field);
    }
    return fields;
}

// Runs once at startup, before the camera/threads start. Replays the
// entire production_log.csv to recover an in-progress session and
// re-lock previously scanned tags -- see original comments for details.
void recoverSessionFromLog() {
    ifstream logFile(LOG_FILE_PATH);
    if (!logFile.is_open()) {
        return; // no log yet -- nothing to recover, fresh start
    }

    string candidateSessionId, candidateOperator, candidateLoginTimeStr;
    vector<ScannedTag> candidateTags;
    int candidatePieceCount = 0;
    int totalTagsRelocked = 0;

    string line;
    bool first = true;
    while (getline(logFile, line)) {
        if (first) {
            first = false;
            if (line.rfind("event_type,", 0) == 0) continue; // header row
        }
        if (line.empty()) continue;

        vector<string> f = splitCsvLine(line);
        if (f.size() < 8) continue; // malformed/partial row (e.g. power cut mid-write) -- skip

        const string &eventType = f[0];
        const string &operatorCode = f[2];
        const string &sessionId = f[3];
        const string &tagInternalId = f[5];
        const string &tagLabelNumber = f[6];

        if (eventType == "LOGIN") {
            candidateSessionId = sessionId;
            candidateOperator = operatorCode;
            candidateLoginTimeStr = f[7];
            candidateTags.clear();
            candidatePieceCount = 0;
        } else if (eventType == "LOGOUT" && sessionId == candidateSessionId) {
            candidateSessionId.clear();
            candidateOperator.clear();
        } else if (eventType == "SCAN") {
            string fullRaw = reconstructTagFull(tagInternalId, tagLabelNumber);
            alreadyScannedTags.insert(fullRaw);
            totalTagsRelocked++;

            if (!candidateSessionId.empty() && sessionId == candidateSessionId) {
                ScannedTag tag;
                tag.internalId = tagInternalId;
                tag.labelNumber = tagLabelNumber;
                tag.fullRaw = fullRaw;
                candidateTags.push_back(tag);
                candidatePieceCount++;
            }
        }
    }
    logFile.close();

    if (totalTagsRelocked > 0) {
        cout << "[INFO] Re-locked " << totalTagsRelocked
             << " previously scanned tag(s) from log history -- they cannot be counted again." << endl;
    }

    if (candidateSessionId.empty()) {
        return; // nobody was left logged in -- normal fresh start
    }

    session.active = true;
    session.operatorCode = candidateOperator;
    session.sessionId = candidateSessionId;
    session.loginTimeStr = candidateLoginTimeStr;
    session.loginTime = parseTimestampToTimePoint(candidateLoginTimeStr);
    session.pieceCount = candidatePieceCount;
    session.scannedTags = candidateTags;

    cout << "\n=========================================" << endl;
    cout << "[SESSION RESTORED] Recovered an in-progress session after restart." << endl;
    cout << "Operator         : " << session.operatorCode << endl;
    cout << "Session ID       : " << session.sessionId << endl;
    cout << "Login Time       : " << session.loginTimeStr << endl;
    cout << "Pieces so far    : " << session.pieceCount << endl;
    cout << "This operator does NOT need to log in again -- scan your QR" << endl;
    cout << "only when you are ready to log OUT." << endl;
    cout << "=========================================" << endl;
}

void handleOperatorEvent(const string &empCode) {
    lock_guard<mutex> lock(sessionMutex);

    if (!session.active) {
        session.active = true;
        session.operatorCode = empCode;
        session.sessionId = makeSessionId(empCode);
        session.loginTime = chrono::system_clock::now();
        session.loginTimeStr = currentTimestamp();
        session.pieceCount = 0;
        session.scannedTags.clear();

        cout << "\n=========================================" << endl;
        cout << "[LOGIN] Operator " << empCode << " is now ACTIVE." << endl;
        cout << "Session ID : " << session.sessionId << endl;
        cout << "Login Time : " << session.loginTimeStr << endl;
        cout << "=========================================" << endl;

        writeLogRow("LOGIN", empCode, session.sessionId, ScannedTag{});
    }
    else if (session.active && empCode == session.operatorCode) {
        auto now = chrono::system_clock::now();
        chrono::duration<double> workedSeconds = now - session.loginTime;
        string logoutTimeStr = currentTimestamp();

        cout << "\n=========================================" << endl;
        cout << "[LOGOUT] Operator " << empCode << " session ended." << endl;
        cout << "Session ID       : " << session.sessionId << endl;
        cout << "Login Time       : " << session.loginTimeStr << endl;
        cout << "Logout Time      : " << logoutTimeStr << endl;
        cout << "Duration         : " << formatDuration(workedSeconds.count()) << endl;
        cout << "Pieces completed : " << session.pieceCount << endl;
        if (session.scannedTags.empty()) {
            cout << "Tags scanned     : (none)" << endl;
        } else {
            cout << "Tags scanned     :" << endl;
            for (size_t i = 0; i < session.scannedTags.size(); i++) {
                const ScannedTag &t = session.scannedTags[i];
                cout << "  " << (i + 1) << ". Label #: "
                     << (t.labelNumber.empty() ? "(none)" : t.labelNumber)
                     << "   |  Internal ID: " << t.internalId
                     << "   |  Full raw: " << t.fullRaw << endl;
            }
        }
        cout << "=========================================" << endl;

        writeLogRow("LOGOUT", empCode, session.sessionId, ScannedTag{});

        session.active = false;
        session.operatorCode.clear();
        session.sessionId.clear();
        session.loginTimeStr.clear();
        session.pieceCount = 0;
        session.scannedTags.clear();
    }
    else {
        cout << "\n[WARNING] A different operator card (" << empCode << ") was read, but "
             << session.operatorCode << " is already logged in on this station." << endl;
        cout << "Ask the current operator to log out first (scan their own QR)." << endl;

        writeLogRow("LOGIN_CONFLICT", empCode, session.sessionId, ScannedTag{});
    }
}

void handleTagEvent(const string &rawPayload) {
    ScannedTag tag = parseTagPayload(rawPayload);

    lock_guard<mutex> lock(sessionMutex);

    // ---- Duplicate check (permanent, once-only per tag) ----
    if (alreadyScannedTags.count(rawPayload) > 0) {
        cout << "\n[DUPLICATE IGNORED] Tag " << tag.fullRaw
             << " (Label #: " << (tag.labelNumber.empty() ? "(none)" : tag.labelNumber) << ")"
             << " was already scanned earlier and cannot be counted again -- ignored." << endl;

        string opForLog = session.active ? session.operatorCode : "";
        string sessForLog = session.active ? session.sessionId : "";
        writeLogRow("DUPLICATE_IGNORED", opForLog, sessForLog, tag);
        return; // do NOT count, do NOT add to session list, do NOT unlock it
    }

    // Accepted as a genuine new scan -- lock this exact tag out permanently.
    alreadyScannedTags.insert(rawPayload);

    if (session.active) {
        session.pieceCount++;
        session.scannedTags.push_back(tag);
        cout << "\n[TAG SCANNED] Label #: " << (tag.labelNumber.empty() ? "(none)" : tag.labelNumber)
             << "  |  Internal ID: " << tag.internalId
             << "  |  Full raw: " << tag.fullRaw
             << "  |  Operator: " << session.operatorCode
             << "  |  Pieces this session: " << session.pieceCount << endl;
        writeLogRow("SCAN", session.operatorCode, session.sessionId, tag);
    } else {
        cout << "\n[UNATTRIBUTED SCAN] Tag " << tag.fullRaw
             << " was scanned but no operator is logged in on this station!" << endl;
        writeLogRow("UNATTRIBUTED_SCAN", "", "", tag);
    }
}

// ================================================================
// MAIN
// ================================================================

int main() {
    curl_global_init(CURL_GLOBAL_DEFAULT);

    ImageScanner scanner;
    scanner.set_config(ZBAR_NONE, ZBAR_CFG_ENABLE, 0);
    scanner.set_config(ZBAR_QRCODE, ZBAR_CFG_ENABLE, 1);

    // Operator QR codes are always in the form BF##### (2 letters "BF" + 5 digits).
    regex operatorCodeRegex(R"(^BF[0-9]{5}$)", regex::icase);

    string pipeline = "libcamerasrc ! video/x-raw, width=1456, height=1088, format=NV12, framerate=60/1 ! "
                      "videoconvert ! video/x-raw, format=BGR ! "
                      "appsink drop=true max-buffers=1";

    VideoCapture cap(pipeline, CAP_GSTREAMER);
    if (!cap.isOpened()) {
        cerr << "[ERROR] Critical: Could not interface with the Arducam IMX296 global shutter sensor via GStreamer." << endl;
        return -1;
    }

    cout << "[SUCCESS] Station active. Camera pipeline established at 60 FPS." << endl;
    if (!DASHBOARD_URL.empty()) {
        cout << "[INFO] Remote dashboard push ENABLED -> " << DASHBOARD_URL << endl;
    } else {
        cout << "[INFO] Remote dashboard push DISABLED (set DASHBOARD_URL env var to enable)." << endl;
    }

    thread camThread(captureThread, ref(cap));
    cpu_set_t coreSet;
    CPU_ZERO(&coreSet);
    CPU_SET(0, &coreSet);
    pthread_setaffinity_np(camThread.native_handle(), sizeof(cpu_set_t), &coreSet);
    camThread.detach();

    while (!hasFrame) {
        this_thread::sleep_for(chrono::milliseconds(5));
    }

    // ---- MACHINE PAIRING GATE ----
    finalizeControlDir();
    if (!loadMachineConfig()) {
        runPairingSetup(scanner);
    } else {
        cout << "[SETUP] Machine already paired as '" << MACHINE_ID << "'." << endl;
        writePairingStatus();
    }
    finalizeLogFilePath();
    thread adminThread(adminRequestPollThread);
    adminThread.detach();

    cout << "[INFO] Machine ID: " << MACHINE_ID << endl;
    cout << "[INFO] Raw scan debug output: " << (SCAN_DEBUG_MODE ? "ON" : "OFF") << endl;
    cout << "[INFO] Perf stats output: " << (SHOW_PERF_STATS ? "ON" : "OFF") << endl;
    cout << "[INFO] Fabric tag duplicate protection: each tag counted once only (permanent, resets on restart)" << endl;
    cout << "[INFO] Pairing/admin is controlled from the web dashboard, not this terminal." << endl;
    cout << "[INFO] Scan your own operator QR code to log in/out." << endl;
    cout << "[INFO] Scan a fabric tag QR normally for production scans." << endl;

    recoverSessionFromLog();

    thread previewThread(previewEncodeThread);
    thread streamThread(mjpegServerThread, 8080);

    CPU_ZERO(&coreSet);
    CPU_SET(1, &coreSet);
    pthread_setaffinity_np(previewThread.native_handle(), sizeof(cpu_set_t), &coreSet);

    CPU_ZERO(&coreSet);
    CPU_SET(2, &coreSet);
    pthread_setaffinity_np(streamThread.native_handle(), sizeof(cpu_set_t), &coreSet);

    previewThread.detach();
    streamThread.detach();

    Mat frame, croppedFrame, grayFrame;
    int frameCount = 0;
    auto fpsTimer = chrono::high_resolution_clock::now();

    unordered_map<string, chrono::steady_clock::time_point> lastSeenAt;
    const double PRESENCE_GAP_SECONDS = 2.5;

    while (true) {
        {
            lock_guard<mutex> lock(frameMutex);
            frame = latestFrame;
        }

        croppedFrame = frame(SCAN_ROI);
        cvtColor(croppedFrame, grayFrame, COLOR_BGR2GRAY);

        int width = grayFrame.cols;
        int height = grayFrame.rows;
        uchar *raw = grayFrame.data;

        Image zbarImage(width, height, "Y800", raw, width * height);
        int scanResult = scanner.scan(zbarImage);

        if (scanResult > 0) {
            for (Image::SymbolIterator symbol = zbarImage.symbol_begin(); symbol != zbarImage.symbol_end(); ++symbol) {
                string payload = symbol->get_data();

                auto now = chrono::steady_clock::now();

                auto it = lastSeenAt.find(payload);
                bool isNewTap;
                if (it == lastSeenAt.end()) {
                    isNewTap = true;
                } else {
                    chrono::duration<double> gap = now - it->second;
                    isNewTap = gap.count() >= PRESENCE_GAP_SECONDS;
                }
                lastSeenAt[payload] = now;

                if (!isNewTap) {
                    continue;
                }

                if (SCAN_DEBUG_MODE) {
                    cout << "[QR DEBUG] Decoded: '" << payload << "' (length=" << payload.size() << ")" << endl;
                }

                if (regex_match(payload, MACHINE_SETUP_QR_REGEX)) {
                    cout << "[INFO] Machine setup QR seen, but this station is already paired. Ignored." << endl;
                } else if (regex_match(payload, operatorCodeRegex)) {
                    handleOperatorEvent(payload);
                } else {
                    handleTagEvent(payload);
                }
            }
        }

        zbarImage.set_data(NULL, 0);

        frameCount++;
        auto now = chrono::high_resolution_clock::now();
        chrono::duration<double> sinceLastPrint = now - fpsTimer;
        if (sinceLastPrint.count() >= 1.0) {
            if (SHOW_PERF_STATS) {
                cout << "[PERF] Scan loop running at ~" << frameCount << " scans/sec" << endl;
            }
            frameCount = 0;
            fpsTimer = now;
        }
    }

    running = false;
    cap.release();
    curl_global_cleanup();
    return 0;
}