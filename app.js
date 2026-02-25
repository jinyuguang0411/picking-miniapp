// app.js - 业务逻辑（路由/状态/扫码/提交/锁）

/** ===== Form ===== */
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
var LOCK_TTL_MS = 8 * 60 * 60 * 1000; // 8小时，和脚本一致即可

/** ===== Router ===== */
var pages = ["home","badge","b2c_menu","b2c_pick","b2c_relabel","b2c_pack"];

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
  // 进入页面时恢复显示
  if(cur==="b2c_pick"){ syncLeaderPickUI(); restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_relabel"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_pack"){ restoreState(); renderActiveLists(); refreshUI(); }
}
window.addEventListener("hashchange", renderPages);

function go(p){ setHash(p); }
function back(){ if(history.length > 1) history.back(); else setHash("home"); }
if(!location.hash) setHash("home");

/** ===== Globals (var to avoid iOS TDZ) ===== */
var scanner = null;
var scanMode = null;

var currentSessionId = localStorage.getItem("pick_session_id") || null;

var scannedWaves = new Set();
var lastScanAt = 0;
var scanBusy = false;         // ✅ 防卡重复扫

var currentDaId = localStorage.getItem("da_id") || null;

var laborAction = null; // join/leave
var laborBiz = null;    // B2C
var laborTask = null;   // PICK/RELABEL/PACK

var activePick = new Set();
var activeRelabel = new Set();
var activePack = new Set();

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

function persistState(){
  if(!currentSessionId) return;
  localStorage.setItem(keyWaves(), JSON.stringify(Array.from(scannedWaves)));
  localStorage.setItem(keyActivePick(), JSON.stringify(Array.from(activePick)));
  localStorage.setItem(keyActiveRelabel(), JSON.stringify(Array.from(activeRelabel)));
  localStorage.setItem(keyActivePack(), JSON.stringify(Array.from(activePack)));
}
function restoreState(){
  if(!currentSessionId) return;
  try{ scannedWaves = new Set(JSON.parse(localStorage.getItem(keyWaves()) || "[]")); }catch(e){ scannedWaves = new Set(); }
  try{ activePick = new Set(JSON.parse(localStorage.getItem(keyActivePick()) || "[]")); }catch(e){ activePick = new Set(); }
  try{ activeRelabel = new Set(JSON.parse(localStorage.getItem(keyActiveRelabel()) || "[]")); }catch(e){ activeRelabel = new Set(); }
  try{ activePack = new Set(JSON.parse(localStorage.getItem(keyActivePack()) || "[]")); }catch(e){ activePack = new Set(); }
}

/** ===== UI utils ===== */
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

/** ===== Submit event (Google Form) ===== */
async function submitEvent(o){
  var fd = new FormData();
  fd.append(ENTRY_EVENT, o.event);
  fd.append(ENTRY_DEVICE, makeDeviceId());
  fd.append(ENTRY_SESSION, o.pick_session_id || "NA");
  fd.append(ENTRY_WAVE, o.wave_id || "");
  fd.append(ENTRY_TS, nowTs());
  fd.append(ENTRY_DA, o.da_id || "");
  fd.append(ENTRY_BIZ, o.biz || "");
  fd.append(ENTRY_TASK, o.task || "");
  await fetch(FORM_URL, { method:"POST", mode:"no-cors", body: fd });
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
function isOperatorBadge(raw){
  var p = parseBadge(raw);
  return isDaId(p.id) || isEmpId(p.id);
}

/** ===== Active list render ===== */
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

  // PACK 如果你 index.html 没放这两个元素也没关系（不会报错）
  var kc = document.getElementById("packCount");
  var kl = document.getElementById("packActiveList");
  if(kc) kc.textContent = String(activePack.size);
  if(kl) kl.innerHTML = renderSetToHtml(activePack);
}

/** ===== Leader UI (PICK only) ===== */
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

/** ===== JSONP helper (for lock service) ===== */
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
    }, 8000);

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

/** ===== Remote lock ===== */
async function lockAcquireRemote(badgeRaw, task, sessionId){
  var res = await jsonp(LOCK_URL, {
    action: "lock_acquire",
    badge: badgeRaw,
    task: task,
    session: sessionId || "",
    device_id: makeDeviceId(),
    ttl_ms: String(LOCK_TTL_MS)
  });
  return res;
}

async function lockReleaseRemote(badgeRaw, task){
  var res = await jsonp(LOCK_URL, {
    action: "lock_release",
    badge: badgeRaw,
    task: task,
    device_id: makeDeviceId()
  });
  return res;
}

