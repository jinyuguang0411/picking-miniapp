// ui.js - 只负责展示/渲染，不做业务逻辑
// ✅ 避免与 app.js 重名：不定义 setStatus/refreshUI/refreshNet/showOverlay/hideOverlay/comingSoon
// ✅ 补 PACK active 渲染
// ✅ session 已结束：UI 给出明确提示 & 禁用结束按钮显示逻辑更严谨

function $(id){ return document.getElementById(id); }

/** ===== Helpers ===== */
function uiIsSessionClosedSafe(){
  try{
    if(typeof isSessionClosed === "function") return !!isSessionClosed();
  }catch(e){}
  return false;
}

function badgeDisplay(raw){
  var p = parseBadge(raw);
  return p.name ? (p.id + "｜" + p.name) : p.id;
}

function renderSetToHtml(setObj){
  var arr = Array.from(setObj || []);
  if(arr.length === 0) return '<span class="muted">无 / 없음</span>';
  return arr.map(function(x){
    return '<span class="tag">' + badgeDisplay(x) + '</span>';
  }).join("");
}

/** ===== Active lists ===== */
function renderActiveLists(){
  // PICK
  if($("pickCount")) $("pickCount").textContent = String(activePick.size);
  if($("pickActiveList")) $("pickActiveList").innerHTML = renderSetToHtml(activePick);

  // RELABEL
  if($("relabelCount")) $("relabelCount").textContent = String(activeRelabel.size);
  if($("relabelActiveList")) $("relabelActiveList").innerHTML = renderSetToHtml(activeRelabel);

  // PACK (NEW)
  if($("packCount")) $("packCount").textContent = String(activePack.size);
  if($("packActiveList")) $("packActiveList").innerHTML = renderSetToHtml(activePack);

  // Session closed hint (optional UI)
  var hint = $("sessionClosedHint");
  if(hint){
    if(currentSessionId && uiIsSessionClosedSafe()){
      hint.style.display = "block";
      hint.textContent = "该趟次已结束：禁止 join/leave（请重新开始）";
    }else{
      hint.style.display = "none";
      hint.textContent = "";
    }
  }
}

/** ===== Leader UI (PICK) ===== */
function syncLeaderPickUI(){
  var info = $("leaderInfoPick");
  var btnEnd = $("btnEndPick");
  if(!info || !btnEnd) return;

  // session ended: 不显示结束按钮（避免误触）
  if(currentSessionId && uiIsSessionClosedSafe()){
    info.textContent = "本趟次已结束 ✅";
    btnEnd.style.display = "none";
    return;
  }

  if(leaderPickOk && leaderPickBadge){
    info.textContent = "组长已登录 ✅ " + leaderPickBadge;
    btnEnd.style.display = "block";
  }else{
    info.textContent = leaderPickBadge
      ? ("组长未确认（本趟需登录）: " + leaderPickBadge)
      : "组长未登录 / 팀장 미로그인";
    btnEnd.style.display = "none";
  }
}

/** ===== Optional: lightweight UI refresh hook =====
 * 你原来 ui.js 里有 online/offline 监听，但 refreshNet 已在 app.js 里做了。
 * 这里不再重复绑定，避免覆盖/重复。
 */
