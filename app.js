// app.js - CK Warehouse FE (single file)
// ✅ Multi-device session: scan to join session (CKSESSION|PS-...)
// ✅ Cross-device badge lock: join/leave is SYNC (server confirms lock)
// ✅ Fast UX: start/wave/end are queued (async)
// ✅ Global session close: backend session_close is session-only (global), so end happens ONCE
// ✅ One end record: write Events row with task="SESSION" only once
// ✅ PACK-like tasks auto create session + auto end after last leave: PACK/退件入库/质检/废弃处理
// ✅ NEW: 批量出库（流程同入库理货）：start + 扫出库单号(去重计数) + join/leave + end

var LOCK_URL = "https://script.google.com/macros/s/AKfycbwPXpP853p_AVgTAfpTNThdiSd6Ho4BqpRs1vKX41NYxa3gNYJV6FULx-4Wmsf0uNw/exec";

/** ===== Router ===== */
var pages = [
  "home","badge","global_menu","b2c_menu",
  "b2c_tally","b2c_pick","b2c_pack","b2c_bulkout","b2c_return","b2c_qc","b2c_disposal","b2c_relabel",
  "active_now"
];

function setHash(page){ location.hash = "#/" + page; }
function getHashPage(){
  var h = (location.hash || "").trim();
  if(!h || h === "#") return "home";
  var m = h.match(/^#\/(.+)$/);
  if(!m) return "home";
  var p = m[1];
  return pages.indexOf(p) >= 0 ? p : "home";
}

function renderPages(){
  var cur = getHashPage();
  for(var i=0;i<pages.length;i++){
    var p = pages[i];
    var el = document.getElementById("page-"+p);
    if(el) el.style.display = (p===cur) ? "block" : "none";
  }

  if(cur==="badge"){ refreshUI(); refreshDaUI(); }

  if(cur==="b2c_tally"){ restoreState(); renderActiveLists(); renderInboundCountUI(); refreshUI(); }
  if(cur==="b2c_bulkout"){ restoreState(); renderActiveLists(); renderBulkOutUI(); refreshUI(); }
  if(cur==="b2c_pick"){ syncLeaderPickUI(); restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_pack"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_return"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_qc"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_disposal"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_relabel"){ restoreState(); renderActiveLists(); refreshUI(); }

  if(cur==="active_now"){ refreshActiveNow(); }
  if(cur==="b2c_menu"){ refreshUI(); }
}
window.addEventListener("hashchange", renderPages);

function go(p){ setHash(p); }
function back(){ if(history.length > 1) history.back(); else setHash("home"); }
if(!location.hash) setHash("home");

/** ===== Globals ===== */
var scanner = null;
var scanMode = null;

var currentSessionId = localStorage.getItem("pick_session_id") || null;

var scannedWaves = new Set();
var scannedInbounds = new Set();
var scannedBulkOutOrders = new Set();

var lastScanAt = 0;
var scanBusy = false;

var currentDaId = localStorage.getItem("da_id") || null;

var laborAction = null;
var laborBiz = null;
var laborTask = null;

var activePick = new Set();
var activeRelabel = new Set();
var activePack = new Set();
var activeTally = new Set();
var activeBulkOut = new Set();
var activeReturn = new Set();
var activeQc = new Set();
var activeDisposal = new Set();

var relabelTimerHandle = null;
var relabelStartTs = null;

var leaderPickBadge = localStorage.getItem("leader_pick_badge") || null;
var leaderPickOk = false;
var pendingLeaderEnd = null;

/** ===== Session state (server) ===== */
var SESSION_INFO_CACHE = { sid: null, ts: 0, data: null };
var SESSION_INFO_TTL_MS = 5000;

async function sessionInfoServer_(sid){
  var session = String(sid || currentSessionId || "").trim();
  if(!session) throw new Error("missing session");

  var now = Date.now();
  if(SESSION_INFO_CACHE.sid === session && (now - SESSION_INFO_CACHE.ts) < SESSION_INFO_TTL_MS && SESSION_INFO_CACHE.data){
    return SESSION_INFO_CACHE.data;
  }

  var res = await jsonp(LOCK_URL, { action: "session_info", session: session });
  if(!res || res.ok !== true) throw new Error((res && res.error) ? res.error : "session_info_failed");

  SESSION_INFO_CACHE = { sid: session, ts: now, data: res };
  return res;
}

// strict=true: session_info 查询失败时按 CLOSED 处理（阻断写操作，防脏数据）
async function isSessionClosedAsync_(strict){
  if(!currentSessionId) return false;
  try{
    var info = await sessionInfoServer_(currentSessionId);
    var st = String(info.status || "").trim().toUpperCase();
    return st === "CLOSED";
  }catch(e){
    if(strict){
      return true;
    }
    // 查询失败时不强行阻断，避免现场卡死；但会少一层保护
    return false;
  }
}

async function guardSessionOpenOrAlert_(msgWhenClosed, strict){
  if(!currentSessionId) return true;
  var closed = await isSessionClosedAsync_(!!strict);
  if(!closed) return true;

  alert(msgWhenClosed || "该趟次已结束，请重新开始或扫码加入新的趟次。");
  setStatus("该趟次已结束（请重新开始）", false);
  return false;
}

/** ===== Session join via QR ===== */
function sessionQrPayload_(sessionId){ return "CKSESSION|" + String(sessionId || "").trim(); }
function parseSessionQr_(text){
  var t = String(text || "").trim();
  if(!t) return null;
  if(t.indexOf("CKSESSION|") === 0){
    var sid = t.split("|").slice(1).join("|").trim();
    return sid || null;
  }
  if(t.indexOf("PS-") === 0) return t;
  return null;
}

async function joinExistingSessionByScan(){
  scanMode = "session_join";
  document.getElementById("scanTitle").textContent = "扫码加入趟次 / 세션 QR 스캔";
  await openScannerCommon();
}

function showSessionQr(){
  var box = document.getElementById("b2cSessionQrBox");
  if(!box) { alert("缺少 b2cSessionQrBox"); return; }

  box.innerHTML = "";
  if(!currentSessionId){
    box.innerHTML = '<div class="muted">本机没有 session（请先在任一作业页点开始，或先扫码加入）。</div>';
    return;
  }

  var payload = sessionQrPayload_(currentSessionId);

  var wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.alignItems = "center";
  wrap.style.gap = "8px";

  var label = document.createElement("div");
  label.className = "pill";
  label.textContent = "session: " + currentSessionId;
  wrap.appendChild(label);

  var qrEl = document.createElement("div");
  wrap.appendChild(qrEl);

  box.appendChild(wrap);
  new QRCode(qrEl, { text: payload, width: 180, height: 180 });
}

/** ===== Persist / Restore ===== */
function keyWaves(){ return "waves_" + (currentSessionId || "NA"); }
function keyActivePick(){ return "activePick_" + (currentSessionId || "NA"); }
function keyActiveRelabel(){ return "activeRelabel_" + (currentSessionId || "NA"); }
function keyActivePack(){ return "activePack_" + (currentSessionId || "NA"); }
function keyActiveTally(){ return "activeTally_" + (currentSessionId || "NA"); }
function keyActiveBulkOut(){ return "activeBulkOut_" + (currentSessionId || "NA"); }
function keyActiveReturn(){ return "activeReturn_" + (currentSessionId || "NA"); }
function keyActiveQc(){ return "activeQc_" + (currentSessionId || "NA"); }
function keyActiveDisposal(){ return "activeDisposal_" + (currentSessionId || "NA"); }

function keyInbounds(){ return "inbounds_" + (currentSessionId || "NA"); }
function keyBulkOutOrders(){ return "bulkoutOrders_" + (currentSessionId || "NA"); }

var RECENT_MAX = 80;
function keyRecent(){ return "recentEventIds_" + (currentSessionId || "NA"); }
function loadRecent(){
  try{ return JSON.parse(localStorage.getItem(keyRecent()) || "[]"); }catch(e){ return []; }
}
function saveRecent(arr){
  localStorage.setItem(keyRecent(), JSON.stringify(arr.slice(-RECENT_MAX)));
}
function hasRecent(eventId){
  var arr = loadRecent();
  return arr.indexOf(eventId) >= 0;
}
function addRecent(eventId){
  var arr = loadRecent();
  arr.push(eventId);
  if(arr.length > RECENT_MAX) arr = arr.slice(arr.length-RECENT_MAX);
  saveRecent(arr);
}
function makeEventId(params){
  // NOTE: keep stable; event_id used for server idempotency + local recent
  return [
    makeDeviceId(),
    (currentSessionId||"NA"),
    (params.wave_id||""),
    (params.biz||""),
    (params.task||""),
    (params.event||""),
    (params.badgeRaw||"")
  ].join("|");
}

function persistState(){
  if(!currentSessionId) return;
  localStorage.setItem(keyWaves(), JSON.stringify(Array.from(scannedWaves)));
  localStorage.setItem(keyActivePick(), JSON.stringify(Array.from(activePick)));
  localStorage.setItem(keyActiveRelabel(), JSON.stringify(Array.from(activeRelabel)));
  localStorage.setItem(keyActivePack(), JSON.stringify(Array.from(activePack)));
  localStorage.setItem(keyActiveTally(), JSON.stringify(Array.from(activeTally)));
  localStorage.setItem(keyActiveBulkOut(), JSON.stringify(Array.from(activeBulkOut)));
  localStorage.setItem(keyActiveReturn(), JSON.stringify(Array.from(activeReturn)));
  localStorage.setItem(keyActiveQc(), JSON.stringify(Array.from(activeQc)));
  localStorage.setItem(keyActiveDisposal(), JSON.stringify(Array.from(activeDisposal)));
  localStorage.setItem(keyInbounds(), JSON.stringify(Array.from(scannedInbounds)));
  localStorage.setItem(keyBulkOutOrders(), JSON.stringify(Array.from(scannedBulkOutOrders)));
}

function restoreState(){
  if(!currentSessionId) return;

  try{ scannedWaves = new Set(JSON.parse(localStorage.getItem(keyWaves()) || "[]")); }catch(e){ scannedWaves = new Set(); }
  try{ activePick = new Set(JSON.parse(localStorage.getItem(keyActivePick()) || "[]")); }catch(e){ activePick = new Set(); }
  try{ activeRelabel = new Set(JSON.parse(localStorage.getItem(keyActiveRelabel()) || "[]")); }catch(e){ activeRelabel = new Set(); }
  try{ activePack = new Set(JSON.parse(localStorage.getItem(keyActivePack()) || "[]")); }catch(e){ activePack = new Set(); }
  try{ activeTally = new Set(JSON.parse(localStorage.getItem(keyActiveTally()) || "[]")); }catch(e){ activeTally = new Set(); }
  try{ activeBulkOut = new Set(JSON.parse(localStorage.getItem(keyActiveBulkOut()) || "[]")); }catch(e){ activeBulkOut = new Set(); }
  try{ activeReturn = new Set(JSON.parse(localStorage.getItem(keyActiveReturn()) || "[]")); }catch(e){ activeReturn = new Set(); }
  try{ activeQc = new Set(JSON.parse(localStorage.getItem(keyActiveQc()) || "[]")); }catch(e){ activeQc = new Set(); }
  try{ activeDisposal = new Set(JSON.parse(localStorage.getItem(keyActiveDisposal()) || "[]")); }catch(e){ activeDisposal = new Set(); }
  try{ scannedInbounds = new Set(JSON.parse(localStorage.getItem(keyInbounds()) || "[]")); }catch(e){ scannedInbounds = new Set(); }
  try{ scannedBulkOutOrders = new Set(JSON.parse(localStorage.getItem(keyBulkOutOrders()) || "[]")); }catch(e){ scannedBulkOutOrders = new Set(); }
}

/** ===== Utils ===== */
function makeDeviceId(){
  var id = localStorage.getItem("device_id");
  if(!id){
    id = "DEV-" + Math.random().toString(16).slice(2) + "-" + Date.now().toString().slice(-6);
    localStorage.setItem("device_id", id);
  }
  return id;
}

function makePickSessionId(){
  var d = new Date();
  var yyyy = d.getFullYear();
  var mm = String(d.getMonth()+1).padStart(2,'0');
  var dd = String(d.getDate()).padStart(2,'0');
  var hh = String(d.getHours()).padStart(2,'0');
  var mi = String(d.getMinutes()).padStart(2,'0');
  var ss = String(d.getSeconds()).padStart(2,'0');
  return "PS-" + yyyy + mm + dd + "-" + hh + mi + ss + "-" + makeDeviceId().slice(-6);
}

function setStatus(msg, ok){
  if(ok===undefined) ok=true;
  var el = document.getElementById("status");
  if(!el) return;
  el.className = "pill " + (ok ? "ok" : "bad");
  el.textContent = msg;
}

function refreshUI(){
  var dev = document.getElementById("device");
  var ses = document.getElementById("session");
  if(dev) dev.textContent = makeDeviceId();
  if(ses) ses.textContent = currentSessionId || "无 / 없음";

  var sp = document.getElementById("b2cSessionQrPill");
  if(sp){
    sp.textContent = currentSessionId ? ("session: " + currentSessionId) : "session: 无";
  }
}

/** ===== Network pill ===== */
function refreshNet(){
  var el = document.getElementById("netPill");
  if(!el) return;
  el.textContent = navigator.onLine ? "Online" : "Offline";
  el.style.borderColor = navigator.onLine ? "#0a0" : "#b00";
}
window.addEventListener("online", refreshNet);
window.addEventListener("offline", refreshNet);

/** ===== JSONP ===== */
function jsonp(url, params){
  return new Promise(function(resolve, reject){
    var cb = "cb_" + Math.random().toString(16).slice(2);
    var qs = [];
    for(var k in params){
      if(!params.hasOwnProperty(k)) continue;
      qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    qs.push("callback=" + encodeURIComponent(cb));
    var src = url + "?" + qs.join("&");

    var script = document.createElement("script");
    var timer = setTimeout(function(){
      cleanup();
      reject(new Error("jsonp timeout"));
    }, 12000);

    function cleanup(){
      try{ delete window[cb]; }catch(e){ window[cb]=undefined; }
      if(script && script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    }

    window[cb] = function(data){
      cleanup();
      resolve(data);
    };

    script.onerror = function(){
      cleanup();
      reject(new Error("jsonp error"));
    };
    script.src = src;
    document.body.appendChild(script);
  });
}

/** ===== Async event queue (non-locking events) ===== */
var QUEUE_KEY = "event_queue_v1";
var FLUSHING = false;

function loadQueue_(){
  try{ return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }catch(e){ return []; }
}
function saveQueue_(q){
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-200)));
}
function enqueueEvent_(payload){
  var q = loadQueue_();
  q.push({ payload: payload, tries: 0, enq_ms: Date.now() });
  saveQueue_(q);
}

async function flushQueue_(){
  if(FLUSHING) return;
  if(!navigator.onLine) return;

  var q = loadQueue_();
  if(q.length === 0) return;

  FLUSHING = true;
  try{
    var keep = [];
    for(var i=0;i<q.length;i++){
      var item = q[i];
      try{
        item.tries = (item.tries||0) + 1;
        await submitEventSync_(item.payload, true);
      }catch(e){
        if(item.tries < 8) keep.push(item);
      }
    }
    saveQueue_(keep);
  } finally {
    FLUSHING = false;
  }
}

setInterval(function(){ flushQueue_(); }, 1500);
window.addEventListener("online", function(){ flushQueue_(); });

/** ===== Submit event (sync) ===== */
async function submitEventSync_(o, silent){
  var params = {
    action: "event_submit",
    event_id: o.event_id || "",
    event: o.event || "",
    biz: o.biz || "",
    task: o.task || "",
    pick_session_id: o.pick_session_id || "NA",
    wave_id: o.wave_id || "",
    da_id: o.da_id || "",
    device_id: makeDeviceId(),
    client_ms: (o.client_ms || Date.now())
  };

  var res = await jsonp(LOCK_URL, params);

  if(!res || res.ok !== true){
    throw new Error((res && res.error) ? res.error : "提交失败：event_submit failed");
  }

  if(res.locked === false){
    var lk = res.lock || {};
    var msg =
      "该工牌已在其它设备作业中，无法加入。\n\n" +
      "占用任务: " + (lk.task || "未知") + "\n" +
      "占用设备: " + (lk.device_id || "未知") + "\n" +
      "占用趟次: " + (lk.session || "未知") + "\n\n" +
      "请先在原设备退出（leave）后再加入。";
    throw new Error(msg);
  }

  return res;
}

async function submitEvent(o){
  enqueueEvent_(o);
  flushQueue_();
  return { ok:true, queued:true };
}

/** ===== Global session close helpers ===== */
async function sessionCloseServer_(){
  if(!currentSessionId) throw new Error("missing session");
  var res = await jsonp(LOCK_URL, {
    action: "session_close",
    session: currentSessionId,
    device_id: makeDeviceId()
  });
  if(!res || res.ok !== true) throw new Error(res && res.error ? res.error : "session_close_failed");
  return res;
}

function formatActiveListForAlert_(active){
  if(!active || !active.length) return "";
  return active.map(function(x){
    return (x.badge||"") + " (" + (x.task||"") + ")";
  }).join("\n");
}

// ✅ FIX: cleanup must clear BOTH localStorage AND in-memory sets + UI
function cleanupLocalSession_(){
  // remove localStorage snapshot for this session
  localStorage.removeItem(keyWaves());
  localStorage.removeItem(keyActivePick());
  localStorage.removeItem(keyActiveRelabel());
  localStorage.removeItem(keyActivePack());
  localStorage.removeItem(keyActiveTally());
  localStorage.removeItem(keyActiveBulkOut());
  localStorage.removeItem(keyActiveReturn());
  localStorage.removeItem(keyActiveQc());
  localStorage.removeItem(keyActiveDisposal());
  localStorage.removeItem(keyInbounds());
  localStorage.removeItem(keyBulkOutOrders());
  localStorage.removeItem(keyRecent());

  // clear in-memory state
  scannedWaves = new Set();
  scannedInbounds = new Set();
  scannedBulkOutOrders = new Set();

  activePick = new Set();
  activeRelabel = new Set();
  activePack = new Set();
  activeTally = new Set();
  activeBulkOut = new Set();
  activeReturn = new Set();
  activeQc = new Set();
  activeDisposal = new Set();

  // clear session + caches
  currentSessionId = null;
  localStorage.removeItem("pick_session_id");
  SESSION_INFO_CACHE = { sid: null, ts: 0, data: null };

  // refresh UI immediately
  refreshUI();
  renderActiveLists();
  renderInboundCountUI();
  renderBulkOutUI();
}

async function endSessionGlobal_(){
  if(!currentSessionId){ setStatus("没有未结束趟次", false); return; }

  var r = await sessionCloseServer_();
  if(r.blocked){
    var msg = "还有人员未退出，不能结束。\n\n" + formatActiveListForAlert_(r.active);
    setStatus("还有人员未退出，禁止结束", false);
    alert(msg);
    return;
  }
  if(r.already_closed){
    alert("该趟次已结束（无需重复结束）");
    setStatus("该趟次已结束（无需重复结束）", true);
    cleanupLocalSession_();
    return;
  }

  var evId = makeEventId({ event:"end", biz:"B2C", task:"SESSION", wave_id:"", badgeRaw:"" });
  if(!hasRecent(evId)){
    submitEvent({ event:"end", event_id: evId, biz:"B2C", task:"SESSION", pick_session_id: currentSessionId });
    addRecent(evId);
  }

  setStatus("趟次结束已记录（待上传）✅", true);
  cleanupLocalSession_();
}

function taskAutoSession_(task){
  return task === "PACK" || task === "退件入库" || task === "质检" || task === "废弃处理";
}

async function tryAutoEndSessionAfterLeave_(){
  if(!taskAutoSession_(laborTask)) return;
  if(!currentSessionId) return;

  try{
    var r = await sessionCloseServer_();
    if(r && r.blocked) return;

    if(r && r.already_closed){
      cleanupLocalSession_();
      return;
    }

    if(r && r.closed){
      var evIdEnd = makeEventId({ event:"end", biz:"B2C", task:"SESSION", wave_id:"", badgeRaw:"" });
      if(!hasRecent(evIdEnd)){
        submitEvent({ event:"end", event_id: evIdEnd, biz:"B2C", task:"SESSION", pick_session_id: currentSessionId });
        addRecent(evIdEnd);
      }
      cleanupLocalSession_();
      return;
    }
  }catch(e){}
}

/** ===== Badge helpers ===== */
function parseBadge(code){
  var raw = (code || "").trim();
  var parts = raw.split("|");
  var id = (parts[0] || "").trim();
  var name = (parts[1] || "").trim();
  return { raw: raw, id: id, name: name };
}
function isDaId(id){ return /^DA-\d{8}-\d+$/.test(id); }
function isEmpId(id){ return /^EMP-[A-Za-z0-9_-]+$/.test(id); }
function isPermanentDaId(id){ return /^DAF-\d+$/.test(id); }
function isOperatorBadge(raw){
  var p = parseBadge(raw);
  return isDaId(p.id) || isEmpId(p.id) || isPermanentDaId(p.id);
}

/** ===== Active (local cache only) ===== */
function isAlreadyActive(task, badge){
  if(task==="PICK") return activePick.has(badge);
  if(task==="RELABEL") return activeRelabel.has(badge);
  if(task==="PACK") return activePack.has(badge);
  if(task==="TALLY") return activeTally.has(badge);
  if(task==="批量出库") return activeBulkOut.has(badge);
  if(task==="退件入库") return activeReturn.has(badge);
  if(task==="质检") return activeQc.has(badge);
  if(task==="废弃处理") return activeDisposal.has(badge);
  return false;
}
function applyActive(task, action, badge){
  if(task==="PICK"){ if(action==="join") activePick.add(badge); if(action==="leave") activePick.delete(badge); }
  if(task==="RELABEL"){ if(action==="join") activeRelabel.add(badge); if(action==="leave") activeRelabel.delete(badge); }
  if(task==="PACK"){ if(action==="join") activePack.add(badge); if(action==="leave") activePack.delete(badge); }
  if(task==="TALLY"){ if(action==="join") activeTally.add(badge); if(action==="leave") activeTally.delete(badge); }
  if(task==="批量出库"){ if(action==="join") activeBulkOut.add(badge); if(action==="leave") activeBulkOut.delete(badge); }
  if(task==="退件入库"){ if(action==="join") activeReturn.add(badge); if(action==="leave") activeReturn.delete(badge); }
  if(task==="质检"){ if(action==="join") activeQc.add(badge); if(action==="leave") activeQc.delete(badge); }
  if(task==="废弃处理"){ if(action==="join") activeDisposal.add(badge); if(action==="leave") activeDisposal.delete(badge); }
}

/** ===== Render lists ===== */
function badgeDisplay(raw){
  var p = parseBadge(raw);
  return p.name ? (p.id + "｜" + p.name) : p.id;
}
function renderSetToHtml(setObj){
  var arr = Array.from(setObj);
  if(arr.length === 0) return '<span class="muted">无 / 없음</span>';
  return arr.map(function(x){ return '<span class="tag">' + badgeDisplay(x) + '</span>'; }).join("");
}

function renderActiveLists(){
  var pc = document.getElementById("pickCount");
  var pl = document.getElementById("pickActiveList");
  if(pc) pc.textContent = String(activePick.size);
  if(pl) pl.innerHTML = renderSetToHtml(activePick);

  var rc = document.getElementById("relabelCount");
  var rl = document.getElementById("relabelActiveList");
  if(rc) rc.textContent = String(activeRelabel.size);
  if(rl) rl.innerHTML = renderSetToHtml(activeRelabel);

  var kc = document.getElementById("packCount") || document.getElementById("packCountPeople");
  var kl = document.getElementById("packActiveList");
  if(kc) kc.textContent = String(activePack.size);
  if(kl) kl.innerHTML = renderSetToHtml(activePack);

  var tc = document.getElementById("tallyCount");
  var tl = document.getElementById("tallyActiveList");
  if(tc) tc.textContent = String(activeTally.size);
  if(tl) tl.innerHTML = renderSetToHtml(activeTally);

  var bc = document.getElementById("bulkoutCount");
  var bl = document.getElementById("bulkoutActiveList");
  if(bc) bc.textContent = String(activeBulkOut.size);
  if(bl) bl.innerHTML = renderSetToHtml(activeBulkOut);

  var xc = document.getElementById("returnCount");
  var xl = document.getElementById("returnActiveList");
  if(xc) xc.textContent = String(activeReturn.size);
  if(xl) xl.innerHTML = renderSetToHtml(activeReturn);

  var qc = document.getElementById("qcCount");
  var ql = document.getElementById("qcActiveList");
  if(qc) qc.textContent = String(activeQc.size);
  if(ql) ql.innerHTML = renderSetToHtml(activeQc);

  var dc = document.getElementById("disposalCount");
  var dl = document.getElementById("disposalActiveList");
  if(dc) dc.textContent = String(activeDisposal.size);
  if(dl) dl.innerHTML = renderSetToHtml(activeDisposal);
}

function renderInboundCountUI(){
  var c = document.getElementById("inboundCount");
  var l = document.getElementById("inboundList");
  if(c) c.textContent = String(scannedInbounds.size);
  if(l){
    if(scannedInbounds.size === 0){
      l.innerHTML = '<span class="muted">无 / 없음</span>';
    }else{
      var arr = Array.from(scannedInbounds);
      var show = arr.slice(Math.max(0, arr.length - 30));
      l.innerHTML = show.map(function(x){ return '<span class="tag">'+String(x)+'</span>'; }).join(" ");
    }
  }
}

function renderBulkOutUI(){
  var c = document.getElementById("bulkoutOrderCount");
  var l = document.getElementById("bulkoutOrderList");
  if(c) c.textContent = String(scannedBulkOutOrders.size);
  if(l){
    if(scannedBulkOutOrders.size === 0){
      l.innerHTML = '<span class="muted">无 / 없음</span>';
    }else{
      var arr = Array.from(scannedBulkOutOrders);
      var show = arr.slice(Math.max(0, arr.length - 30));
      l.innerHTML = show.map(function(x){ return '<span class="tag">'+String(x)+'</span>'; }).join(" ");
    }
  }
}

/** ===== Global Active Now (legacy) ===== */
function esc(s){
  return String(s||"").replace(/[&<>"']/g,function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);
  });
}
function fmtDur(ms){
  if(!ms || ms<0) return "";
  var sec = Math.floor(ms/1000);
  var h = Math.floor(sec/3600);
  var m = Math.floor((sec%3600)/60);
  if(h>0) return h + "h" + String(m).padStart(2,"0") + "m";
  return m + "m";
}

async function refreshActiveNow(){
  try{
    setStatus("拉取在岗中... ⏳", true);
    var res = await jsonp(LOCK_URL, { action:"active_now" });

    if(!res || res.ok !== true){
      setStatus("在岗拉取失败 ❌ " + (res && res.error ? res.error : ""), false);
      alert("在岗拉取失败：" + (res && res.error ? res.error : "unknown"));
      return;
    }

    var active = res.active || [];
    var asof = res.asof || Date.now();

    var meta = document.getElementById("activeNowMeta");
    if(meta) meta.textContent = "人数: " + active.length + " ｜ " + new Date(asof).toLocaleString();

    var by = {};
    active.forEach(function(x){
      var k = (x.biz||"") + " / " + (x.task||"");
      by[k] = (by[k]||0) + 1;
    });

    var sumEl = document.getElementById("activeNowSummary");
    if(sumEl){
      var keys = Object.keys(by).sort();
      sumEl.innerHTML = keys.length
        ? keys.map(function(k){ return '<span class="tag">'+esc(k)+': '+by[k]+'</span>'; }).join(" ")
        : '<span class="muted">当前无人在岗</span>';
    }

    var listEl = document.getElementById("activeNowList");
    if(listEl){
      if(active.length===0){
        listEl.innerHTML = '<div class="muted">当前无人在岗</div>';
      }else{
        var now = Date.now();
        listEl.innerHTML = active.map(function(x){
          var dur = fmtDur(now - (x.since||now));
          return (
            '<div style="border:1px solid #eee;border-radius:12px;padding:10px;margin:8px 0;">' +
              '<div style="font-weight:700;">'+esc(x.badge)+'</div>' +
              '<div class="muted" style="margin-top:4px;">作业: '+esc(x.biz)+' / '+esc(x.task)+' ｜ 在岗: '+esc(dur)+'</div>' +
              '<div class="muted" style="margin-top:4px;">session: '+esc(x.session||"")+' ｜ device: '+esc(x.device_id||"")+'</div>' +
            '</div>'
          );
        }).join("");
      }
    }

    setStatus("在岗拉取更新 ✅", true);
  }catch(e){
    setStatus("在岗拉取异常 ❌ " + e, false);
    alert("在岗拉取异常：" + e);
  }
}

/** ===== B2C Start/End ===== */
async function startTally(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始理货】重新开新趟次，或扫码加入别的趟次。", true))) return;

      restoreState(); renderActiveLists(); renderInboundCountUI(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    activeTally = new Set();
    scannedInbounds = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"TALLY", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"TALLY", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    renderActiveLists();
    renderInboundCountUI();
    setStatus("理货开始已记录（待上传）✅", true);
  }catch(e){
    setStatus("理货开始失败 ❌ " + e, false);
  }
}
async function endTally(){ return endSessionGlobal_(); }

async function startBulkOut(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始批量出库】重新开新趟次，或扫码加入别的趟次。", true))) return;

      restoreState(); renderActiveLists(); renderBulkOutUI(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    activeBulkOut = new Set();
    scannedBulkOutOrders = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"批量出库", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"批量出库", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    renderActiveLists();
    renderBulkOutUI();
    setStatus("批量出库开始已记录（待上传）✅", true);
  }catch(e){
    setStatus("批量出库开始失败 ❌ " + e, false);
  }
}
async function endBulkOut(){ return endSessionGlobal_(); }

async function startPicking(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始拣货】重新开新趟次，或扫码加入别的趟次。", true))) return;

      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    leaderPickOk = false;
    leaderPickBadge = null;
    localStorage.removeItem("leader_pick_badge");

    activePick = new Set();
    scannedWaves = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"PICK", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"PICK", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    renderActiveLists();
    syncLeaderPickUI();
    setStatus("拣货开始已记录（待上传）✅", true);
  }catch(e){
    setStatus("拣货开始失败 ❌ " + e, false);
  }
}
async function endPicking(){ return endSessionGlobal_(); }

