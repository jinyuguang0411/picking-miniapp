// app.js - 业务逻辑（路由/状态/扫码/提交/跨设备锁/防重复/全局在岗看板）
// ✅ 工牌：日当(每日) + 日当(长期带名字) + 员工工牌 + 绑定
// ✅ 作业：PICK / RELABEL / PACK / TALLY / 退件入库
// ✅ TALLY：入库理货（入库单号扫码去重计数，不记单号时长）
// ✅ 跨设备锁：同一工牌不能被多设备重复 join
// ✅ 防卡重复：scanBusy + 本地去重(event_id) + leave 必须在岗 + 扫码成功先 pause 摄像头
// ✅ 防脏数据：leave 先写表再 release lock；session closed 禁止 join/leave
// ✅ PACK 自动建 session 时补 start 事件
// ✅ 总控台 global_menu + 全局在岗 active_now（从 LOCK_URL?action=active_now 拉取）
// ✅ 性能：start/wave/end 等非互斥事件走队列秒响应；join/leave 同步确认锁

/** ===== Form (legacy, kept for compatibility) ===== */
var FORM_URL = "https://docs.google.com/forms/u/0/d/e/1FAIpQLSer3mWq6A6OivAJKba5JE--CwlKnU6Teru586HCOZVoJo6qQg/formResponse";
var ENTRY_EVENT   = "entry.806252256";
var ENTRY_DEVICE  = "entry.1221756343";
var ENTRY_SESSION = "entry.139498995";
var ENTRY_WAVE    = "entry.2002106420";
var ENTRY_TS      = "entry.179441545";
var ENTRY_DA      = "entry.1739228641";
var ENTRY_BIZ     = "entry.1934762358";
var ENTRY_TASK    = "entry.53174481";

/** ===== Lock Service (Apps Script WebApp, JSONP) ===== */
var LOCK_URL = "https://script.google.com/macros/s/AKfycbwPXpP853p_AVgTAfpTNThdiSd6Ho4BqpRs1vKX41NYxa3gNYJV6FULx-4Wmsf0uNw/exec";
var LOCK_TTL_MS = 8 * 60 * 60 * 1000;

/** ===== Router ===== */
var pages = ["home","badge","global_menu","b2c_menu","b2c_tally","b2c_return","b2c_pick","b2c_relabel","b2c_pack","active_now"];

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

  // 页面进入时刷新
  if(cur==="badge"){ refreshUI(); refreshDaUI(); }
  if(cur==="b2c_tally"){ restoreState(); renderActiveLists(); renderInboundCountUI(); refreshUI(); }
  if(cur==="b2c_return"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_pick"){ syncLeaderPickUI(); restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_relabel"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_pack"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="active_now"){ refreshActiveNow(); }
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
var scannedInbounds = new Set(); // ✅ TALLY：入库单号去重集合

var lastScanAt = 0;
var scanBusy = false;

var currentDaId = localStorage.getItem("da_id") || null;

var laborAction = null;
var laborBiz = null;
var laborTask = null;

var activePick = new Set();
var activeRelabel = new Set();
var activePack = new Set();
var activeTally = new Set(); // ✅ TALLY：在岗
var activeReturn = new Set(); // ✅ NEW：退件入库

var relabelTimerHandle = null;
var relabelStartTs = null;

var leaderPickBadge = localStorage.getItem("leader_pick_badge") || null;
var leaderPickOk = false;
var pendingLeaderEnd = null;

/** ===== Persist / Restore ===== */
function keyWaves(){ return "waves_" + (currentSessionId || "NA"); }
function keyActivePick(){ return "activePick_" + (currentSessionId || "NA"); }
function keyActiveRelabel(){ return "activeRelabel_" + (currentSessionId || "NA"); }
function keyActivePack(){ return "activePack_" + (currentSessionId || "NA"); }
function keyActiveTally(){ return "activeTally_" + (currentSessionId || "NA"); }
function keyActiveReturn(){ return "activeReturn_" + (currentSessionId || "NA"); } // ✅ NEW
function keyInbounds(){ return "inbounds_" + (currentSessionId || "NA"); }

/** ===== session closed ===== */
function keyClosed(){ return "session_closed_" + (currentSessionId || "NA"); }
function isSessionClosed(){
  if(!currentSessionId) return false;
  return localStorage.getItem(keyClosed()) === "1";
}
function setSessionClosed(flag){
  if(!currentSessionId) return;
  localStorage.setItem(keyClosed(), flag ? "1" : "0");
}

/** ===== local idempotency (dedupe) ===== */
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
  // params: {event, biz, task, wave_id, badgeRaw}
  // ✅ 稳定键（不带时间），用于“连扫同一张码”的本地去重
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

  // ✅ TALLY
  localStorage.setItem(keyActiveTally(), JSON.stringify(Array.from(activeTally)));
  localStorage.setItem(keyInbounds(), JSON.stringify(Array.from(scannedInbounds)));

  // ✅ NEW: RETURN
  localStorage.setItem(keyActiveReturn(), JSON.stringify(Array.from(activeReturn)));
}

