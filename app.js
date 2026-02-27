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
  "active_now","report"
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
  if(cur==="report"){ if(REPORT_CACHE && REPORT_CACHE.rows) renderReport_(); }

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
// ===== Speed test / Perf =====
var PERF_ON = true; // ✅ 需要测速就 true，不要就 false
function perfLog_(msg){
  try{ console.log("[PERF]", msg); }catch(e){}
}

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
var SESSION_INFO_TTL_MS = 30000;

async function sessionInfoServer_(sid){
  var session = String(sid || currentSessionId || "").trim();
  if(!session) throw new Error("missing session");

  var now = Date.now();
  if(SESSION_INFO_CACHE.sid === session && (now - SESSION_INFO_CACHE.ts) < SESSION_INFO_TTL_MS && SESSION_INFO_CACHE.data){
    return SESSION_INFO_CACHE.data;
  }

  var res = await jsonpQ(LOCK_URL, { action: "session_info", session: session });
  if(!res || res.ok !== true) throw new Error((res && res.error) ? res.error : "session_info_failed");

  SESSION_INFO_CACHE = { sid: session, ts: now, data: res };
  return res;
}

async function isSessionClosedAsync_(){
  if(!currentSessionId) return false;
  try{
    var info = await sessionInfoServer_(currentSessionId);
    var st = String(info.status || "").trim().toUpperCase();
    return st === "CLOSED";
  }catch(e){
    // 查询失败时不强行阻断，避免现场卡死；但会少一层保护
    return false;
  }
}