async function startRelabel(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始换标】重新开新趟次，或扫码加入别的趟次。", true))) return;

      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    activeRelabel = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"RELABEL", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"RELABEL", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    renderActiveLists();
    setStatus("换标开始已记录（待上传）✅", true);
  }catch(e){
    setStatus("换标开始失败 ❌ " + e, false);
  }
}
async function endRelabel(){ return endSessionGlobal_(); }

async function startPack(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始打包】重新开新趟次，或扫码加入别的趟次。", true))) return;

      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    activePack = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"PACK", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"PACK", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    renderActiveLists();
    setStatus("打包开始已记录（待上传）✅", true);
  }catch(e){
    setStatus("打包开始失败 ❌ " + e, false);
  }
}
async function endPack(){ return endSessionGlobal_(); }

async function startReturn(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始退件入库】重新开新趟次，或扫码加入别的趟次。", true))) return;

      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    activeReturn = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"退件入库", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"退件入库", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    renderActiveLists();
    setStatus("退件入库开始已记录（待上传）✅", true);
  }catch(e){
    setStatus("退件入库开始失败 ❌ " + e, false);
  }
}
async function endReturn(){ return endSessionGlobal_(); }

async function startQc(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始质检】重新开新趟次，或扫码加入别的趟次。", true))) return;

      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    activeQc = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"质检", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"质检", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    renderActiveLists();
    setStatus("质检开始已记录（待上传���✅", true);
  }catch(e){
    setStatus("质检开始失败 ❌ " + e, false);
  }
}
async function endQc(){ return endSessionGlobal_(); }