/** ===== Local active helper ===== */
function isAlreadyActive(task, badge){
  if(task==="PICK") return activePick.has(badge);
  if(task==="RELABEL") return activeRelabel.has(badge);
  if(task==="PACK") return activePack.has(badge);
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

    scannedWaves = new Set();
    activePick = new Set();
    persistState();

    leaderPickOk = false;
    syncLeaderPickUI();

    await submitEvent({ event:"start", biz:"B2C", task:"PICK", pick_session_id: currentSessionId });
    refreshUI();
    setStatus("拣货开始已记录 ✅ / 시작 기록됨", true);
  }catch(e){
    setStatus("拣货开始失败 ❌ " + e, false);
  }
}

async function openScannerWave(){
  if(!currentSessionId){ setStatus("请先开始拣货 / 먼저 시작", false); return; }
  scanMode = "wave";
  var t = document.getElementById("scanTitle");
  if(t) t.textContent = "扫码波次 / 웨이브 스캔";
  await openScannerCommon();
}

async function leaderLoginPick(){
  if(!currentSessionId){
    setStatus("请先开始拣货再组长登录 / 먼저 시작", false);
    return;
  }
  scanMode = "leaderLoginPick";
  var t = document.getElementById("scanTitle");
  if(t) t.textContent = "扫码组长工牌登录 / 팀장 로그인";
  await openScannerCommon();
}

async function endPicking(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次 / 열린 세션 없음", false); return; }
    if(!leaderPickOk){ setStatus("需要组长先登录（扫码）/ 팀장 로그인 필요", false); return; }
    if(activePick.size > 0){
      setStatus("还有人员未退出，禁止结束（请让他们 leave）", false);
      alert("还有人员未退出作业，不能结束拣货。\n请让所有参与者点【退出作业】并扫码工牌。");
      return;
    }
    pendingLeaderEnd = { biz:"B2C", task:"PICK" };
    scanMode = "leaderEndPick";
    var t = document.getElementById("scanTitle");
    if(t) t.textContent = "扫码组长工牌确认结束 / 팀장 종료 확인";
    await openScannerCommon();
  }catch(e){
    setStatus("结束确认失败 ❌ " + e, false);
  }
}

/** ===== RELABEL (simple start/end) ===== */
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
    setRelabelTimerText("进行中 / 진행중: " + mm + ":" + ss);
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

    activeRelabel = new Set();
    persistState();

    relabelStartTs = Date.now();
    setRelabelTimerText("进行中 / 진행중: 00:00");
    startRelabelTimer();

    await submitEvent({ event:"start", biz:"B2C", task:"RELABEL", pick_session_id: currentSessionId });
    refreshUI();
    setStatus("换单开始已记录 ✅（0额外扫码）", true);
  }catch(e){
    setStatus("换单开始失败 ❌ " + e, false);
  }
}

async function endRelabel(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次 / 열린 세션 없음", false); return; }
    if(activeRelabel.size > 0){
      setStatus("还有人员未退出，建议先 leave（否则人时不准）", false);
      alert("还有人员未退出作业。\n建议先让所有参与者点【退出作业】扫码，再结束。");
      return;
    }

    await submitEvent({ event:"end", biz:"B2C", task:"RELABEL", pick_session_id: currentSessionId });

    if(relabelTimerHandle) clearInterval(relabelTimerHandle);
    relabelTimerHandle = null;

    var endTs = Date.now();
    var sec = relabelStartTs ? Math.floor((endTs - relabelStartTs)/1000) : 0;
    var mm = String(Math.floor(sec/60)).padStart(2,'0');
    var ss = String(sec%60).padStart(2,'0');
    setRelabelTimerText("已结束 / 종료됨: " + mm + ":" + ss + "（按该时间段导出出单明细）");

    setStatus("换单结束已记录 ✅", true);

    // 清理 session
    localStorage.removeItem(keyWaves());
    localStorage.removeItem(keyActivePick());
    localStorage.removeItem(keyActiveRelabel());
    localStorage.removeItem(keyActivePack());

    currentSessionId = null;
    localStorage.removeItem("pick_session_id");
    refreshUI();
  }catch(e){
    setStatus("换单结束失败 ❌ " + e, false);
  }
}

/** ===== PACK：不需要 start/end，直接 join/leave（扫工牌） ===== */
// 页面里直接用 joinWork('B2C','PACK') / leaveWork('B2C','PACK') 即可

/** ===== Labor join/leave ===== */
async function joinWork(biz, task){
  if(!currentSessionId){
    // PACK/RELABEL 也需要 session：没有就自动创建一个
    currentSessionId = makePickSessionId();
    localStorage.setItem("pick_session_id", currentSessionId);
    persistState();
    refreshUI();
  }
  laborAction = "join"; laborBiz = biz; laborTask = task;
  scanMode = "labor";
  var t = document.getElementById("scanTitle");
  if(t) t.textContent = "扫码工牌（加入） / 명찰 스캔(입장)";
  await openScannerCommon();
}