async function guardSessionOpenOrAlert_(msgWhenClosed){
  if(!currentSessionId) return true;
  var closed = await isSessionClosedAsync_();
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
// ===== Anti double-click / Net busy guard =====
var NET_BUSY = false;

function netBusyOn_(action){
  NET_BUSY = true;
  // 给用户一个明确提示，避免疯狂连点
  if(action){
    setStatus("请求中... " + action + "（请勿重复点击）⏳", true);
  }
}

function netBusyOff_(){
  NET_BUSY = false;
}
function refreshUI(){
  var dev = document.getElementById("device");
  var ses = document.getElementById("session");
  if(dev) dev.textContent = makeDeviceId();
  if(ses) ses.textContent = currentSessionId || "无 / 없음";
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

/** ===== JSONP (with PERF) ===== */
function jsonp(url, params){
  return new Promise(function(resolve, reject){
    // ✅ 如果上一个请求还没结束，直接拒绝，防止连点堆积导致越来越卡
var action = (params && params.action) ? String(params.action) : "";
if(NET_BUSY){
  reject(new Error("busy: previous request not finished"));
  return;
}
    // ✅ 网络请求排队：避免 NET_BUSY 直接失败
var NET_QUEUE = Promise.resolve();
function jsonpQ(url, params){
  NET_QUEUE = NET_QUEUE.then(function(){
    return jsonp(url, params);
  });
  return NET_QUEUE;
}
netBusyOn_(action);
    var cb = "cb_" + Math.random().toString(16).slice(2);
    var qs = [];
    for(var k in params){
      if(!params.hasOwnProperty(k)) continue;
      qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    qs.push("callback=" + encodeURIComponent(cb));
    var src = url + "?" + qs.join("&");

    // PERF
    var t0 = Date.now();
    var action = (params && params.action) ? String(params.action) : "";
    if(PERF_ON && action){
      setStatus("请求中... " + action + " ⏳", true);
    }

    var script = document.createElement("script");
    var timer = setTimeout(function(){
      cleanup();
      var dt = Date.now() - t0;
      if(PERF_ON && action){
        setStatus("超时 ❌ " + action + " " + dt + "ms", false);
        perfLog_("TIMEOUT action=" + action + " dt=" + dt + "ms src=" + src);
      }
      reject(new Error("jsonp timeout"));
    }, 12000);

    function cleanup(){
      try{ delete window[cb]; }catch(e){ window[cb]=undefined; }
      if(script && script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
      // ✅ 释放网络忙状态
      netBusyOff_();
    }

    window[cb] = function(data){
      cleanup();
      var dt = Date.now() - t0;
      var ok = data && data.ok === true;

      if(PERF_ON && action){
        setStatus((ok ? "完成 ✅ " : "失败 ❌ ") + action + " " + dt + "ms", ok);
        perfLog_((ok ? "OK" : "BAD") + " action=" + action + " dt=" + dt + "ms");
      }
      resolve(data);
    };

    script.onerror = function(){
      cleanup();
      var dt = Date.now() - t0;
      if(PERF_ON && action){
        setStatus("错误 ❌ " + action + " " + dt + "ms", false);
        perfLog_("ERROR action=" + action + " dt=" + dt + "ms src=" + src);
      }
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

setInterval(function(){ flushQueue_(); }, 5000);
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

  var res = await jsonpQ(LOCK_URL, params);

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
  var res = await jsonpQ(LOCK_URL, {
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

function cleanupLocalSession_(){
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

  currentSessionId = null;
  localStorage.removeItem("pick_session_id");
  refreshUI();
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
    var res = await jsonpQ(LOCK_URL, { action:"active_now" });

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

    setStatus("在岗��更新 ✅", true);
  }catch(e){
    setStatus("在岗拉取异常 ❌ " + e, false);
    alert("在岗拉取异常：" + e);
  }
}

/** ===== Start / End: B2C tasks ===== */
async function startTally(){
  try{
    if(currentSessionId){
      // 若 session 已关闭，提示重新开始
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始理货】重新开新趟次，或扫码加入别的趟次。"))) return;

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
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始批量出库】重新开新趟次，或扫码加入别的趟次。"))) return;

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
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始拣货】重新开新趟次，或扫码加入别的趟次。"))) return;

      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    scannedWaves = new Set();
    activePick = new Set();
    persistState();

    leaderPickOk = false;
    syncLeaderPickUI();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"PICK", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"PICK", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    setStatus("拣货开始已记录（待上传）✅ 现在可立即��码加入", true);
  }catch(e){
    setStatus("拣货开始失败 ❌ " + e, false);
  }
}

function setRelabelTimerText(text){
  var el = document.getElementById("relabelTimer");
  if(el) el.textContent = text;
}
function startRelabelTimer(){
  if(relabelTimerHandle) clearInterval(relabelTimerHandle);
  relabelTimerHandle = setInterval(function(){
    if(!relabelStartTs) return;
    var sec = Math.floor((Date.now() - relabelStartTs)/1000);
    var mm = String(Math.floor(sec/60)).padStart(2,'0');
    var ss = String(sec%60).padStart(2,'0');
    setRelabelTimerText("进行中: " + mm + ":" + ss);
  }, 1000);
}

async function startRelabel(){
  try{
    if(currentSessionId){
      if(!(await guardSessionOpenOrAlert_("检测到本机 session 已结束，请点【开始换单】重新开新趟次，或扫码加入别的趟次。"))) return;

      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    activeRelabel = new Set();
    persistState();

    relabelStartTs = Date.now();
    setRelabelTimerText("进行中: 00:00");
    startRelabelTimer();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"RELABEL", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"RELABEL", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    setStatus("换单开始已记录（待上传）✅", true);
  }catch(e){
    setStatus("换单开始失败 ❌ " + e, false);
  }
}
async function endRelabel(){ return endSessionGlobal_(); }

/** ===== PICK end (leader confirmation) ===== */
async function endPicking(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次", false); return; }
    if(!(await guardSessionOpenOrAlert_("该趟次已结束（无法结束拣货），请重新开始新的趟次。"))) return;

    if(!leaderPickOk){ setStatus("需要组长先登录（扫码）", false); return; }
    if(activePick.size > 0){
      setStatus("还有人员未退出，禁止结束", false);
      alert("还有人员未退出作业，不能结束拣货。");
      return;
    }

    pendingLeaderEnd = { biz:"B2C", task:"PICK" };
    scanMode = "leaderEndPick";
    document.getElementById("scanTitle").textContent = "扫码组长工牌确认结束 / 팀장 종료 확인";
    await openScannerCommon();
  }catch(e){
    setStatus("结束确认失败 ❌ " + e, false);
  }
}

async function openScannerWave(){
  if(!currentSessionId){ setStatus("请先开始拣货 / 먼저 시작", false); return; }
  if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再扫码波次，请重新开始。"))) return;

  scanMode = "wave";
  document.getElementById("scanTitle").textContent = "扫码波次 / 웨이브 스캔";
  await openScannerCommon();
}

async function leaderLoginPick(){
  if(!currentSessionId){ setStatus("请先开始拣货再组长登录 / 먼저 시작", false); return; }
  if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再组长登录，请重新开始。"))) return;

  scanMode = "leaderLoginPick";
  document.getElementById("scanTitle").textContent = "扫码组长工牌登录 / 팀장 로그인";
  await openScannerCommon();
}

async function openScannerInboundCount(){
  if(!currentSessionId){ setStatus("请先开始理货 / 먼저 시작", false); return; }
  if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再扫码入库单，请重新开始。"))) return;

  scanMode = "inbound_count";
  document.getElementById("scanTitle").textContent = "扫码入库单号（计数/去重）";
  await openScannerCommon();
}

async function openScannerBulkOutOrder(){
  if(!currentSessionId){ setStatus("请先开始批量出库 / 먼저 시작", false); return; }
  if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再扫码出库单，请重新开始。"))) return;

  scanMode = "bulkout_order";
  document.getElementById("scanTitle").textContent = "扫码出库单号（计数/去重）";
  await openScannerCommon();
}

/** ===== Labor (join/leave) ===== */
async function joinWork(biz, task){
  if(!currentSessionId){
    if(taskAutoSession_(task)){
      currentSessionId = makePickSessionId();
      localStorage.setItem("pick_session_id", currentSessionId);
      persistState();
      refreshUI();

      try{
        var evIdStart = makeEventId({ event:"start", biz:biz, task: task, wave_id:"", badgeRaw:"" });
        if(!hasRecent(evIdStart)){
          submitEvent({ event:"start", event_id: evIdStart, biz: biz, task: task, pick_session_id: currentSessionId });
          addRecent(evIdStart);
        }
      }catch(e){}
    }else{
      setStatus("请先加入趟次（扫码）或先点开始 / 세션 참여 필요", false);
      alert("请先在 B2C 菜单点【加入已有趟次（扫码）】\n或在本作业页点【开始】创建新趟次。");
      return;
    }
  } else {
    if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再加入作业，请重新开始或加入新趟次。"))) return;
  }

  laborAction = "join"; laborBiz = biz; laborTask = task;
  scanMode = "labor";
  document.getElementById("scanTitle").textContent = "扫码工牌（加入）";
  await openScannerCommon();
}

async function leaveWork(biz, task){
  if(!currentSessionId){
    setStatus("请先加入趟次（扫码）或先点开始", false);
    alert("当前没有进行中的趟次。\n请先加入趟次或开始作业。");
    return;
  }
  if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能再退出作业，请重新开始或加入新趟次。"))) return;

  if(task === "PICK" && activePick.size === 0){ alert("当前没有人在拣货作业中（无需退出）。"); return; }
  if(task === "RELABEL" && activeRelabel.size === 0){ alert("当前没有人在换单作业中（无需退出）。"); return; }
  if(task === "PACK" && activePack.size === 0){ alert("当前没有人在验货贴单打包作业中（无需退出）。"); return; }
  if(task === "TALLY" && activeTally.size === 0){ alert("当前没有人在理货作业中（无需退出）。"); return; }
  if(task === "批量出库" && activeBulkOut.size === 0){ alert("当前没有人在批量出库作业中（无需退出）。"); return; }
  if(task === "退件入库" && activeReturn.size === 0){ alert("当前没有人在退件入库作业中（无需退出）。"); return; }
  if(task === "质检" && activeQc.size === 0){ alert("当前没有人在质检作业中（无需退出）。"); return; }
  if(task === "废弃处理" && activeDisposal.size === 0){ alert("当前没有人在废弃处理作业中（无需退出）。"); return; }

  laborAction = "leave"; laborBiz = biz; laborTask = task;
  scanMode = "labor";
  document.getElementById("scanTitle").textContent = "扫码工牌（退出）";
  await openScannerCommon();
}

/** ===== Badge / Employee / Bind ===== */
function setDaStatus(msg, ok){
  if(ok===undefined) ok=true;
  var el = document.getElementById("daStatus");
  if(!el) return;
  el.className = ok ? "ok" : "bad";
  el.textContent = msg;
}
function refreshDaUI(){
  var el = document.getElementById("daText");
  if(el) el.textContent = currentDaId || "无";
}
function makeDaId(){
  var d = new Date();
  var yyyy = d.getFullYear();
  var mm = String(d.getMonth()+1).padStart(2,'0');
  var dd = String(d.getDate()).padStart(2,'0');
  var key = "da_seq_" + yyyy + mm + dd;
  var seq = parseInt(localStorage.getItem(key) || "0", 10) + 1;
  localStorage.setItem(key, String(seq));
  return "DA-" + yyyy + mm + dd + "-" + String(seq).padStart(2,'0');
}

async function dailyCheckin(){
  try{
    var da = makeDaId();
    currentDaId = da;
    localStorage.setItem("da_id", currentDaId);

    var evId = makeEventId({ event:"daily_checkin", biz:"DAILY", task:"BADGE", wave_id:"", badgeRaw:da });
    if(!hasRecent(evId)){
      submitEvent({ event:"daily_checkin", event_id: evId, biz:"DAILY", task:"BADGE", pick_session_id:"NA", da_id: da });
      addRecent(evId);
    }

    refreshDaUI();
    alert("日当工牌已生成 ✅ " + da);
    setDaStatus("已记录（待上传）✅", true);

    var listEl = document.getElementById("badgeList");
    if(listEl){
      var box = document.createElement("div");
      box.style.border = "1px solid #ddd";
      box.style.borderRadius = "12px";
      box.style.padding = "10px";
      box.innerHTML = '<div style="font-weight:700;margin-bottom:6px;">'+da+'</div><div id="qr_'+da+'"></div>';
      listEl.prepend(box);
      new QRCode(document.getElementById("qr_"+da), { text: da, width: 160, height: 160 });
    }
  }catch(e){
    setDaStatus("失败 ❌ " + e, false);
  }
}

async function bulkDailyCheckin(){
  try{
    var n = parseInt((document.getElementById("daCount")||{}).value || "0", 10);
    if(!n || n < 1) return alert("请输入人数 N（>=1）");
    var listEl = document.getElementById("badgeList");
    if(!listEl) return;

    listEl.innerHTML = "";
    setDaStatus("生成中...", true);

    for(var i=0;i<n;i++){
      var da = makeDaId();
      var evId = makeEventId({ event:"daily_checkin", biz:"DAILY", task:"BADGE", wave_id:"", badgeRaw:da });

      if(!hasRecent(evId)){
        submitEvent({ event:"daily_checkin", event_id: evId, biz:"DAILY", task:"BADGE", pick_session_id:"NA", da_id: da });
        addRecent(evId);
      }

      var box = document.createElement("div");
      box.style.border = "1px solid #ddd";
      box.style.borderRadius = "12px";
      box.style.padding = "10px";
      box.innerHTML = '<div style="font-weight:700;margin-bottom:6px;">'+da+'</div><div id="qr_'+da+'"></div>';
      listEl.appendChild(box);
      new QRCode(document.getElementById("qr_"+da), { text: da, width: 160, height: 160 });

      currentDaId = da;
      localStorage.setItem("da_id", currentDaId);
    }
    refreshDaUI();
    setDaStatus("批量生成完成（待上传）✅ 共 "+n+" 个", true);
  }catch(e){
    setDaStatus("批量生成失败 ❌ " + e, false);
  }
}

function padNum(n, width){
  var s = String(n);
  return s.length>=width ? s : ("0".repeat(width-s.length)+s);
}
function normalizeNames(text){
  return (text||"").split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
}

function generatePermanentDaBadges(){
  var ta = document.getElementById("daPermanentNames");
  if(!ta){ alert("找不到 daPermanentNames"); return; }
  var names = normalizeNames(ta.value);
  if(names.length===0){ alert("请先输入长期日当姓名（每行一个）"); return; }

  var start = parseInt((document.getElementById("daPermanentStart")||{}).value || "1", 10);
  var pad = parseInt((document.getElementById("daPermanentPad")||{}).value || "3", 10);

  var listEl = document.getElementById("daPermanentList");
  if(!listEl){ alert("找不到 daPermanentList"); return; }
  listEl.innerHTML = "";

  names.forEach(function(name, idx){
    var num = start + idx;
    var id = "DAF-" + padNum(num, pad);
    var payload = id + "|" + name;

    var box = document.createElement("div");
    box.style.border = "1px solid #ddd";
    box.style.borderRadius = "12px";
    box.style.padding = "10px";
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px;">'+payload+'</div><div id="pdaq_'+id+'_'+idx+'"></div>';
    listEl.appendChild(box);
    new QRCode(document.getElementById("pdaq_"+id+"_"+idx), { text: payload, width: 160, height: 160 });
  });

  alert("已生成长期日当工牌 ✅ 共 " + names.length + " 个\n建议截图/打印发放（以后每天都用这一张）。");
}

async function bindBadgeToSession(){
  try{
    if(!currentSessionId){ setDaStatus("请先开始某个作业再绑定 / 먼저 시작", false); return; }
    if(!(await guardSessionOpenOrAlert_("该趟次已结束：不能绑定工牌，请重新开始。"))) return;

    scanMode = "badgeBind";
    document.getElementById("scanTitle").textContent = "扫码工牌（绑定） / 명찰 연결";
    await openScannerCommon();
  }catch(e){
    setDaStatus("绑定失败 ❌ " + e, false);
  }
}

function generateEmployeeBadges(){
  var ta = document.getElementById("empNames");
  if(!ta){ alert("找不到 empNames"); return; }
  var names = normalizeNames(ta.value);
  if(names.length===0){ alert("请先输入员工名字（每行一个）"); return; }

  var start = parseInt((document.getElementById("empStart")||{}).value || "1", 10);
  var pad = parseInt((document.getElementById("empPad")||{}).value || "3", 10);

  var listEl = document.getElementById("empBadgeList");
  if(!listEl){ alert("找不到 empBadgeList"); return; }
  listEl.innerHTML = "";

  names.forEach(function(name, idx){
    var num = start + idx;
    var empId = "EMP-" + padNum(num, pad);
    var payload = empId + "|" + name;

    var box = document.createElement("div");
    box.style.border = "1px solid #ddd";
    box.style.borderRadius = "12px";
    box.style.padding = "10px";
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px;">'+payload+'</div><div id="empqr_'+empId+'_'+idx+'"></div>';
    listEl.appendChild(box);
    new QRCode(document.getElementById("empqr_"+empId+"_"+idx), { text: payload, width: 160, height: 160 });
  });

  alert("已生成员工工牌 ✅ 共 "+names.length+" 个\n建议截图/打印此页面发放。");
}

/** ===== Leader UI ===== */
function syncLeaderPickUI(){
  var info = document.getElementById("leaderInfoPick");
  var btnEnd = document.getElementById("btnEndPick");
  if(!info || !btnEnd) return;

  if(leaderPickOk && leaderPickBadge){
    info.textContent = "组长已登录 ✅ " + leaderPickBadge;
    btnEnd.style.display = "block";
  }else{
    info.textContent = leaderPickBadge ? ("组长未确认（本趟需登录）: " + leaderPickBadge) : "组长未登录 / 팀장 미 로그인";
    btnEnd.style.display = "none";
  }
}

/** ===== Scanner overlay ===== */
function showOverlay(){ var el=document.getElementById("scannerOverlay"); if(el) el.classList.add("show"); }
function hideOverlay(){ var el=document.getElementById("scannerOverlay"); if(el) el.classList.remove("show"); }
async function pauseScanner(){ try{ if(scanner) await scanner.pause(true); }catch(e){} }

async function openScannerCommon(){
  showOverlay();
  document.getElementById("reader").innerHTML = "";

  try{ if(scanner){ await scanner.stop(); await scanner.clear(); } }catch(e){}
  scanner = new Html5Qrcode("reader");

  var onScan = async (decodedText) => {
    var code = decodedText.trim();
    if(scanBusy) return;

    var now = Date.now();
    if(now - lastScanAt < 900) return;
    lastScanAt = now;

    if(scanMode === "session_join"){
      var sid = parseSessionQr_(code);
      if(!sid){ setStatus("不是趟次二维码（CKSESSION|...）", false); return; }

      scanBusy = true;
      await pauseScanner();
      try{
        currentSessionId = sid;
        localStorage.setItem("pick_session_id", currentSessionId);

        // 切换 session，清空 session_info 缓存，避免误判
        SESSION_INFO_CACHE = { sid: null, ts: 0, data: null };

        restoreState();
        renderActiveLists();
        refreshUI();

        // ✅ 加入后先别立刻问服务器（session_info 很慢，会卡住扫码体验）
        //    后续在做 join/leave/start 等操作时再做 guard（你本来就有 guardSessionOpenOrAlert_）
        alert("已加入趟次 ✅\n" + currentSessionId);
        setStatus("已加入趟次 ✅ " + currentSessionId + "（后台慢，已跳过立即校验）", true);

        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "inbound_count"){
      var code2 = decodedText.trim();
      if(!code2){ setStatus("入库单号为空", false); return; }

      scanBusy = true;
      await pauseScanner();
      try{
        if(scannedInbounds.has(code2)){
          setStatus("已记录（去重）✅ " + code2, true);
          alert("已记录（去重）✅\n" + code2);
          renderInboundCountUI();
          await closeScanner();
          return;
        }

        scannedInbounds.add(code2);
        persistState();
        renderInboundCountUI();

        var evIdX = makeEventId({ event:"scan", biz:"B2C", task:"TALLY", wave_id: code2, badgeRaw:"" });
        if(!hasRecent(evIdX)){
          submitEvent({ event:"scan", event_id: evIdX, biz:"B2C", task:"TALLY", pick_session_id: currentSessionId, wave_id: code2 });
          addRecent(evIdX);
        }

        setStatus("已记录入库单（待上传）✅ " + code2, true);
        alert("已记录入库单 ✅\n" + code2 + "\n当前累计：" + scannedInbounds.size);
        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "bulkout_order"){
      var code3 = decodedText.trim();
      if(!code3){ setStatus("出库单号为空", false); return; }

      scanBusy = true;
      await pauseScanner();
      try{
        if(scannedBulkOutOrders.has(code3)){
          setStatus("已记录（去重）✅ " + code3, true);
          alert("已记录（去重）✅\n" + code3);
          renderBulkOutUI();
          await closeScanner();
          return;
        }

        scannedBulkOutOrders.add(code3);
        persistState();
        renderBulkOutUI();

        var evIdB = makeEventId({ event:"scan", biz:"B2C", task:"批量出库", wave_id: code3, badgeRaw:"" });
        if(!hasRecent(evIdB)){
          submitEvent({ event:"scan", event_id: evIdB, biz:"B2C", task:"批量出库", pick_session_id: currentSessionId, wave_id: code3 });
          addRecent(evIdB);
        }

        setStatus("已记录出库单（待上传）✅ " + code3, true);
        alert("已记录出库单 ✅\n" + code3 + "\n当前累计：" + scannedBulkOutOrders.size);
        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "wave"){
      var ok = /^\d{4}-\d{4}-\d+$/.test(code);
      if(!ok){ setStatus("波次格式不对（例：2026-0224-6）", false); return; }
      if(scannedWaves.has(code)){ setStatus("重复波次已忽略 ⏭️ " + code, false); return; }

      scannedWaves.add(code);
      persistState();

      scanBusy = true;
      await pauseScanner();
      try{
        var evId = makeEventId({ event:"wave", biz:"B2C", task:"PICK", wave_id: code, badgeRaw:"" });
        if(hasRecent(evId)){ setStatus("重复扫码已忽略 ⏭️ " + code, false); await closeScanner(); return; }

        submitEvent({ event:"wave", event_id: evId, biz:"B2C", task:"PICK", pick_session_id: currentSessionId, wave_id: code });
        addRecent(evId);

        alert("已记录波次 ✅ " + code);
        setStatus("已记录波次（待上传）✅ " + code, true);
        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "badgeBind"){
      if(!isOperatorBadge(code)){ setDaStatus("无效工牌（DA-... / DAF-...|名字 / EMP-...|名字）", false); return; }
      var p = parseBadge(code);

      scanBusy = true;
      await pauseScanner();
      try{
        var evId2 = makeEventId({ event:"bind_daily", biz:"DAILY", task:"BADGE", wave_id:"", badgeRaw:p.raw });
        if(hasRecent(evId2)){ setDaStatus("重复扫码已忽略 ⏭️", false); await closeScanner(); return; }

        submitEvent({ event:"bind_daily", event_id: evId2, biz:"DAILY", task:"BADGE", pick_session_id: currentSessionId, da_id: p.raw });
        addRecent(evId2);

        currentDaId = p.raw; localStorage.setItem("da_id", currentDaId); refreshDaUI();
        alert("已绑定工牌 ✅ " + p.raw);
        setDaStatus("绑定成功（待上传）✅", true);
        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "labor"){
      if(!isOperatorBadge(code)){ setStatus("无效工牌（DA-... / DAF-...|名字 / EMP-...|名字）", false); return; }
      var p2 = parseBadge(code);

      if(laborAction === "leave" && !isAlreadyActive(laborTask, p2.raw)){
        alert("该工牌不在当前作业名单中，无法退出。\n请确认是否扫错工牌。");
        setStatus("不在岗，无法退出 ❌", false);
        await closeScanner();
        return;
      }

      if(laborAction === "join" && isAlreadyActive(laborTask, p2.raw)){
        alert("已在作业中 ✅ " + p2.raw);
        setStatus("已在作业中 ✅", true);
        await closeScanner();
        return;
      }

      scanBusy = true;
      await pauseScanner();
      setStatus("处理中... 请稍等 ⏳（join/leave 需确认锁）", true);

      try{
        var evId = makeEventId({ event:laborAction, biz:laborBiz, task:laborTask, wave_id:"", badgeRaw:p2.raw });
        if(hasRecent(evId)){ setStatus("重复扫描已忽略 ⏭️", false); await closeScanner(); return; }

        await submitEventSync_({
          event: laborAction,
          event_id: evId,
          biz: laborBiz,
          task: laborTask,
          pick_session_id: currentSessionId,
          da_id: p2.raw
        });

        addRecent(evId);

        applyActive(laborTask, laborAction, p2.raw);
        renderActiveLists();
        persistState();

        if(laborAction === "leave"){
          await tryAutoEndSessionAfterLeave_();
        }

        alert((laborAction === "join" ? "已加入 ✅ " : "已退出 ✅ ") + p2.raw);
        setStatus((laborAction === "join" ? "加入成功 ✅ " : "退出成功 ✅ ") + p2.raw, true);
        await closeScanner();
      } catch(e){
        setStatus("提交失败 ❌ " + e, false);
        alert("提交失败，请重试。\n" + e);
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "leaderLoginPick"){
      if(!isOperatorBadge(code)){ setStatus("无效工牌（请扫 EMP-xxx|名字）", false); return; }
      var p3 = parseBadge(code);
      if(!p3.id.startsWith("EMP-")){ setStatus("请扫组长员工工牌（EMP-xxx|名字）", false); return; }

      scanBusy = true;
      await pauseScanner();
      try{
        leaderPickBadge = p3.raw; localStorage.setItem("leader_pick_badge", leaderPickBadge);
        leaderPickOk = true; syncLeaderPickUI();
        alert("组长登录成功 ✅ " + p3.raw);
        setStatus("组长登录成功 ✅", true);
        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "leaderEndPick"){
      if(!isOperatorBadge(code)){ setStatus("无效工牌（请扫 EMP-xxx|名字）", false); return; }
      var p4 = parseBadge(code);
      if(!p4.id.startsWith("EMP-")){ setStatus("请扫组长员工工牌（EMP-xxx|名字）", false); return; }

      scanBusy = true;
      await pauseScanner();
      try{
        leaderPickBadge = p4.raw; localStorage.setItem("leader_pick_badge", leaderPickBadge);
        await endSessionGlobal_();
        pendingLeaderEnd = null;
        leaderPickOk = false;
        refreshUI(); syncLeaderPickUI();
        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }
  };

  try{
    await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 240, height: 240 } }, onScan);
  }catch(e){
    var cams = await Html5Qrcode.getCameras();
    var camId = cams && cams[0] ? cams[0].id : null;
    await scanner.start(camId, { fps:10, qrbox:{width:240,height:240}}, onScan);
  }
}

async function closeScanner(){
  try{
    if(scanner){ await scanner.stop(); await scanner.clear(); scanner = null; }
  }catch(e){}
  hideOverlay();
}

function comingSoon(msg){
  alert((msg||"准备中") + "\n\n我们会逐步上线。");
}

/** ===== REPORT: 工时/劳效（本地计算） ===== */
var REPORT_CACHE = { header: null, rows: null, kstDay: null };

function kstDayKey_(ms){
  var x = new Date((Number(ms)||0) + 9*3600*1000); // KST
  return x.toISOString().slice(0,10); // YYYY-MM-DD
}

function rowsToObjects_(header, rows){
  return rows.map(function(r){
    var o = {};
    for(var i=0;i<header.length;i++) o[header[i]] = r[i];
    return o;
  });
}

async function reportLoadToday(){
  // KST 今天 00:00 的 server_ms 起点
  var now = Date.now();
  var todayKey = kstDayKey_(now);
  var startMs = Date.parse(todayKey + "T00:00:00.000Z") - 9*3600*1000;

  setStatus("拉取今日事件中... ⏳", true);

  var res = await jsonpQ(LOCK_URL, {
    action:"events_tail",
    limit: 20000,
    since_ms: String(startMs)
  });

  if(!res || res.ok !== true){
    setStatus("拉取失败 ❌ " + (res && res.error ? res.error : "unknown"), false);
    alert("拉取失败: " + (res && res.error ? res.error : "unknown"));
    return;
  }

  REPORT_CACHE = { header: res.header, rows: res.rows, kstDay: todayKey };
  renderReport_();
  setStatus("拉取完成 ✅", true);
}

function calcWorkMinutes_(events){
  // 只算 join/leave
  events.sort(function(a,b){ return (a.server_ms||0) - (b.server_ms||0); });

  var open = {};      // key -> join_ms
  var sum = {};       // badge -> { biz/task -> ms }
  var scanCount = {}; // badge -> { biz/task -> count }

  events.forEach(function(e){
    var ok = String(e.ok||"").toLowerCase();
    if(ok === "false") return;

    var ev = String(e.event||"").trim();
    var badge = String(e.badge||"").trim();
    var biz = String(e.biz||"").trim();
    var task = String(e.task||"").trim();
    var session = String(e.session||"").trim();
    var t = Number(e.server_ms||0) || 0;

    if(!badge || !biz || !task) return;

    var taskKey = biz + "/" + task;
    var k = badge + "|" + biz + "|" + task + "|" + session;

    if(ev === "join"){
      if(!open[k]) open[k] = t;
      return;
    }
    if(ev === "leave"){
      if(open[k]){
        var dt = Math.max(0, t - open[k]);
        delete open[k];

        if(!sum[badge]) sum[badge] = {};
        sum[badge][taskKey] = (sum[badge][taskKey]||0) + dt;
      }
      return;
    }

    if(ev === "scan"){
      if(!scanCount[badge]) scanCount[badge] = {};
      scanCount[badge][taskKey] = (scanCount[badge][taskKey]||0) + 1;
    }
  });

  return { sum: sum, scanCount: scanCount };
}

function renderReport_(){
  var meta = document.getElementById("reportMeta");
  var table = document.getElementById("reportTable");
  if(!meta || !table) return;

  var header = REPORT_CACHE.header || [];
  var rows = REPORT_CACHE.rows || [];
  var objs = rowsToObjects_(header, rows);

  var day = REPORT_CACHE.kstDay || kstDayKey_(Date.now());
  var todayEvents = objs.filter(function(e){
    return kstDayKey_(e.server_ms) === day;
  });

  var r = calcWorkMinutes_(todayEvents);

  meta.textContent = "KST日期: " + day + " ｜ 事件数: " + todayEvents.length;

  var badges = Object.keys(r.sum).sort();
  if(badges.length === 0){
    table.innerHTML = '<div class="muted">今天暂无 join/leave 数据</div>';
    return;
  }

  var html = "";
  badges.forEach(function(b){
    html += '<div style="border:1px solid #eee;border-radius:12px;padding:10px;margin:8px 0;">';
    html += '<div style="font-weight:800;">' + esc(b) + '</div>';

    var tasks = r.sum[b];
    var keys = Object.keys(tasks).sort();
    keys.forEach(function(k){
      var mins = Math.round(tasks[k] / 60000);
      var cnt = (r.scanCount[b] && r.scanCount[b][k]) ? r.scanCount[b][k] : 0;
      html += '<div class="muted" style="margin-top:4px;">' + esc(k) + " ：" + mins + " 分钟" + (cnt? (" ｜ 扫码数: "+cnt):"") + '</div>';
    });

    html += "</div>";
  });

  table.innerHTML = html;
}

function reportExportCSV(){
  var header = REPORT_CACHE.header || [];
  var rows = REPORT_CACHE.rows || [];
  if(rows.length === 0){
    alert("没有数据可导出（先点：拉取今天数据）");
    return;
  }

  var csv = [];
  csv.push(header.join(","));
  rows.forEach(function(r){
    csv.push(r.map(function(x){
      var s = String(x==null?"":x).replace(/"/g,'""');
      return '"' + s + '"';
    }).join(","));
  });

  var blob = new Blob([csv.join("\n")], {type:"text/csv;charset=utf-8;"});
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ck_events_" + (REPORT_CACHE.kstDay || "day") + ".csv";
  a.click();
}

/** ===== init ===== */
refreshNet();
refreshUI();
restoreState();
renderActiveLists();
renderPages();
flushQueue_();