async function startDisposal(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始废弃处理】重新开新趟次，或扫码加入别的趟次。", true))) return;

      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    activeDisposal = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"废弃处理", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"废弃处理", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    renderActiveLists();
    setStatus("废弃处理开始已记录（待上传）✅", true);
  }catch(e){
    setStatus("废弃处理开始失败 ❌ " + e, false);
  }
}
async function endDisposal(){ return endSessionGlobal_(); }

/** ===== Scanner common ===== */
async function openScannerCommon(){
  if(scanBusy) return;
  scanBusy = true;

  try{
    if(!document.getElementById("scanModal")) { alert("缺少 scanModal"); return; }

    document.getElementById("scanModal").style.display = "flex";

    if(!scanner){
      scanner = new Html5Qrcode("reader");
    }

    var config = { fps: 10, qrbox: { width: 280, height: 280 } };

    await scanner.start(
      { facingMode: "environment" },
      config,
      async function(decodedText){
        var now = Date.now();
        if(now - lastScanAt < 700) return;
        lastScanAt = now;

        try{
          await onScan_(decodedText);
        }catch(e){
          setStatus("扫码处理失败 ❌ " + e, false);
          alert("扫码处理失败：" + e);
        }
      },
      function(_){ /* ignore */ }
    );
  }catch(e){
    setStatus("打开扫码失败 ❌ " + e, false);
    alert("打开扫码失败：" + e);
  } finally {
    scanBusy = false;
  }
}

