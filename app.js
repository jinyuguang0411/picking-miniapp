// app.js - 业务逻辑（路由/状态/扫码/提交/跨设备锁/防重复）
// ✅ 规则：PICK/RELABEL 必须先点“开始”才能 join/leave；PACK 允许直接 join（自动建 session）

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
var LOCK_TTL_MS = 8 * 60 * 60 * 1000;

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
  if(cur==="b2c_pick"){ syncLeaderPickUI(); restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_relabel"){ restoreState(); renderActiveLists(); refreshUI(); }
  if(cur==="b2c_pack"){ restoreState(); renderActiveLists(); refreshUI(); }
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
var lastScanAt = 0;
var scanBusy = false;

var currentDaId = localStorage.getItem("da_id") || null;

var laborAction = null;
var laborBiz = null;
var laborTask = null;

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

/** ===== Submit event ===== */
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

async function lockAcquireRemote(badgeRaw, task, sessionId){
  return await jsonp(LOCK_URL, {
    action: "lock_acquire",
    badge: badgeRaw,
    task: task,
    session: sessionId || "",
    device_id: makeDeviceId(),
    ttl_ms: String(LOCK_TTL_MS)
  });
}
async function lockReleaseRemote(badgeRaw, task){
  return await jsonp(LOCK_URL, {
    action: "lock_release",
    badge: badgeRaw,
    task: task,
    device_id: makeDeviceId()
  });
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

/** ===== Active ===== */
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

  var kc = document.getElementById("packCount");
  var kl = document.getElementById("packActiveList");
  if(kc) kc.textContent = String(activePack.size);
  if(kl) kl.innerHTML = renderSetToHtml(activePack);
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
    setStatus("拣货开始已记录 ✅", true);
  }catch(e){
    setStatus("拣货开始失败 ❌ " + e, false);
  }
}

async function openScannerWave(){
  if(!currentSessionId){ setStatus("请先开始拣货 / 먼저 시작", false); return; }
  scanMode = "wave";
  document.getElementById("scanTitle").textContent = "扫码波次 / 웨이브 스캔";
  await openScannerCommon();
}

async function leaderLoginPick(){
  if(!currentSessionId){
    setStatus("请先开始拣货再组长登录 / 먼저 시작", false);
    return;
  }
  scanMode = "leaderLoginPick";
  document.getElementById("scanTitle").textContent = "扫码组长工牌登录 / 팀장 로그인";
  await openScannerCommon();
}

async function endPicking(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次", false); return; }
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

    activeRelabel = new Set();
    persistState();

    relabelStartTs = Date.now();
    setRelabelTimerText("进行中: 00:00");
    startRelabelTimer();

    await submitEvent({ event:"start", biz:"B2C", task:"RELABEL", pick_session_id: currentSessionId });
    refreshUI();
    setStatus("换单开始已记录 ✅", true);
  }catch(e){
    setStatus("换单开始失败 ❌ " + e, false);
  }
}
async function endRelabel(){
  try{
    if(!currentSessionId){ setStatus("没有未结束趟次", false); return; }
    if(activeRelabel.size > 0){
      setStatus("还有人员未退出，先 leave", false);
      alert("还有人员未退出作业，建议先退出再结束。");
      return;
    }
    await submitEvent({ event:"end", biz:"B2C", task:"RELABEL", pick_session_id: currentSessionId });

    if(relabelTimerHandle) clearInterval(relabelTimerHandle);
    relabelTimerHandle = null;

    setStatus("换单结束已记录 ✅", true);

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

/** ===== Labor (join/leave) ===== */
async function joinWork(biz, task){
  // ✅ 只有 PACK 允许无 session 自动创建
  if(!currentSessionId){
    if(task === "PACK"){
      currentSessionId = makePickSessionId();
      localStorage.setItem("pick_session_id", currentSessionId);
      persistState();
      refreshUI();
    }else{
      setStatus("请先开始该作业再加入 / 먼저 시작", false);
      alert("请先点【开始】再加入作业。");
      return;
    }
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

  // ✅ 没人加入就不允许退出（避免无限 leave）
  if(task === "PICK" && activePick.size === 0){ alert("当前没有人在拣货作业中（无需退出）。"); return; }
  if(task === "RELABEL" && activeRelabel.size === 0){ alert("当前没有人在换单作业中（无需退出）。"); return; }
  if(task === "PACK" && activePack.size === 0){ alert("当前没有人在打包贴单作业中（无需退出）。"); return; }

  laborAction = "leave"; laborBiz = biz; laborTask = task;
  scanMode = "labor";
  document.getElementById("scanTitle").textContent = "扫码工牌（退出）";
  await openScannerCommon();
}

/** ===== Scanner overlay ===== */
function showOverlay(){ document.getElementById("scannerOverlay").classList.add("show"); }
function hideOverlay(){ document.getElementById("scannerOverlay").classList.remove("show"); }

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
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "labor"){
      if(!isOperatorBadge(code)){ setStatus("无效工牌（DA-... 或 EMP-...|名字）", false); return; }
      var p2 = parseBadge(code);

      // ✅ leave 必须是名单里的人
      if(laborAction === "leave" && !isAlreadyActive(laborTask, p2.raw)){
        alert("该工牌不在当前作业名单中，无法退出。\n请确认是否扫错工牌。");
        setStatus("不在岗，无法退出 ❌", false);
        await closeScanner();
        return;
      }

      // ✅ join 本地去重
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
          var r1 = await lockAcquireRemote(p2.raw, laborTask, currentSessionId);
          if(!r1 || r1.ok !== true){
            setStatus("锁服务异常 ❌", false);
            alert("锁服务异常，请重试。");
            return;
          }
          if(r1.locked !== true){
            var lk = r1.lock || {};
            setStatus("该工牌已在其它设备作业中 ❌", false);
            alert("该工牌已在其它设备作业中：\n任务: "+(lk.task||"")+"\n设备: "+(lk.device_id||"")+"\n请先在原设备退出。");
            return;
          }
        }

        if(laborAction === "leave"){
          try{ await lockReleaseRemote(p2.raw, laborTask); }catch(e){}
        }

        // 先更新本地状态（让 UI 立即变化）
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
      } finally { scanBusy = false; }
      return;
    }

    if(scanMode === "leaderEndPick"){
      if(!isOperatorBadge(code)){ setStatus("无效工牌（请扫 EMP-xxx|名字）", false); return; }
      var p4 = parseBadge(code);
      if(!p4.id.startsWith("EMP-")){ setStatus("请扫组长员工工牌（EMP-xxx|名字）", false); return; }
      if(activePick.size > 0){ setStatus("还有人员未退出，禁止结束", false); alert("还有人员未退出作业，不能结束拣货。"); await closeScanner(); return; }

      scanBusy = true;
      try{
        leaderPickBadge = p4.raw; localStorage.setItem("leader_pick_badge", leaderPickBadge);

        var biz = pendingLeaderEnd ? pendingLeaderEnd.biz : "B2C";
        var task = pendingLeaderEnd ? pendingLeaderEnd.task : "PICK";
        await submitEvent({ event:"end", biz: biz, task: task, pick_session_id: currentSessionId });

        alert("已由组长确认结束 ✅ " + p4.raw);
        setStatus("结束已记录 ✅", true);

        localStorage.removeItem(keyWaves());
        localStorage.removeItem(keyActivePick());
        localStorage.removeItem(keyActiveRelabel());
        localStorage.removeItem(keyActivePack());

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