function restoreState(){
  if(!currentSessionId) return;

  try{ scannedWaves = new Set(JSON.parse(localStorage.getItem(keyWaves()) || "[]")); }catch(e){ scannedWaves = new Set(); }
  try{ activePick = new Set(JSON.parse(localStorage.getItem(keyActivePick()) || "[]")); }catch(e){ activePick = new Set(); }
  try{ activeRelabel = new Set(JSON.parse(localStorage.getItem(keyActiveRelabel()) || "[]")); }catch(e){ activeRelabel = new Set(); }
  try{ activePack = new Set(JSON.parse(localStorage.getItem(keyActivePack()) || "[]")); }catch(e){ activePack = new Set(); }

  // ✅ TALLY
  try{ activeTally = new Set(JSON.parse(localStorage.getItem(keyActiveTally()) || "[]")); }catch(e){ activeTally = new Set(); }
  try{ scannedInbounds = new Set(JSON.parse(localStorage.getItem(keyInbounds()) || "[]")); }catch(e){ scannedInbounds = new Set(); }

  // ✅ NEW: RETURN
  try{ activeReturn = new Set(JSON.parse(localStorage.getItem(keyActiveReturn()) || "[]")); }catch(e){ activeReturn = new Set(); }
}

/** ===== Utils ===== */
function nowTs(){ return String(Date.now()); }

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
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-200))); // keep last 200
}
function enqueueEvent_(payload){
  var q = loadQueue_();
  q.push({ payload: payload, tries: 0, enq_ms: Date.now() });
  saveQueue_(q);
}

// flush one by one to avoid overloading GAS
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
        await submitEventSync_(item.payload, /*silent*/ true);
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
    client_ms: (o.client_ms || (o.ts ? parseInt(String(o.ts).split("|")[0], 10) : 0) || Date.now())
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

/** ===== Submit event (FAST UX) =====
 * - For NON-locking events: enqueue + return immediately
 * - For join/leave: callers must use submitEventSync_
 */
async function submitEvent(o){
  enqueueEvent_(o);
  flushQueue_(); // best-effort
  return { ok:true, queued:true };
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
function isPermanentDaId(id){ return /^DAF-\d+$/.test(id); } // 长期日当：DAF-001
function isOperatorBadge(raw){
  var p = parseBadge(raw);
  return isDaId(p.id) || isEmpId(p.id) || isPermanentDaId(p.id);
}

/** ===== Active ===== */
function isAlreadyActive(task, badge){
  if(task==="PICK") return activePick.has(badge);
  if(task==="RELABEL") return activeRelabel.has(badge);
  if(task==="PACK") return activePack.has(badge);
  if(task==="TALLY") return activeTally.has(badge);
  if(task==="退件入库") return activeReturn.has(badge); // ✅ NEW
  return false;
}

function applyActive(task, action, badge){
  if(task==="PICK"){
    if(action==="join") activePick.add(badge);
    if(action==="leave") activePick.delete(badge);
  }
  if(task==="RELABEL"){
    if(action==="join") activeRelabel.add(badge);
    if(action==="leave") activeRelabel.delete(badge);
  }
  if(task==="PACK"){
    if(action==="join") activePack.add(badge);
    if(action==="leave") activePack.delete(badge);
  }
  if(task==="TALLY"){
    if(action==="join") activeTally.add(badge);
    if(action==="leave") activeTally.delete(badge);
  }
  if(task==="退件入库"){
    if(action==="join") activeReturn.add(badge);
    if(action==="leave") activeReturn.delete(badge);
  }
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

  // PACK：兼容 packCount 和 packCountPeople
  var kc = document.getElementById("packCount") || document.getElementById("packCountPeople");
  var kl = document.getElementById("packActiveList");
  if(kc) kc.textContent = String(activePack.size);
  if(kl) kl.innerHTML = renderSetToHtml(activePack);

  // ✅ TALLY
  var tc = document.getElementById("tallyCount");
  var tl = document.getElementById("tallyActiveList");
  if(tc) tc.textContent = String(activeTally.size);
  if(tl) tl.innerHTML = renderSetToHtml(activeTally);

  // ✅ NEW: RETURN
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
      // 只展示最近 30 个，避免太长卡 UI
      var arr = Array.from(scannedInbounds);
      var show = arr.slice(Math.max(0, arr.length - 30));
      l.innerHTML = show.map(function(x){ return '<span class="tag">'+String(x)+'</span>'; }).join(" ");
    }
  }
}