async function closeScanner(){
  try{
    if(scanner){
      await scanner.stop();
      await scanner.clear();
    }
  }catch(e){}
  var m = document.getElementById("scanModal");
  if(m) m.style.display = "none";
}

/** ===== Scan modes ===== */
async function onScan_(decodedText){
  var text = String(decodedText || "").trim();
  if(!text) return;

  // Session join
  if(scanMode === "session_join"){
    var sid = parseSessionQr_(text);
    if(!sid){
      alert("不是 session 二维码：" + text);
      return;
    }

    currentSessionId = sid;
    localStorage.setItem("pick_session_id", currentSessionId);

    // 尝试恢复该 session 的本地快照（如果本机以前加入过）
    restoreState();
    refreshUI();
    renderActiveLists();
    renderInboundCountUI();
    renderBulkOutUI();

    // 加入后立刻检查是否已关闭（防止扫到历史 session）
    var closed = await isSessionClosedAsync_(true);
    if(closed){
      alert("该趟次已结束（CLOSED）。\n请让组长提供新的趟次二维码，或在任一作业页重新开始。");

      // 回滚：不要让本机停留在一个已结束的 session 上
      cleanupLocalSession_();

      setStatus("加入失败：该趟次已结束", false);
    }else{
      alert("已加入趟次 ✅\n" + currentSessionId);
      setStatus("已加入趟次 ✅ " + currentSessionId, true);
    }

    await closeScanner();
    return;
  }

  // Wave scan (PICK)
  if(scanMode === "wave"){
    if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再扫码波次，请重新开始。", true))) return;

    var wave = text;
    if(scannedWaves.has(wave)){
      setStatus("重复波次：" + wave, false);
      return;
    }
    scannedWaves.add(wave);
    persistState();
    syncLeaderPickUI();

    var evId = makeEventId({ event:"wave", biz:"B2C", task:"PICK", wave_id: wave, badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"wave", event_id: evId, biz:"B2C", task:"PICK", pick_session_id: currentSessionId, wave_id: wave });
      addRecent(evId);
    }

    setStatus("已记录波次 ✅ " + wave, true);
    return;
  }

  // Inbound scan (TALLY)
  if(scanMode === "inbound"){
    if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再扫码入库单，请重新开始。", true))) return;

    var inboundNo = text;
    if(scannedInbounds.has(inboundNo)){
      setStatus("重复入库单：" + inboundNo, false);
      return;
    }
    scannedInbounds.add(inboundNo);
    persistState();
    renderInboundCountUI();

    var evId2 = makeEventId({ event:"inbound", biz:"B2C", task:"TALLY", wave_id: inboundNo, badgeRaw:"" });
    if(!hasRecent(evId2)){
      submitEvent({ event:"inbound", event_id: evId2, biz:"B2C", task:"TALLY", pick_session_id: currentSessionId, wave_id: inboundNo });
      addRecent(evId2);
    }

    setStatus("已记录入库单 ✅ " + inboundNo, true);
    return;
  }

  // Bulk out order scan (批量出库)
  if(scanMode === "bulkout_order"){
    if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再扫码出库单，请重新开始。", true))) return;

    var outNo = text;
    if(scannedBulkOutOrders.has(outNo)){
      setStatus("重复出库单：" + outNo, false);
      return;
    }
    scannedBulkOutOrders.add(outNo);
    persistState();
    renderBulkOutUI();

    var evId3 = makeEventId({ event:"bulkout_order", biz:"B2C", task:"批量出库", wave_id: outNo, badgeRaw:"" });
    if(!hasRecent(evId3)){
      submitEvent({ event:"bulkout_order", event_id: evId3, biz:"B2C", task:"批量出库", pick_session_id: currentSessionId, wave_id: outNo });
      addRecent(evId3);
    }

    setStatus("已记录出库单 ✅ " + outNo, true);
    return;
  }

  // Join/Leave work (badge)
  if(scanMode === "labor"){
    if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再加入/退出，请重新开始。", true))) return;

    if(!isOperatorBadge(text)){
      alert("不是有效工牌：" + text);
      return;
    }
    var badgeRaw = text;

    var task = laborTask;
    var biz = laborBiz;
    var action = laborAction;

    if(!task || !biz || !action){
      alert("内部错误：缺少 laborTask/biz/action");
      return;
    }

    if(action === "join"){
      if(isAlreadyActive(task, badgeRaw)){
        setStatus("已在岗（本机）：" + badgeDisplay(badgeRaw), false);
        return;
      }

      // join 是强一致写：直接同步提交（拿锁）
      var evIdJ = makeEventId({ event:"join", biz:biz, task:task, wave_id:"", badgeRaw:badgeRaw });
      if(hasRecent(evIdJ)){
        setStatus("疑似重复 join（已跳过）：" + badgeDisplay(badgeRaw), false);
        return;
      }

      try{
        await submitEventSync_({
          event:"join",
          event_id: evIdJ,
          biz: biz,
          task: task,
          pick_session_id: currentSessionId,
          da_id: badgeRaw
        });

        applyActive(task, "join", badgeRaw);
        persistState();
        renderActiveLists();

        addRecent(evIdJ);
        setStatus("加入成功 ✅ " + badgeDisplay(badgeRaw), true);
      }catch(e){
        setStatus("加入失败 ❌ " + e, false);
        alert(String(e));
      }
      return;
    }

    if(action === "leave"){
      if(!isAlreadyActive(task, badgeRaw)){
        setStatus("不在岗（本机）：" + badgeDisplay(badgeRaw), false);
        return;
      }

      var evIdL = makeEventId({ event:"leave", biz:biz, task:task, wave_id:"", badgeRaw:badgeRaw });
      if(hasRecent(evIdL)){
        setStatus("疑似重复 leave（已跳过）：" + badgeDisplay(badgeRaw), false);
        return;
      }

      try{
        await submitEventSync_({
          event:"leave",
          event_id: evIdL,
          biz: biz,
          task: task,
          pick_session_id: currentSessionId,
          da_id: badgeRaw
        });

        applyActive(task, "leave", badgeRaw);
        persistState();
        renderActiveLists();

        addRecent(evIdL);
        setStatus("退出成功 ✅ " + badgeDisplay(badgeRaw), true);

        // PACK-like task auto end after last leave
        await tryAutoEndSessionAfterLeave_();

      }catch(e){
        setStatus("退出失败 ❌ " + e, false);
        alert(String(e));
      }
      return;
    }
  }

  alert("未知扫码模式: " + scanMode);
}