async function leaveWork(biz, task){
  if(!currentSessionId){
    setStatus("没有进行中的作业（无法退出）", false);
    alert("当前没有进行中的作业 session。\n请先加入(join)再退出(leave)。");
    return;
  }
  laborAction = "leave"; laborBiz = biz; laborTask = task;
  scanMode = "labor";
  var t = document.getElementById("scanTitle");
  if(t) t.textContent = "扫码工牌（退出） / 명찰 스캔(퇴장)";
  await openScannerCommon();
}

/** ===== Daily badges (keep as-is minimal) ===== */
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
    await submitEvent({ event:"daily_checkin", biz:"DAILY", task:"BADGE", pick_session_id:"NA", da_id: da });
    refreshDaUI();
    alert("日当工牌已生成 ✅ " + da);
    setDaStatus("已记录 ✅", true);

    var listEl = document.getElementById("badgeList");
    if(!listEl) return;
    var box = document.createElement("div");
    box.style.border = "1px solid #ddd";
    box.style.borderRadius = "12px";
    box.style.padding = "10px";
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px;">'+da+'</div><div id="qr_'+da+'"></div>';
    listEl.prepend(box);
    new QRCode(document.getElementById("qr_"+da), { text: da, width: 160, height: 160 });
  }catch(e){
    setDaStatus("失败 ❌ " + e, false);
  }
}
async function bulkDailyCheckin(){
  try{
    var n = parseInt(document.getElementById("daCount").value || "0", 10);
    if(!n || n < 1) return alert("请输入人数 N（>=1）");
    var listEl = document.getElementById("badgeList");
    if(!listEl) return;
    listEl.innerHTML = "";
    setDaStatus("生成中...", true);
    for(var i=0;i<n;i++){
      var da = makeDaId();
      await submitEvent({ event:"daily_checkin", biz:"DAILY", task:"BADGE", pick_session_id:"NA", da_id: da });

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
    setDaStatus("批量生成完成 ✅ 共 "+n+" 个（可截图/打印）", true);
  }catch(e){
    setDaStatus("批量生成失败 ❌ " + e, false);
  }
}
async function bindBadgeToSession(){
  try{
    if(!currentSessionId){ setDaStatus("请先开始某个作业再绑定 / 먼저 시작", false); return; }
    scanMode = "badgeBind";
    var t = document.getElementById("scanTitle");
    if(t) t.textContent = "扫码工牌（绑定） / 명찰 연결";
    await openScannerCommon();
  }catch(e){
    setDaStatus("绑定失败 ❌ " + e, false);
  }
}

/** ===== Employee badges ===== */
function padNum(n, width){ var s=String(n); return s.length>=width?s:("0".repeat(width-s.length)+s); }
function normalizeNames(text){ return (text||"").split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean); }
function generateEmployeeBadges(){
  var names = normalizeNames(document.getElementById("empNames").value);
  if(names.length===0){ alert("请先输入员工名字（每行一个）"); return; }
  var start = parseInt(document.getElementById("empStart").value || "1", 10);
  var pad = parseInt(document.getElementById("empPad").value || "3", 10);

  var listEl = document.getElementById("empBadgeList");
  if(!listEl) return;
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

/** ===== Fullscreen Scanner Overlay ===== */
function showOverlay(){ document.getElementById("scannerOverlay").classList.add("show"); }
function hideOverlay(){ document.getElementById("scannerOverlay").classList.remove("show"); }

/** ===== Scanner main ===== */
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

    /** wave (PICK only) */
    if(scanMode === "wave"){
      var ok = /^\d{4}-\d{4}-\d+$/.test(code);
      if(!ok){ setStatus("波次格式不对（例：2026-0224-6）", false); return; }
      if(scannedWaves.has(code)){ setStatus("重复波次已忽略 ⏭️ " + code, false); return; }
      scannedWaves.add(code);
      persistState();

      scanBusy = true;
      try{
        await submitEvent({ event:"wave", biz:"B2C", task:"PICK", pick_session_id: currentSessionId, wave_id: code });
        alert("已记录波次 ✅ " + code);
        setStatus("已记录波次 ✅ " + code, true);
      } finally {
        scanBusy = false;
      }
      return;
    }

    /** badge bind (daily) */
    if(scanMode === "badgeBind"){
      if(!isOperatorBadge(code)){ setDaStatus("无效工牌（DA-... 或 EMP-...|名字）", false); return; }
      var p = parseBadge(code);

      scanBusy = true;
      try{
        await submitEvent({ event:"bind_daily", biz:"DAILY", task:"BADGE", pick_session_id: currentSessionId, da_id: p.raw });
        currentDaId = p.raw; localStorage.setItem("da_id", currentDaId); refreshDaUI();
        alert("已绑定工牌 ✅ " + p.raw);
        setDaStatus("绑定成功 ✅", true);
        await closeScanner();
      } finally {
        scanBusy = false;
      }
      return;
    }

    /** labor join/leave */
    if(scanMode === "labor"){
      if(!isOperatorBadge(code)){ setStatus("无效工牌（DA-... 或 EMP-...|名字）", false); return; }
      var p2 = parseBadge(code);

      // join：本地去重（避免卡住重复扫）
      if(laborAction === "join" && isAlreadyActive(laborTask, p2.raw)){
        alert("已在作业中 ✅ " + p2.raw);
        setStatus("已在作业中 ✅", true);
        await closeScanner();
        return;
      }

      scanBusy = true;
      setStatus("处理中... 请稍等 ⏳", true);

      try{
        if(laborAction === "join"){
          // 先远程拿锁（跨设备）
          var r1 = await lockAcquireRemote(p2.raw, laborTask, currentSessionId);
          if(!r1 || r1.ok !== true){
            setStatus("锁服务异常 ❌", false);
            alert("锁服务异常，请重试。");
            return;
          }
          if(r1.locked !== true){
            var lk = r1.lock || {};
            setStatus("该工牌已在其它设备作业中 ❌", false);
            alert(
              "该工牌已在其它设备作业中：\n" +
              "任务: " + (lk.task||"") + "\n" +
              "设备: " + (lk.device_id||"") + "\n" +
              "请先在原设备退出。"
            );
            return;
          }
        }

        if(laborAction === "leave"){
          // leave：释放锁（若释放失败也继续写 leave，不阻塞）
          try{ await lockReleaseRemote(p2.raw, laborTask); }catch(e){}
        }

        // 先更新本地名单（减少重复扫码）
        applyActive(laborTask, laborAction, p2.raw);
        renderActiveLists();
        persistState();

        // 写入表
        await submitEvent({ event: laborAction, biz: laborBiz, task: laborTask, pick_session_id: currentSessionId, da_id: p2.raw });

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
      if(!isOperatorBadge(code)){ setStatus("无效工牌（请扫 EMP-xxx|名字）", false); return; }
      var p3 = parseBadge(code);
      if(!p3.id.startsWith("EMP-")){ setStatus("请扫组长员工工牌（EMP-xxx|名字）", false); return; }

      scanBusy = true;
      try{
        leaderPickBadge = p3.raw; localStorage.setItem("leader_pick_badge", leaderPickBadge);
        leaderPickOk = true; syncLeaderPickUI();
        alert("组长登录成功 ✅ " + p3.raw);
        setStatus("组长登录成功 ✅", true);
        await closeScanner();
      } finally {
        scanBusy = false;
      }
      return;
    }

    /** leader end pick */
    if(scanMode === "leaderEndPick"){
      if(!isOperatorBadge(code)){ setStatus("无效工牌（请扫 EMP-xxx|名字）", false); return; }
      var p4 = parseBadge(code);
      if(!p4.id.startsWith("EMP-")){ setStatus("请扫组长员工工牌（EMP-xxx|名字）", false); return; }
      if(activePick.size > 0){
        setStatus("还有人员未退出，禁止结束", false);
        alert("还有人员未退出作业，不能结束拣货。");
        await closeScanner();
        return;
      }

      scanBusy = true;
      try{
        leaderPickBadge = p4.raw; localStorage.setItem("leader_pick_badge", leaderPickBadge);

        var biz = pendingLeaderEnd ? pendingLeaderEnd.biz : "B2C";
        var task = pendingLeaderEnd ? pendingLeaderEnd.task : "PICK";
        await submitEvent({ event:"end", biz: biz, task: task, pick_session_id: currentSessionId });

        alert("已由组长确认结束 ✅ " + p4.raw);
        setStatus("结束已记录 ✅（组长确认）", true);

        // 清理 session
        localStorage.removeItem(keyWaves());
        localStorage.removeItem(keyActivePick());
        localStorage.removeItem(keyActiveRelabel());
        localStorage.removeItem(keyActivePack());

        currentSessionId = null;
        localStorage.removeItem("pick_session_id");
        pendingLeaderEnd = null;
        leaderPickOk = false;

        refreshUI();
        syncLeaderPickUI();

        await closeScanner();
      } finally {
        scanBusy = false;
      }
      return;
    }
  };

  try{
    await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 240, height: 240 } }, onScan);
  }catch(e){
    // fallback：显式选第一个摄像头
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

/** ===== Coming soon helper ===== */
function comingSoon(msg){
  alert((msg||"准备中") + "\n\n我们会逐步上线。");
}

/** ===== init ===== */
refreshNet();
refreshUI();
restoreState();
renderActiveLists();
renderPages();