/** ===== Global Active Now ===== */
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

    setStatus("在岗已更新 ✅", true);
  }catch(e){
    setStatus("在岗拉取异常 ❌ " + e, false);
    alert("在岗拉取异常：" + e);
  }
}

/** ===== NEW: RETURN (B2C) ===== */
async function startReturn(){
  try{
    if(currentSessionId){
      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    setSessionClosed(false);

    // reset state
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

async function endReturn(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次", false); return; }
    if(isSessionClosed()){ setStatus("该趟次已结束（无需重复结束）", false); return; }

    if(activeReturn.size > 0){
      setStatus("还有人员未退出，禁止结束", false);
      alert("还有人员未退出作业，不能结束退件入库。");
      return;
    }

    var evId = makeEventId({ event:"end", biz:"B2C", task:"退件入库", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"end", event_id: evId, biz:"B2C", task:"退件入库", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    setSessionClosed(true);
    setStatus("退件入库结束已记录（待上传）✅", true);

    // cleanup keys
    localStorage.removeItem(keyWaves());
    localStorage.removeItem(keyActivePick());
    localStorage.removeItem(keyActiveRelabel());
    localStorage.removeItem(keyActivePack());
    localStorage.removeItem(keyActiveTally());
    localStorage.removeItem(keyActiveReturn());
    localStorage.removeItem(keyInbounds());
    localStorage.removeItem(keyRecent());

    currentSessionId = null;
    localStorage.removeItem("pick_session_id");
    refreshUI();
  }catch(e){
    setStatus("退件入库结束失败 ❌ " + e, false);
  }
}

/** ===== TALLY (B2C) ===== */
async function startTally(){
  try{
    if(currentSessionId){
      restoreState(); renderActiveLists(); renderInboundCountUI(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }

    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    setSessionClosed(false);

    // reset state
    activeTally = new Set();
    scannedInbounds = new Set();
    persistState();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"TALLY", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      // enqueue (fast)
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

async function endTally(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次", false); return; }
    if(isSessionClosed()){ setStatus("该趟次已结束（无需重复结束）", false); return; }

    if(activeTally.size > 0){
      setStatus("还有人员未退出，禁止结束", false);
      alert("还有人员未退出作业，不能结束理货。");
      return;
    }

    var evId = makeEventId({ event:"end", biz:"B2C", task:"TALLY", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"end", event_id: evId, biz:"B2C", task:"TALLY", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    setSessionClosed(true);
    setStatus("理货结束已记录（待上传）✅", true);

    // cleanup keys
    localStorage.removeItem(keyWaves());
    localStorage.removeItem(keyActivePick());
    localStorage.removeItem(keyActiveRelabel());
    localStorage.removeItem(keyActivePack());
    localStorage.removeItem(keyActiveTally());
    localStorage.removeItem(keyActiveReturn());
    localStorage.removeItem(keyInbounds());
    localStorage.removeItem(keyRecent());

    currentSessionId = null;
    localStorage.removeItem("pick_session_id");
    refreshUI();
  }catch(e){
    setStatus("理货结束失败 ❌ " + e, false);
  }
}

async function openScannerInboundCount(){
  if(!currentSessionId){ setStatus("请先开始理货 / 먼저 시작", false); return; }
  if(isSessionClosed()){ setStatus("该趟次已结束，禁止扫码", false); return; }
  scanMode = "inbound_count";
  document.getElementById("scanTitle").textContent = "扫码入库单号（计数/去重）";
  await openScannerCommon();
}

/** ===== PICK ===== */
async function startPicking(){
  try{
    if(currentSessionId){
      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }
    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    setSessionClosed(false);

    scannedWaves = new Set();
    activePick = new Set();
    persistState();

    leaderPickOk = false;
    syncLeaderPickUI();

    var evId = makeEventId({ event:"start", biz:"B2C", task:"PICK", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      // enqueue (fast)
      submitEvent({ event:"start", event_id: evId, biz:"B2C", task:"PICK", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    refreshUI();
    setStatus("拣货开始已记录（待上传）✅ 现在可立即扫码加入", true);
  }catch(e){
    setStatus("拣货开始失败 ❌ " + e, false);
  }
}

async function openScannerWave(){
  if(!currentSessionId){ setStatus("请先开始拣货 / 먼저 시작", false); return; }
  if(isSessionClosed()){ setStatus("该趟次已结束，禁止扫码波次（请重新开始）", false); return; }
  scanMode = "wave";
  document.getElementById("scanTitle").textContent = "扫码波次 / 웨이브 스캔";
  await openScannerCommon();
}

async function leaderLoginPick(){
  if(!currentSessionId){
    setStatus("请先开始拣货再组长登录 / 먼저 시작", false);
    return;
  }
  if(isSessionClosed()){ setStatus("该趟次已结束，无法组长登录", false); return; }
  scanMode = "leaderLoginPick";
  document.getElementById("scanTitle").textContent = "扫码组长工牌登录 / 팀장 로그인";
  await openScannerCommon();
}

async function endPicking(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次", false); return; }
    if(isSessionClosed()){ setStatus("该趟次已结束（无需重复结束）", false); return; }
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

/** ===== RELABEL ===== */
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
      restoreState(); renderActiveLists(); refreshUI();
      setStatus("检测到未结束趟次：已恢复现场 ✅（如需重开请先结束）", false);
      return;
    }
    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);

    setSessionClosed(false);

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

async function endRelabel(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次", false); return; }
    if(isSessionClosed()){ setStatus("该趟次已结束（无需重复结束）", false); return; }
    if(activeRelabel.size > 0){
      setStatus("还有人员未退出，先 leave", false);
      alert("还有人员未退出作业，建议先退出再结束。");
      return;
    }

    var evId = makeEventId({ event:"end", biz:"B2C", task:"RELABEL", wave_id:"", badgeRaw:"" });
    if(!hasRecent(evId)){
      submitEvent({ event:"end", event_id: evId, biz:"B2C", task:"RELABEL", pick_session_id: currentSessionId });
      addRecent(evId);
    }

    setSessionClosed(true);

    if(relabelTimerHandle) clearInterval(relabelTimerHandle);
    relabelTimerHandle = null;

    setStatus("换单结束已记录（待上传）✅", true);

    localStorage.removeItem(keyWaves());
    localStorage.removeItem(keyActivePick());
    localStorage.removeItem(keyActiveRelabel());
    localStorage.removeItem(keyActivePack());
    localStorage.removeItem(keyActiveTally());
    localStorage.removeItem(keyActiveReturn());
    localStorage.removeItem(keyInbounds());
    localStorage.removeItem(keyRecent());

    currentSessionId = null;
    localStorage.removeItem("pick_session_id");
    refreshUI();
  }catch(e){
    setStatus("换单结束失败 ❌ " + e, false);
  }
}

/** ===== Labor (join/leave) ===== */
async function joinWork(biz, task){
  // only PACK allows auto session
  if(!currentSessionId){
    if(task === "PACK"){
      currentSessionId = makePickSessionId();
      localStorage.setItem("pick_session_id", currentSessionId);

      setSessionClosed(false);
      persistState();
      refreshUI();

      // PACK auto session -> write start once (enqueue, best-effort)
      try{
        var evIdStart = makeEventId({ event:"start", biz:biz, task:"PACK", wave_id:"", badgeRaw:"" });
        if(!hasRecent(evIdStart)){
          submitEvent({ event:"start", event_id: evIdStart, biz: biz, task:"PACK", pick_session_id: currentSessionId });
          addRecent(evIdStart);
        }
      }catch(e){}
    }else{
      setStatus("请先开始该作业再加入 / 먼저 시작", false);
      alert("请先点【开始】再加入作业。");
      return;
    }
  }

  if(isSessionClosed()){
    setStatus("该趟次已结束，禁止加入（请重新开始）", false);
    alert("该趟次已结束，请点击【开始】新建趟次后再加入。");
    return;
  }

  laborAction = "join"; laborBiz = biz; laborTask = task;
  scanMode = "labor";
  document.getElementById("scanTitle").textContent = "扫码工牌（加入）";
  await openScannerCommon();
}

async function leaveWork(biz, task){
  if(!currentSessionId){
    setStatus("请先开始该作业再退出 / 먼저 시작", false);
    alert("当前没有进行中的作业。\n请先点【开始】再退出。");
    return;
  }

  if(isSessionClosed()){
    setStatus("该趟次已结束，禁止退出（如需修正请联系管理员）", false);
    alert("该趟次已结束，禁止退出。\n如需要修正，请用管理员方式处理。");
    return;
  }

  // no one active -> disallow leave spam
  if(task === "PICK" && activePick.size === 0){ alert("当前没有人在拣货作业中（无需退出）。"); return; }
  if(task === "RELABEL" && activeRelabel.size === 0){ alert("当前没有人在换单作业中（无需退出）。"); return; }
  if(task === "PACK" && activePack.size === 0){ alert("当前没有人在打包贴单作业中（无需退出）。"); return; }
  if(task === "TALLY" && activeTally.size === 0){ alert("当前没有人在理货作业中（无需退出）。"); return; }
  if(task === "退件入库" && activeReturn.size === 0){ alert("当前没有人在退件入库作业中（无需退出）。"); return; } // ✅ NEW

  laborAction = "leave"; laborBiz = biz; laborTask = task;
  scanMode = "labor";
  document.getElementById("scanTitle").textContent = "扫码工牌（退出）";
  await openScannerCommon();
}

/** ===== Daily badge (daily DA-YYYYMMDD-xx) ===== */
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

/** ===== Long-term DA badges (DAF-xxx|name) ===== */
function padNum(n, width){
  var s = String(n);
  return s.length>=width ? s : ("0".repeat(width-s.length)+s);
}
function normalizeNames(text){
  return (text||"").split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
}

function generatePermanentDaBadges(){
  var ta = document.getElementById("daPermanentNames");
  if(!ta){ alert("index.html 里还没加 长期日当工牌输入框（daPermanentNames）"); return; }
  var names = normalizeNames(ta.value);
  if(names.length===0){ alert("请先输入长期日当姓名（每行一个）"); return; }

  var start = parseInt((document.getElementById("daPermanentStart")||{}).value || "1", 10);
  var pad = parseInt((document.getElementById("daPermanentPad")||{}).value || "3", 10);

  var listEl = document.getElementById("daPermanentList");
  if(!listEl){ alert("index.html 里还没加 输出区（daPermanentList）"); return; }
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

/** ===== Bind badge to session ===== */
async function bindBadgeToSession(){
  try{
    if(!currentSessionId){ setDaStatus("请先开始某个作业再绑定 / 먼저 시작", false); return; }
    if(isSessionClosed()){ setDaStatus("该趟次已结束，无法绑定工牌", false); return; }
    scanMode = "badgeBind";
    document.getElementById("scanTitle").textContent = "扫码工牌（绑定） / 명찰 연결";
    await openScannerCommon();
  }catch(e){
    setDaStatus("绑定失败 ❌ " + e, false);
  }
}

/** ===== Employee badges ===== */
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
    info.textContent = leaderPickBadge ? ("组长未确认（本趟需登录）: " + leaderPickBadge) : "组长未登录 / 팀장 미로그인";
    btnEnd.style.display = "none";
  }
}

/** ===== Scanner overlay ===== */
function showOverlay(){ var el=document.getElementById("scannerOverlay"); if(el) el.classList.add("show"); }
function hideOverlay(){ var el=document.getElementById("scannerOverlay"); if(el) el.classList.remove("show"); }

/** pause scanner to prevent duplicate callbacks */
async function pauseScanner(){
  try{ if(scanner) await scanner.pause(true); }catch(e){}
}

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

    /** inbound_count (TALLY) */
    if(scanMode === "inbound_count"){
      var code2 = decodedText.trim();
      if(!code2){
        setStatus("入库单号为空", false);
        return;
      }

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

        var evIdX = makeEventId({ event:"wave", biz:"B2C", task:"TALLY", wave_id: code2, badgeRaw:"" });
        if(!hasRecent(evIdX)){
          submitEvent({ event:"wave", event_id: evIdX, biz:"B2C", task:"TALLY", pick_session_id: currentSessionId, wave_id: code2 });
          addRecent(evIdX);
        }

        setStatus("已记录入库单（待上传）✅ " + code2, true);
        alert("已记录入库单 ✅\n" + code2 + "\n当前累计：" + scannedInbounds.size);
        await closeScanner();
        return;

      }catch(e){
        setStatus("提交失败 ❌ " + e, false);
        alert("提交失败，请重试。\n" + e);
        return;
      }finally{
        scanBusy = false;
      }
    }

    /** wave (PICK) */
    if(scanMode === "wave"){
      if(isSessionClosed()){ setStatus("该趟次已结束，禁止扫码波次", false); await closeScanner(); return; }

      var ok = /^\d{4}-\d{4}-\d+$/.test(code);
      if(!ok){ setStatus("波次格式不对（例：2026-0224-6）", false); return; }
      if(scannedWaves.has(code)){ setStatus("重复波次已忽略 ⏭️ " + code, false); return; }

      scannedWaves.add(code);
      persistState();

      scanBusy = true;
      await pauseScanner();
      try{
        var evId = makeEventId({ event:"wave", biz:"B2C", task:"PICK", wave_id: code, badgeRaw:"" });
        if(hasRecent(evId)){
          setStatus("重复扫码已忽略 ⏭️ " + code, false);
          await closeScanner();
          return;
        }

        submitEvent({ event:"wave", event_id: evId, biz:"B2C", task:"PICK", pick_session_id: currentSessionId, wave_id: code });
        addRecent(evId);

        alert("已记录波次 ✅ " + code);
        setStatus("已记录波次（待上传）✅ " + code, true);
        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }

    /** badgeBind */
    if(scanMode === "badgeBind"){
      if(isSessionClosed()){ setDaStatus("该趟次已结束，禁止绑定", false); await closeScanner(); return; }
      if(!isOperatorBadge(code)){ setDaStatus("无效工牌（DA-... / DAF-...|名字 / EMP-...|名字）", false); return; }
      var p = parseBadge(code);

      scanBusy = true;
      await pauseScanner();
      try{
        var evId2 = makeEventId({ event:"bind_daily", biz:"DAILY", task:"BADGE", wave_id:"", badgeRaw:p.raw });
        if(hasRecent(evId2)){
          setDaStatus("重复扫码已忽略 ⏭️", false);
          await closeScanner();
          return;
        }

        submitEvent({ event:"bind_daily", event_id: evId2, biz:"DAILY", task:"BADGE", pick_session_id: currentSessionId, da_id: p.raw });
        addRecent(evId2);

        currentDaId = p.raw; localStorage.setItem("da_id", currentDaId); refreshDaUI();
        alert("已绑定工牌 ✅ " + p.raw);
        setDaStatus("绑定成功（待上传）✅", true);
        await closeScanner();
      } finally { scanBusy = false; }
      return;
    }

    /** labor (join/leave must be SYNC) */
    if(scanMode === "labor"){
      if(isSessionClosed()){
        setStatus("该趟次已结束，禁止 join/leave（请重新开始）", false);
        alert("该趟次已结束，禁止 join/leave。\n请点击【开始】新建趟次后再操作。");
        await closeScanner();
        return;
      }

      if(!isOperatorBadge(code)){ setStatus("无效工牌（DA-... / DAF-...|名字 / EMP-...|名字）", false); return; }
      var p2 = parseBadge(code);

      // leave must be active
      if(laborAction === "leave" && !isAlreadyActive(laborTask, p2.raw)){
        alert("该工牌不在当前作业名单中，无法退出。\n请确认是否扫错工牌。");
        setStatus("不在岗，无法退出 ❌", false);
        await closeScanner();
        return;
      }

      // join dedupe by active
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
        var evId = makeEventId({
          event: laborAction,
          biz: laborBiz,
          task: laborTask,
          wave_id: "",
          badgeRaw: p2.raw
        });

        if(hasRecent(evId)){
          setStatus("重复扫描已忽略 ⏭️", false);
          await closeScanner();
          return;
        }

        await submitEventSync_({
          event: laborAction,
          event_id: evId,
          biz: laborBiz,
          task: laborTask,
          pick_session_id: currentSessionId,
          da_id: p2.raw
        });

        addRecent(evId);

        // ✅ then update local state
        applyActive(laborTask, laborAction, p2.raw);
        renderActiveLists();
        persistState();

        alert((laborAction === "join" ? "已加入 ✅ " : "已退出 ✅ ") + p2.raw);
        setStatus((laborAction === "join" ? "加入成功 ✅ " : "退出成功 ✅ ") + p2.raw, true);
        await closeScanner();
        return;
      } catch(e){
        setStatus("提交失败 ❌ " + e, false);
        alert("提交失败，请重试。\n" + e);
        return;
      } finally {
        scanBusy = false;
      }
    }

    /** leader login pick */
    if(scanMode === "leaderLoginPick"){
      if(isSessionClosed()){ setStatus("该趟次已结束，无法组长登录", false); await closeScanner(); return; }
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

    /** leader end pick */
    if(scanMode === "leaderEndPick"){
      if(isSessionClosed()){ setStatus("该趟次已结束（无需重复结束）", false); await closeScanner(); return; }
      if(!isOperatorBadge(code)){ setStatus("无效工牌（请扫 EMP-xxx|名字）", false); return; }
      var p4 = parseBadge(code);
      if(!p4.id.startsWith("EMP-")){ setStatus("请扫组长员工工牌（EMP-xxx|名字）", false); return; }
      if(activePick.size > 0){ setStatus("还有人员未退出，禁止结束", false); alert("还有人员未退出作业，不能结束拣货。"); await closeScanner(); return; }

      scanBusy = true;
      await pauseScanner();
      try{
        leaderPickBadge = p4.raw; localStorage.setItem("leader_pick_badge", leaderPickBadge);

        var biz = pendingLeaderEnd ? pendingLeaderEnd.biz : "B2C";
        var task = pendingLeaderEnd ? pendingLeaderEnd.task : "PICK";

        var evIdEnd = makeEventId({ event:"end", biz: biz, task: task, wave_id:"", badgeRaw: p4.raw });
        if(!hasRecent(evIdEnd)){
          submitEvent({ event:"end", event_id: evIdEnd, biz: biz, task: task, pick_session_id: currentSessionId });
          addRecent(evIdEnd);
        }

        setSessionClosed(true);

        alert("已由组长确认结束 ✅ " + p4.raw);
        setStatus("结束已记录（待上传）✅", true);

        localStorage.removeItem(keyWaves());
        localStorage.removeItem(keyActivePick());
        localStorage.removeItem(keyActiveRelabel());
        localStorage.removeItem(keyActivePack());
        localStorage.removeItem(keyActiveTally());
        localStorage.removeItem(keyActiveReturn());
        localStorage.removeItem(keyInbounds());
        localStorage.removeItem(keyRecent());

        currentSessionId = null;
        localStorage.removeItem("pick_session_id");
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

/** ===== helper ===== */
function comingSoon(msg){
  alert((msg||"准备中") + "\n\n我们会逐步上线。");
}

/** ===== init ===== */
refreshNet();
refreshUI();
restoreState();
renderActiveLists();
renderPages();
flushQueue_();