/** ===== Scan open helpers ===== */
async function openScannerWave(){
  scanMode = "wave";
  document.getElementById("scanTitle").textContent = "扫码波次 / Wave Scan";
  await openScannerCommon();
}
async function openScannerInboundCount(){
  scanMode = "inbound";
  document.getElementById("scanTitle").textContent = "扫码入库单 / Inbound Scan";
  await openScannerCommon();
}
async function openScannerBulkOutOrder(){
  scanMode = "bulkout_order";
  document.getElementById("scanTitle").textContent = "扫码出库单 / Bulk-out Order Scan";
  await openScannerCommon();
}

async function openScannerLabor(action, biz, task){
  if(!currentSessionId){
    alert("请先开始趟次（start）或扫码加入趟次（session_join）");
    return;
  }
  laborAction = action;
  laborBiz = biz;
  laborTask = task;
  scanMode = "labor";
  document.getElementById("scanTitle").textContent =
    (action==="join" ? "扫码加入" : "扫码退出") + " / " + biz + " " + task;
  await openScannerCommon();
}

/** ===== Leader PICK control ===== */
function syncLeaderPickUI(){
  var el = document.getElementById("leaderPickPill");
  var okEl = document.getElementById("leaderPickOk");
  if(el){
    if(leaderPickBadge){
      el.textContent = "组长: " + badgeDisplay(leaderPickBadge);
    }else{
      el.textContent = "未登录组长";
    }
  }
  if(okEl){
    okEl.textContent = leaderPickOk ? "✅ OK" : "❌ 未确认";
    okEl.style.color = leaderPickOk ? "#0a0" : "#b00";
  }
  var btn = document.getElementById("btnLeaderEndPick");
  if(btn){
    btn.disabled = !leaderPickOk;
  }
}

