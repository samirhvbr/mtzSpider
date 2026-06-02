// Spider Mobiliza v3.5 — tab.js (smart unified UI)

const $ = id => document.getElementById(id);

// ── Versão dinâmica ──
try {
  const mv = chrome.runtime.getManifest();
  const vEl = $("extVersion");
  if (vEl && mv?.version) vEl.textContent = `v${mv.version}`;
} catch (_) {}

// ── Tabs ──
document.querySelectorAll(".htab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".htab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "profiles") loadProfiles();
    if (tab.dataset.tab === "history")  loadHistory();
    if (tab.dataset.tab === "config")   loadConfig();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// UTILITÁRIOS
// ──────────────────────────────────────────────────────────────────────────────
function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, r => resolve(r || { ok: false }));
  });
}

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function fmtEta(sec) {
  if (!sec || sec <= 0) return "—";
  if (sec < 60)  return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

async function getStoredConfig() {
  const s = await chrome.storage.local.get("config");
  return s.config || {};
}

// ──────────────────────────────────────────────────────────────────────────────
// LOG
// ──────────────────────────────────────────────────────────────────────────────
function smLog(text, type = "") {
  const box = $("smLogBox");
  if (!box) return;
  const div = document.createElement("div");
  div.className = `log-line ${type}`;
  const ts = new Date().toLocaleTimeString("pt-BR");
  div.textContent = `[${ts}] ${text}`;
  box.insertBefore(div, box.firstChild);
  while (box.children.length > 300) box.removeChild(box.lastChild);
}

$("btnSmClearLog").addEventListener("click", () => {
  $("smLogBox").innerHTML = '<div class="log-line muted">Log limpo.</div>';
});

// ──────────────────────────────────────────────────────────────────────────────
// DETECÇÃO INTELIGENTE DE INPUT
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Analisa a string e retorna um objeto de detecção ou null.
 * Tipos possíveis: "ig_profile" | "ig_post" | "fb_post"
 */
function detectInput(raw) {
  const s = raw.trim();
  if (!s) return null;

  // ── Facebook ─────────────────────────────────────────────────────────────
  if (/facebook\.com/i.test(s)) {
    let cleanUrl = s;
    try { const u = new URL(s.includes("://") ? s : "https://" + s); cleanUrl = u.toString(); } catch (_) {}
    let shortLabel = "fb_post";
    const m = cleanUrl.match(
      /facebook\.com\/(?:groups\/([^/?#]+)\/posts\/(\d+)|permalink\/(\d+)|story\.php.*?story_fbid[=%3D]+(\d+)|([^/?#]+)\/posts\/(\d+)|([^/?#]+)\/videos\/(\d+))/i
    );
    if (m) {
      if (m[1] && m[2])     shortLabel = `grupo_${m[1]}_${m[2]}`;
      else if (m[3])         shortLabel = `permalink_${m[3]}`;
      else if (m[4])         shortLabel = `story_${m[4]}`;
      else if (m[5] && m[6]) shortLabel = `${m[5]}_${m[6]}`;
      else if (m[7] && m[8]) shortLabel = `video_${m[7]}_${m[8]}`;
    }
    return {
      type:      "fb_post",
      icon:      "💙",
      label:     "Post do Facebook",
      shortcode: shortLabel,
      fbUrl:     cleanUrl,
      platform:  "facebook",
      urlType:   "post",
    };
  }

  // ── Instagram post (/p/, /reel/, /tv/) ────────────────────────────────────
  const postMatch = s.match(/(?:instagram\.com|instagr\.am)\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (postMatch) {
    const rawType  = postMatch[1].toLowerCase();
    const urlType  = rawType === "reels" ? "reel" : rawType;
    const label    = urlType === "reel" ? "Reel" : urlType === "tv" ? "IGTV" : "Post";
    return {
      type:      "ig_post",
      icon:      urlType === "reel" ? "🎬" : "📸",
      label:     `${label} do Instagram`,
      shortcode: postMatch[2],
      urlType,
      platform:  "instagram",
    };
  }

  // ── Shortcode puro (11 chars base64) sem URL ──────────────────────────────
  if (/^[A-Za-z0-9_-]{10,12}$/.test(s)) {
    return {
      type:      "ig_post",
      icon:      "📸",
      label:     `Post do Instagram (shortcode: ${s})`,
      shortcode: s,
      urlType:   "p",
      platform:  "instagram",
    };
  }

  // ── Instagram profile URL ──────────────────────────────────────────────────
  const profileUrlMatch = s.match(/instagram\.com\/([\w.]+)\/?(?:[?#].*)?$/i);
  if (profileUrlMatch) {
    const username = profileUrlMatch[1];
    return { type: "ig_profile", icon: "👤", label: `Perfil @${username}`, username };
  }

  // ── @username ou username puro ────────────────────────────────────────────
  const clean = s.replace(/^@/, "");
  if (/^[\w.]+$/.test(clean) && clean.length >= 1) {
    return { type: "ig_profile", icon: "👤", label: `Perfil @${clean}`, username: clean };
  }

  return null;
}

/**
 * Retorna os botões de ação disponíveis para um tipo detectado.
 */
function getActions(detected) {
  if (detected.type === "ig_profile") {
    return [
      { id: "followers",       icon: "👥", label: "Seguidores",            color: "green" },
      { id: "profile",         icon: "📊", label: "Dados do perfil + Posts", color: "indigo" },
      { id: "profile_comments",icon: "💬", label: "Comentários dos posts", color: "blue" },
    ];
  }
  if (detected.type === "ig_post") {
    return [
      { id: "likes",    icon: "❤️", label: "Curtidas",    color: "red"  },
      { id: "comments", icon: "💬", label: "Comentários", color: "blue" },
    ];
  }
  if (detected.type === "fb_post") {
    return [
      { id: "fb_comments", icon: "💬", label: "Comentários", color: "blue" },
    ];
  }
  return [];
}

// ──────────────────────────────────────────────────────────────────────────────
// ESTADO GLOBAL DA EXTRAÇÃO
// ──────────────────────────────────────────────────────────────────────────────
let smDetected   = null;  // resultado de detectInput()
let smAction     = null;  // id da ação selecionada
let smRunning    = false;
let smPaused     = false;
let smKnownTotal = 0;

// ──────────────────────────────────────────────────────────────────────────────
// RENDERIZAÇÃO DO PAINEL DE OPÇÕES
// ──────────────────────────────────────────────────────────────────────────────
const ACTION_CONFIG = {
  followers:        { title: "Seguidores", barColor: "var(--green)", dlType: "DOWNLOAD",                 clearType: "CLEAR_DATA"  },
  likes:            { title: "Curtidas",   barColor: "#e53935",      dlType: "DOWNLOAD",                 clearType: "CLEAR_DATA"  },
  comments:         { title: "Comentários",barColor: "var(--blue)",  dlType: "DOWNLOAD",                 clearType: "CLEAR_DATA"  },
  fb_comments:      { title: "Comentários FB", barColor: "var(--blue)", dlType: "DOWNLOAD",              clearType: "CLEAR_DATA"  },
  profile:          { title: "Dados do perfil", barColor: "var(--blue)", dlType: "DOWNLOAD_PROFILE",     clearType: null          },
  profile_comments: { title: "Comentários dos posts", barColor: "var(--blue)", dlType: "DOWNLOAD_PROFILE_COMMENTS", clearType: null },
};

function renderOptions(actionId, detected) {
  const fields = $("smOptionsFields");
  const title  = $("smActionTitle");
  const cfg    = ACTION_CONFIG[actionId] || {};
  title.textContent = cfg.title || actionId;

  let html = "";
  if (actionId === "followers") {
    html = `
      <div class="sm-field">
        <label>Limite de seguidores</label>
        <input id="smLimit" type="number" value="0" min="0" step="500">
        <span class="small-hint">0 = extrair todos</span>
      </div>`;
  } else if (actionId === "likes") {
    html = `
      <div class="sm-field">
        <label>Limite de curtidas</label>
        <input id="smLimit" type="number" value="0" min="0" step="100">
        <span class="small-hint">Instagram limita ~1.000 por post</span>
      </div>`;
  } else if (actionId === "comments" || actionId === "fb_comments") {
    html = `
      <div class="sm-field">
        <label>Limite de comentários</label>
        <input id="smLimit" type="number" value="0" min="0" step="100">
        <span class="small-hint">0 = extrair todos</span>
      </div>`;
  } else if (actionId === "profile") {
    html = `
      <div class="sm-field">
        <label>Posts recentes a incluir</label>
        <input id="smLimit" type="number" value="12" min="0" max="200" step="12">
        <span class="small-hint">0 = somente dados do perfil, sem posts</span>
      </div>`;
  } else if (actionId === "profile_comments") {
    html = `
      <div class="sm-field">
        <label>Máx. posts a escanear</label>
        <input id="smLimit" type="number" value="0" min="0" step="10">
        <span class="small-hint">0 = todos os posts do perfil</span>
      </div>
      <div class="sm-field mt8">
        <label>Máx. comentários por post</label>
        <input id="smLimit2" type="number" value="0" min="0" step="100">
        <span class="small-hint">0 = todos os comentários</span>
      </div>`;
  }
  fields.innerHTML = html;

  // Ajusta cor da barra e do botão de iniciar
  const bar = $("smBar");
  if (bar) bar.style.background = cfg.barColor || "var(--green)";

  const btnStart = $("btnSmStart");
  if (btnStart) {
    // Cor do botão de acordo com a ação
    const colors = { followers:"green", likes:"red", comments:"blue", fb_comments:"blue", profile:"indigo", profile_comments:"blue" };
    btnStart.className = `btn btn-action-${colors[actionId] || "green"}`;
    btnStart.textContent = "▶ Iniciar";
  }
}

function resetProgress() {
  smKnownTotal = 0;
  $("smExtracted").textContent = "0";
  $("smTotal").textContent     = "—";
  $("smPpm").textContent       = "—";
  $("smEta").textContent       = "—";
  $("smPage").textContent      = "0";
  $("smDelay").textContent     = "—";
  $("smBar").style.width       = "0%";
  $("smPct").textContent       = "0%";
  $("smPct").classList.remove("done");
  $("smLabel").textContent     = "Aguardando…";
  $("smMeta").textContent      = "";
  $("smPoolStatus").textContent= "";
  // Esconde cards de resultado
  $("smProfileCard").style.display = "none";
  $("smPostsCard").style.display   = "none";
  $("smPcCard").style.display      = "none";
  $("btnSmDownload").disabled      = true;
  $("btnSmClearData").disabled     = true;
}

// ──────────────────────────────────────────────────────────────────────────────
// SMART INPUT — detecção ao digitar/colar
// ──────────────────────────────────────────────────────────────────────────────
const iSmartInput = $("iSmartInput");
let detectTimer = null;

iSmartInput.addEventListener("input", () => {
  clearTimeout(detectTimer);
  const val = iSmartInput.value.trim();
  $("btnSmartClear").style.display = val ? "flex" : "none";
  if (!val) { hideDetect(); return; }
  // Debounce 300ms para não flickar enquanto digita
  detectTimer = setTimeout(() => runDetect(val), 300);
});

iSmartInput.addEventListener("paste", () => {
  // Pegar valor após o paste terminar
  setTimeout(() => {
    const val = iSmartInput.value.trim();
    $("btnSmartClear").style.display = val ? "flex" : "none";
    if (val) runDetect(val);
  }, 50);
});

$("btnSmartClear").addEventListener("click", () => {
  iSmartInput.value = "";
  $("btnSmartClear").style.display = "none";
  hideDetect();
  hideBody();
  smDetected = null;
  smAction   = null;
});

function runDetect(val) {
  const detected = detectInput(val);
  smDetected = detected;
  smAction   = null;

  if (!detected) { hideDetect(); hideBody(); return; }

  // Mostra chip de detecção
  $("smartChipIcon").textContent = detected.icon;
  $("smartChipLabel").textContent = detected.label;
  $("smartDetect").classList.remove("hidden");

  // Renderiza botões de ação
  const actions = getActions(detected);
  const cont = $("smartActionBtns");
  cont.innerHTML = "";
  actions.forEach(a => {
    const btn = document.createElement("button");
    btn.className = `btn smart-action-btn sa-${a.color}`;
    btn.innerHTML = `${a.icon} ${a.label}`;
    btn.dataset.action = a.id;
    btn.addEventListener("click", () => selectAction(a.id, detected));
    cont.appendChild(btn);
  });

  // Se só há uma ação, seleciona automaticamente
  if (actions.length === 1) {
    selectAction(actions[0].id, detected);
  } else {
    hideBody();
  }
}

function hideDetect() {
  $("smartDetect").classList.add("hidden");
  $("smartActionBtns").innerHTML = "";
}

function hideBody() {
  $("smartBody").classList.add("hidden");
}

function selectAction(actionId, detected) {
  smAction   = actionId;
  smDetected = detected;

  // Marca botão ativo
  $("smartActionBtns").querySelectorAll(".smart-action-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.action === actionId);
  });

  // Renderiza opções e mostra corpo
  renderOptions(actionId, detected);
  resetProgress();
  $("smartBody").classList.remove("hidden");

  // Auto-scroll até o body
  $("smartBody").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ──────────────────────────────────────────────────────────────────────────────
// INICIAR / PAUSAR / PARAR
// ──────────────────────────────────────────────────────────────────────────────
function setRunning(running, paused = false) {
  smRunning = running;
  smPaused  = paused;
  $("btnSmStart").disabled = running;
  $("btnSmPause").disabled = !running;
  $("btnSmStop").disabled  = !running;
  $("btnSmPause").textContent = (running && paused) ? "▶ Continuar" : "⏸ Pausar";
  // Bloqueia input enquanto extrai
  iSmartInput.disabled = running;
  $("btnSmartClear").disabled = running;
}

$("btnSmStart").addEventListener("click", async () => {
  if (!smDetected || !smAction) return;

  const cfg = await getStoredConfig();
  const limit  = parseInt($("smLimit")?.value)  || 0;
  const limit2 = parseInt($("smLimit2")?.value) || 0;

  // Salva maxFollowers na config
  await sendMsg({ type: "SAVE_CONFIG", config: { ...cfg, maxFollowers: limit } });

  resetProgress();
  setRunning(true);

  const d = smDetected;
  let resp;

  if (smAction === "followers") {
    smLog(`Iniciando extração de seguidores de @${d.username}…`, "ok");
    $("smLabel").textContent = `Extraindo seguidores de @${d.username}…`;
    resp = await sendMsg({ type: "START", username: d.username });

  } else if (smAction === "likes") {
    smLog(`Iniciando extração de curtidas: ${d.shortcode}…`, "ok");
    $("smLabel").textContent = `Extraindo curtidas…`;
    resp = await sendMsg({ type: "START_LIKES", shortcode: d.shortcode });

  } else if (smAction === "comments") {
    smLog(`Iniciando extração de comentários: ${d.shortcode}…`, "ok");
    $("smLabel").textContent = `Extraindo comentários…`;
    resp = await sendMsg({ type: "START_COMMENTS", shortcode: d.shortcode, urlType: d.urlType, platform: "instagram" });

  } else if (smAction === "fb_comments") {
    smLog(`Iniciando extração de comentários Facebook…`, "ok");
    $("smLabel").textContent = `Extraindo comentários Facebook…`;
    resp = await sendMsg({ type: "START_COMMENTS", shortcode: d.shortcode, urlType: d.urlType, platform: "facebook", fbUrl: d.fbUrl });

  } else if (smAction === "profile") {
    smLog(`Iniciando scrape de perfil @${d.username}…`, "ok");
    $("smLabel").textContent = `Extraindo dados do perfil @${d.username}…`;
    resp = await sendMsg({ type: "SCRAPE_PROFILE", username: d.username, maxPosts: limit });

  } else if (smAction === "profile_comments") {
    smLog(`Iniciando extração de comentários dos posts de @${d.username}…`, "ok");
    $("smLabel").textContent = `Extraindo comentários dos posts de @${d.username}…`;
    $("smPcCard").style.display = "block";
    resp = await sendMsg({ type: "SCRAPE_PROFILE_COMMENTS", username: d.username, maxPosts: limit, maxPerPost: limit2 });
  }

  if (resp && !resp.ok) {
    smLog(resp.msg || "Erro ao iniciar.", "error");
    setRunning(false);
  }
});

$("btnSmPause").addEventListener("click", async () => {
  const action = smAction;
  if (action === "profile" || action === "profile_comments") {
    // Profile scrapers não têm pause — stop direto
    return;
  }
  const resp = await sendMsg({ type: "PAUSE" });
  if (resp.ok) {
    setRunning(smRunning, resp.paused);
    smLog(resp.paused ? "Pausado." : "Retomado.", resp.paused ? "warn" : "ok");
  }
});

$("btnSmStop").addEventListener("click", async () => {
  if (smAction === "profile") {
    await sendMsg({ type: "STOP_PROFILE" });
    setRunning(false);
    smLog("Extração de perfil parada.", "warn");
  } else if (smAction === "profile_comments") {
    await sendMsg({ type: "STOP_PROFILE_COMMENTS" });
    setRunning(false);
    smLog("Extração de comentários parada.", "warn");
  } else {
    const resp = await sendMsg({ type: "STOP" });
    setRunning(false);
    smLog(`Parado. ${resp.extracted?.toLocaleString("pt-BR") || 0} itens coletados.`, "warn");
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DOWNLOAD + LIMPAR
// ──────────────────────────────────────────────────────────────────────────────
$("btnSmDownload").addEventListener("click", async () => {
  if (!smAction) return;
  smLog("Gerando arquivo(s)…");

  let resp;
  if (smAction === "profile") {
    resp = await sendMsg({ type: "DOWNLOAD_PROFILE" });
    if (resp.ok) smLog(`✔ JSON salvo: ${resp.filename}`, "ok");
    else smLog(resp.msg || "Erro.", "error");

  } else if (smAction === "profile_comments") {
    resp = await sendMsg({ type: "DOWNLOAD_PROFILE_COMMENTS" });
    if (resp.ok) smLog(`✔ ${resp.files} arquivo(s) baixados — ${resp.count?.toLocaleString("pt-BR")} comentários.`, "ok");
    else smLog(resp.msg || "Erro.", "error");

  } else {
    resp = await sendMsg({ type: "DOWNLOAD" });
    if (resp.ok) smLog(`✔ CSV salvo: ${resp.filename} (${resp.count?.toLocaleString("pt-BR")} linhas)`, "ok");
    else smLog(resp.msg || "Erro.", "error");
  }
});

$("btnSmClearData").addEventListener("click", async () => {
  if (!confirm("Limpar dados extraídos?")) return;
  await sendMsg({ type: "CLEAR_DATA" });
  resetProgress();
  smLog("Dados limpos.");
});

// ──────────────────────────────────────────────────────────────────────────────
// MENSAGENS DO BACKGROUND — listener unificado
// ──────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {

  // ── Seguidores / curtidas / comentários (genérico) ──
  if (msg.type === "STATUS") {
    smLog(msg.msg);
    if (msg.total)      { smKnownTotal = msg.total; $("smTotal").textContent = msg.total.toLocaleString("pt-BR"); }
    if (msg.extracted != null) updateProgress(msg.extracted, msg.total || smKnownTotal);
    if (msg.poolStatus) $("smPoolStatus").textContent = msg.poolStatus;
  }

  if (msg.type === "PROGRESS") {
    updateProgress(msg.extracted, msg.total || smKnownTotal);
    if (msg.page)          $("smPage").textContent  = msg.page;
    if (msg.ppm)           $("smPpm").textContent   = msg.ppm;
    if (msg.etaSec >= 0)   $("smEta").textContent   = fmtEta(msg.etaSec);
    if (msg.adaptiveDelay) $("smDelay").textContent = msg.adaptiveDelay + "ms";
    if (msg.poolStatus)    $("smPoolStatus").textContent = msg.poolStatus;
    if (msg.ppm && msg.ppm > 0) {
      const spm = Math.round(parseFloat(msg.ppm) * 50);
      $("smMeta").textContent = `${msg.ppm} pág/min · ~${spm.toLocaleString("pt-BR")} itens/min`;
    }
    if (msg.logLine) smLog(msg.logLine);
  }

  if (msg.type === "DONE") {
    const extracted = msg.extracted || 0;
    updateProgress(extracted, msg.total || smKnownTotal, { done: true });
    if (msg.pages) $("smPage").textContent = msg.pages;
    $("smMeta").textContent = "";
    const unit = smAction === "likes" ? "curtidas" : smAction === "comments" || smAction === "fb_comments" ? "comentários" : "itens";
    smLog(`✔ Concluído! ${extracted.toLocaleString("pt-BR")} ${unit}.`, "ok");
    if (msg.limitedMsg) smLog(`⚠ ${msg.limitedMsg}`, "warn");
    setRunning(false);
    $("btnSmDownload").disabled  = false;
    $("btnSmClearData").disabled = false;
    loadHistory();
  }

  if (msg.type === "ERROR") {
    smLog(msg.msg, "error");
    $("smLabel").textContent = "Erro — veja o log";
    setRunning(false);
  }

  // ── Perfil (SCRAPE_PROFILE) ──
  if (msg.type === "PROFILE_STATUS") smLog(msg.msg);

  if (msg.type === "PROFILE_ERROR") {
    smLog(msg.msg, "error");
    setRunning(false);
  }

  if (msg.type === "PROFILE_DONE") {
    setRunning(false);
    const data = msg.data;
    smLog(`✔ Perfil extraído: @${data.username} · ${data.latestPosts?.length || 0} posts`, "ok");
    $("smLabel").textContent = `✔ @${data.username} — ${(data.followersCount || 0).toLocaleString("pt-BR")} seguidores`;
    $("smPct").textContent = "100%";
    $("smPct").classList.add("done");
    $("smBar").style.width = "100%";
    renderProfileCard(data);
    renderPostsList(data.latestPosts);
    $("btnSmDownload").disabled  = false;
    $("btnSmClearData").disabled = true;
  }

  // ── Comentários de todos os posts (SCRAPE_PROFILE_COMMENTS) ──
  if (msg.type === "PC_STATUS") smLog(msg.msg);

  if (msg.type === "PC_ERROR") {
    smLog(msg.msg, "error");
    setRunning(false);
  }

  if (msg.type === "PC_PROGRESS") {
    if (msg.logLine) smLog(msg.logLine);
    const badge = $("smPcBadge");
    if (badge) badge.textContent = (msg.totalComments || 0).toLocaleString("pt-BR");
    if ($("smPcTotal")) $("smPcTotal").textContent = (msg.totalComments || 0).toLocaleString("pt-BR");
    if ($("smPcPostProg")) $("smPcPostProg").textContent = `${msg.post || 0}/${msg.totalPosts || 0}`;
    const pct = msg.totalPosts > 0 ? Math.min(100, (msg.post / msg.totalPosts) * 100) : 0;
    if ($("smPcBar")) $("smPcBar").style.width = pct.toFixed(1) + "%";
  }

  if (msg.type === "PC_DONE") {
    setRunning(false);
    smLog(`✔ ${msg.totalComments?.toLocaleString("pt-BR") || 0} comentários de ${msg.totalPosts || 0} posts.`, "ok");
    const badge = $("smPcBadge");
    if (badge) badge.textContent = (msg.totalComments || 0).toLocaleString("pt-BR");
    if ($("smPcTotal")) $("smPcTotal").textContent = (msg.totalComments || 0).toLocaleString("pt-BR");
    if ($("smPcBar")) $("smPcBar").style.width = "100%";
    $("btnSmDownload").disabled  = false;
    $("btnSmClearData").disabled = true;
    loadHistory();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PROGRESSO
// ──────────────────────────────────────────────────────────────────────────────
function updateProgress(extracted, total, opts = {}) {
  const eff = total > 0 ? total : smKnownTotal;
  $("smExtracted").textContent = extracted.toLocaleString("pt-BR");
  if (eff > 0) { smKnownTotal = eff; $("smTotal").textContent = eff.toLocaleString("pt-BR"); }

  if (opts.done) {
    $("smBar").style.width  = "100%";
    $("smPct").textContent  = "100%";
    $("smPct").classList.add("done");
    $("smLabel").textContent = `✔ Concluído — ${extracted.toLocaleString("pt-BR")} itens`;
  } else if (eff > 0) {
    const pct = Math.min(100, (extracted / eff) * 100);
    $("smBar").style.width = pct.toFixed(1) + "%";
    $("smPct").textContent = pct.toFixed(1) + "%";
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// RENDERIZAÇÃO DO CARD DE PERFIL
// ──────────────────────────────────────────────────────────────────────────────
function renderProfileCard(data) {
  const card = $("smProfileCard");
  if (!card) return;
  card.style.display = "block";

  // Avatar placeholder (iniciais — CSP bloqueia CDN do Instagram)
  const ph = $("smAvatarPh");
  if (ph) {
    ph.textContent = (data.fullName || data.username || "?").charAt(0).toUpperCase();
    ph.style.display = "flex";
  }

  $("smFullName").textContent = data.fullName || data.username;
  $("smHandle").textContent   = `@${data.username}`;
  $("smBio").textContent      = data.biography || "";

  $("smPFollowers").textContent = (data.followersCount || 0).toLocaleString("pt-BR");
  $("smPFollowing").textContent = (data.followsCount   || 0).toLocaleString("pt-BR");
  $("smPPosts").textContent     = (data.postsCount      || 0).toLocaleString("pt-BR");

  const tagsRow = $("smTagsRow");
  tagsRow.innerHTML = "";
  const addTag = (label, cls) => {
    const span = document.createElement("span");
    span.className = `scrape-tag ${cls}`;
    span.textContent = label;
    tagsRow.appendChild(span);
  };
  if (data.isVerified)           addTag("✔ Verificado",      "green");
  if (data.isBusinessAccount)    addTag("🏢 Conta comercial",  "blue");
  if (data.isPrivate)            addTag("🔒 Privado",          "amber");
  if (data.businessCategoryName) addTag(data.businessCategoryName, "");
  if (data.contactEmail)         addTag(`✉ ${data.contactEmail}`, "");
  if (data.contactPhone)         addTag(`📞 ${data.contactPhone}`, "");

  const extDiv = $("smExtUrls");
  if (data.externalUrls?.length) {
    extDiv.innerHTML = data.externalUrls.map(u =>
      `<a class="scrape-ext-url" href="${esc(u)}" target="_blank">🔗 ${esc(u)}</a>`
    ).join("");
    extDiv.style.display = "block";
  } else {
    extDiv.style.display = "none";
  }
}

function renderPostsList(posts) {
  const postsCard = $("smPostsCard");
  const postsList = $("smPostsList");
  if (!postsCard || !postsList || !posts?.length) return;

  $("smPostsBadge").textContent = posts.length;
  postsCard.style.display = "block";
  postsList.innerHTML = "";

  posts.forEach(p => {
    const div = document.createElement("div");
    div.className = "scrape-post-item";
    const caption  = p.caption ? esc(p.caption.slice(0, 160)) : "<em style='color:var(--g5)'>sem legenda</em>";
    const typeIcon = p.type === "Video" ? "🎬" : p.type === "Sidecar" ? "🖼" : "📷";
    const dateStr  = p.timestamp ? new Date(p.timestamp).toLocaleDateString("pt-BR") : "—";
    const videoRow = p.videoViewCount > 0 ? `<span>👁 ${p.videoViewCount.toLocaleString("pt-BR")}</span>` : "";
    const hashRow  = p.hashtags?.length ? `<div style="font-size:11px;color:var(--green-dk);margin-top:3px">${p.hashtags.slice(0,5).map(h => esc(h)).join(" ")}</div>` : "";
    div.innerHTML = `
      <div class="scrape-post-type">${typeIcon} ${esc(p.type)}</div>
      <div class="scrape-post-body">
        <div class="scrape-post-caption">${caption}</div>
        <div class="scrape-post-meta">
          <span>❤ ${(p.likesCount||0).toLocaleString("pt-BR")}</span>
          <span>💬 ${(p.commentsCount||0).toLocaleString("pt-BR")}</span>
          ${videoRow}
          <span>📅 ${dateStr}</span>
        </div>
        ${hashRow}
        ${p.url ? `<a class="scrape-post-link" href="${esc(p.url)}" target="_blank">${esc(p.url.replace("https://",""))}</a>` : ""}
      </div>`;
    postsList.appendChild(div);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// PERFIS (aba)
// ──────────────────────────────────────────────────────────────────────────────
async function loadProfiles() {
  const resp  = await sendMsg({ type: "GET_PROFILES" });
  if (!resp.ok) return;
  const list  = $("profileList");
  const badge = $("profileCountBadge");
  badge.textContent = resp.profiles.length;

  list.innerHTML = "";
  if (!resp.profiles.length) { list.innerHTML = '<div class="muted">Nenhum perfil salvo.</div>'; return; }

  resp.profiles.forEach(p => {
    const div  = document.createElement("div");
    div.className = "profile-item";
    const date = p.capturedAt ? new Date(p.capturedAt).toLocaleString("pt-BR") : "—";
    div.innerHTML = `
      <div class="pi-num">${p.i + 1}</div>
      <div class="pi-info">
        <div class="pi-name">${esc(p.name || `Perfil ${p.i+1}`)}</div>
        <div class="pi-date">Capturado em ${date}</div>
      </div>
      <button class="pi-del" data-i="${p.i}" title="Excluir">✕</button>`;
    list.appendChild(div);
  });

  list.querySelectorAll(".pi-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      await sendMsg({ type: "DELETE_PROFILE", index: parseInt(btn.dataset.i) });
      await loadProfiles();
    });
  });

  // Dica turbo na aba de extração
  const hint = $("smTurboHint");
  if (hint) {
    hint.textContent = resp.profiles.length >= 2
      ? `⚡ ${resp.profiles.length} contas ativas — modo turbo disponível`
      : "";
  }
}

$("btnCapture").addEventListener("click", async () => {
  const name = $("iProfileName").value.trim();
  const resp = await sendMsg({ type: "CAPTURE_COOKIES", name });
  if (resp.ok) {
    smLog(`✔ Perfil "${name || `Perfil ${resp.count}`}" salvo.`);
    $("iProfileName").value = "";
    await loadProfiles();
  }
});

$("btnImportCookie").addEventListener("click", async () => {
  const raw    = $("iCookiePaste").value.trim();
  const name   = $("iPasteName").value.trim();
  const result = $("importResult");
  if (!raw) { result.textContent = "Cole o cookie string antes de importar."; result.className = "import-result error"; result.classList.remove("hidden"); return; }
  const resp = await sendMsg({ type: "IMPORT_COOKIE", raw, name });
  result.classList.remove("hidden");
  if (resp.ok) {
    result.textContent = `✔ ${resp.msg}`;
    result.className   = "import-result ok";
    $("iCookiePaste").value = "";
    $("iPasteName").value   = "";
    await loadProfiles();
  } else {
    result.textContent = `✗ ${resp.msg}`;
    result.className   = "import-result error";
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// HISTÓRICO (aba)
// ──────────────────────────────────────────────────────────────────────────────
async function loadHistory() {
  const resp = await sendMsg({ type: "GET_HISTORY" });
  if (!resp.ok) return;
  const list = $("historyList");
  list.innerHTML = "";

  if (!resp.history.length) { list.innerHTML = '<div class="muted">Nenhuma extração concluída ainda.</div>'; return; }

  resp.history.forEach(h => {
    const div   = document.createElement("div");
    div.className = "history-item";
    const date  = new Date(h.date).toLocaleString("pt-BR");
    const dur   = h.durationSec ? fmtEta(h.durationSec) : "—";
    const pct   = h.total > 0 ? `${((h.count / h.total) * 100).toFixed(1)}%` : "100%";
    const isFb  = h.platform === "facebook";
    const typeIcon  = h.type === "likes" ? "❤️" : h.type === "comments" ? (isFb ? "💙💬" : "💬") : "📊";
    const typeLabel = h.type === "likes" ? "curtidas" : h.type === "comments" ? "comentários" : "seguidores";
    const statusBadge = h.type === "stopped" ? '<span style="color:#e53e3e;font-size:11px">interrompida</span>'
      : h.type === "likes"    ? '<span style="color:#e53935;font-size:11px">curtidas</span>'
      : h.type === "comments" && isFb ? '<span style="color:#1877f2;font-size:11px">comentários FB</span>'
      : h.type === "comments" ? '<span style="color:#3182ce;font-size:11px">comentários</span>'
      : '';
    const isPost = h.type === "likes" || h.type === "comments";
    const displayName  = isPost ? (h.originalUrl ? h.originalUrl.replace(/^https?:\/\//, "").replace(/\?.*$/, "") : h.username) : `@${h.username}`;
    const rerunValue   = h.originalUrl || h.username;

    div.innerHTML = `
      <div class="hi-icon">${typeIcon}</div>
      <div class="hi-info">
        <div class="hi-username">${esc(displayName)} ${statusBadge}</div>
        <div class="hi-meta">${date} · ${h.pages||"—"} páginas · duração ${dur} · ${pct} do total</div>
      </div>
      <div>
        <div class="hi-count">${h.count.toLocaleString("pt-BR")}</div>
        <div class="hi-count-lbl">${typeLabel}</div>
      </div>
      <div class="hi-actions">
        <button class="btn ghost" style="font-size:12px" data-rerun="${esc(rerunValue)}" data-rerun-type="${esc(h.type||"followers")}">↻ Reextrair</button>
        <button class="hi-del" data-id="${h.id}">🗑 Excluir</button>
      </div>`;
    list.appendChild(div);
  });

  list.querySelectorAll("[data-rerun]").forEach(btn => {
    btn.addEventListener("click", () => reRunHistory(btn.dataset.rerun, btn.dataset.rerunType));
  });

  list.querySelectorAll(".hi-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      await sendMsg({ type: "DELETE_HISTORY", id: parseInt(btn.dataset.id) });
      await loadHistory();
    });
  });
}

/**
 * Preenche o smart input com o valor do histórico e dispara detecção.
 * O usuário pode ajustar e clicar em Iniciar.
 */
function reRunHistory(value, type = "followers") {
  // Navega para a aba de extração
  document.querySelectorAll(".htab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelector('[data-tab="extract"]').classList.add("active");
  $("tab-extract").classList.add("active");

  // Preenche o input
  iSmartInput.value = type === "followers" ? `@${value.replace(/^@/, "")}` : value;
  $("btnSmartClear").style.display = "flex";
  runDetect(iSmartInput.value);
}

// ──────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÕES (aba)
// ──────────────────────────────────────────────────────────────────────────────
async function loadConfig() {
  const cfg = await getStoredConfig();
  $("cfgDelay").value  = cfg.delayMs     ?? 1200;
  $("cfgRotate").value = cfg.rotateAfter ?? 4;
  const presetBtns = document.querySelectorAll(".preset-btn");
  presetBtns.forEach(b => b.classList.remove("active"));
  const match = [...presetBtns].find(b =>
    parseInt(b.dataset.delay) === (cfg.delayMs ?? 1200) &&
    parseInt(b.dataset.rotate) === (cfg.rotateAfter ?? 4)
  );
  if (match) match.classList.add("active");
}

$("btnSaveConfig").addEventListener("click", async () => {
  const config = {
    delayMs:      parseInt($("cfgDelay").value)  || 1200,
    rotateAfter:  parseInt($("cfgRotate").value) ?? 4,
    maxFollowers: 0,
  };
  await sendMsg({ type: "SAVE_CONFIG", config });
  const ok = $("cfgSaved");
  ok.classList.remove("hidden");
  setTimeout(() => ok.classList.add("hidden"), 2000);
});

document.querySelectorAll(".preset-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const config = {
      delayMs:      parseInt(btn.dataset.delay),
      rotateAfter:  parseInt(btn.dataset.rotate),
      maxFollowers: 0,
    };
    await sendMsg({ type: "SAVE_CONFIG", config });
    $("cfgDelay").value  = config.delayMs;
    $("cfgRotate").value = config.rotateAfter;
    const ok = $("cfgSaved");
    ok.classList.remove("hidden");
    setTimeout(() => ok.classList.add("hidden"), 1500);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────────────────────
(async () => {
  await loadConfig();
  await loadProfiles();

  // Verifica se há extração em andamento
  const resp = await sendMsg({ type: "GET_STATUS" });
  if (resp.ok && resp.running) {
    // Reconstrói estado mínimo para exibir progresso
    const username = resp.username || "";
    iSmartInput.value = username.includes("instagram.com") || username.includes("facebook.com")
      ? username : `@${username}`;
    $("btnSmartClear").style.display = "flex";
    runDetect(iSmartInput.value);
    // Seleciona ação mais provável (seguidores por padrão)
    if (smDetected) selectAction("followers", smDetected);
    setRunning(true, resp.paused);
    if (resp.extracted > 0) {
      $("smExtracted").textContent = resp.extracted.toLocaleString("pt-BR");
      updateProgress(resp.extracted, 0);
    }
    $("smLabel").textContent = `Extração em andamento…`;
    smLog(`Aba reaberta — extração em curso: ${resp.extracted?.toLocaleString("pt-BR") || 0} itens.`, "warn");
  }
})();