async function leaderLoginPick(){
  if(!currentSessionId){ alert("请先开始拣货趟次"); return; }
  if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能登录组长，请重新开始。", true))) return;

  var raw = prompt("请输入组长工牌（如 EMP-001|张三）或扫码（推荐扫码）。\n\n提示：现场建议扫码，减少输入错误。");
  if(raw === null) return;
  raw = String(raw||"").trim();
  if(!raw){
    alert("未输入工牌");
    return;
  }
  if(!isOperatorBadge(raw)){
    alert("工牌格式不正确：" + raw);
    return;
  }

  leaderPickBadge = raw;
  localStorage.setItem("leader_pick_badge", leaderPickBadge);
  leaderPickOk = true;
  syncLeaderPickUI();
  setStatus("组长已登录 ✅ " + badgeDisplay(raw), true);
}

async function leaderEndPick(){
  if(!currentSessionId){ alert("没有趟次"); return; }
  if(!(await guardSessionOpenOrAlert_("该趟次已结束：无需再结束。", true))) return;

  if(!leaderPickOk){
    alert("请先登录组长");
    return;
  }

  var ok = confirm("确认由组长结束该趟次？\n\nsession: " + currentSessionId + "\n组长: " + badgeDisplay(leaderPickBadge));
  if(!ok) return;

  await endSessionGlobal_();
}

/** ===== Badge page / DA helpers ===== */
function refreshDaUI(){
  var el = document.getElementById("da");
  if(el) el.textContent = currentDaId || "无 / 없음";
}

function saveDa(){
  var raw = prompt("请输入 DA（如 DA-20250101-1）");
  if(raw === null) return;
  raw = String(raw||"").trim();
  if(!raw){ alert("为空"); return; }
  currentDaId = raw;
  localStorage.setItem("da_id", currentDaId);
  refreshDaUI();
  setStatus("已保存 DA ✅ " + raw, true);
}

function clearDa(){
  if(!confirm("确认清空 DA？")) return;
  currentDaId = null;
  localStorage.removeItem("da_id");
  refreshDaUI();
  setStatus("已清空 DA", true);
}

/** ===== Buttons wiring (called by HTML onclick) ===== */
function goHome(){ go("home"); }
function goBadge(){ go("badge"); }
function goGlobalMenu(){ go("global_menu"); }
function goB2cMenu(){ go("b2c_menu"); }

function goTally(){ go("b2c_tally"); }
function goPick(){ go("b2c_pick"); }
function goRelabel(){ go("b2c_relabel"); }
function goPack(){ go("b2c_pack"); }
function goBulkOut(){ go("b2c_bulkout"); }
function goReturn(){ go("b2c_return"); }
function goQc(){ go("b2c_qc"); }
function goDisposal(){ go("b2c_disposal"); }

function goActiveNow(){ go("active_now"); }

/** ===== B2C actions exposed to UI ===== */
async function b2cStartTally(){ await startTally(); }
async function b2cEndTally(){ await endTally(); }
async function b2cScanInbound(){ await openScannerInboundCount(); }
async function b2cJoinTally(){ await openScannerLabor("join", "B2C", "TALLY"); }
async function b2cLeaveTally(){ await openScannerLabor("leave", "B2C", "TALLY"); }

async function b2cStartPick(){ await startPicking(); }
async function b2cEndPick(){ await endPicking(); }
async function b2cScanWave(){ await openScannerWave(); }
async function b2cJoinPick(){ await openScannerLabor("join", "B2C", "PICK"); }
async function b2cLeavePick(){ await openScannerLabor("leave", "B2C", "PICK"); }
async function b2cLeaderLoginPick(){ await leaderLoginPick(); }
async function b2cLeaderEndPick(){ await leaderEndPick(); }

async function b2cStartRelabel(){ await startRelabel(); }
async function b2cEndRelabel(){ await endRelabel(); }
async function b2cJoinRelabel(){ await openScannerLabor("join", "B2C", "RELABEL"); }
async function b2cLeaveRelabel(){ await openScannerLabor("leave", "B2C", "RELABEL"); }

async function b2cStartPack(){ await startPack(); }
async function b2cEndPack(){ await endPack(); }
async function b2cJoinPack(){ await openScannerLabor("join", "B2C", "PACK"); }
async function b2cLeavePack(){ await openScannerLabor("leave", "B2C", "PACK"); }

async function b2cStartBulkOut(){ await startBulkOut(); }
async function b2cEndBulkOut(){ await endBulkOut(); }
async function b2cScanBulkOutOrder(){ await openScannerBulkOutOrder(); }
async function b2cJoinBulkOut(){ await openScannerLabor("join", "B2C", "批量出库"); }
async function b2cLeaveBulkOut(){ await openScannerLabor("leave", "B2C", "批量出库"); }

async function b2cStartReturn(){ await startReturn(); }
async function b2cEndReturn(){ await endReturn(); }
async function b2cJoinReturn(){ await openScannerLabor("join", "B2C", "退件入库"); }
async function b2cLeaveReturn(){ await openScannerLabor("leave", "B2C", "退件入库"); }

async function b2cStartQc(){ await startQc(); }
async function b2cEndQc(){ await endQc(); }
async function b2cJoinQc(){ await openScannerLabor("join", "B2C", "质检"); }
async function b2cLeaveQc(){ await openScannerLabor("leave", "B2C", "质检"); }

async function b2cStartDisposal(){ await startDisposal(); }
async function b2cEndDisposal(){ await endDisposal(); }
async function b2cJoinDisposal(){ await openScannerLabor("join", "B2C", "废弃处理"); }
async function b2cLeaveDisposal(){ await openScannerLabor("leave", "B2C", "废弃处理"); }

/** ===== Session QR UI actions ===== */
async function b2cJoinSession(){ await joinExistingSessionByScan(); }
function b2cShowSessionQr(){ showSessionQr(); }

/** ===== Misc ===== */
function hardResetLocal(){
  if(!confirm("确认清空本机所有本地缓存？（不会影响服务器）")) return;
  localStorage.clear();
  location.reload();
}

/** ===== init ===== */
refreshNet();
refreshUI();
refreshDaUI();
restoreState();
renderActiveLists();
renderInboundCountUI();
renderBulkOutUI();
renderPages();
flushQueue_();

/* === EOF: app.js === */
