// Spider Mobiliza v2.9 — background.js (Service Worker)

const IG_APP_ID = "936619743392459";
const ASBD_ID   = "129477";
const TAB_URL   = "tab.html";

// ---------------------------------------------------------------------------
// Abre / foca a aba da extensão ao clicar no ícone
// ---------------------------------------------------------------------------
chrome.action.onClicked.addListener(async () => {
  const fullUrl = chrome.runtime.getURL(TAB_URL);
  const existing = await chrome.tabs.query({ url: fullUrl });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: fullUrl });
  }
});

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
const state = {
  running:        false,
  paused:         false,
  username:       "",
  userId:         "",
  followers:      [],
  cursor:         null,
  page:           0,
  startedAt:      0,
  meta:           null,
  extractionType: "followers", // "followers" | "likes" | "comments"
  urlType:        "p",         // "p" | "reel" | "tv" — tipo de mídia (usado no warm-up e referer)
  platform:       "instagram", // "instagram" | "facebook"
  fbUrl:          null,        // URL completa do post FB (quando platform=facebook)

  // Configurações (carregadas do storage)
  delayMs:      500,
  rotateAfter:  1,       // 1 = troca a cada página (turbo)
  maxFollowers: 0,

  // Pool de contas com cooldown individual
  accountPool:  [],      // [{profile, name, cooldownUntil, totalRequests, errors, wwwClaim}]
  poolIndex:    0,

  // Adaptativo
  adaptiveDelay:  500,
  successStreak:  0,

  // Métricas de velocidade
  pageTimestamps: [],    // últimas 10 timestamps de páginas completas
};

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
const sleep  = ms => new Promise(r => setTimeout(r, ms));

// Jitter ±40% com 8% de chance de pausa extra longa (simula usuário distraído)
// Comportamento humano: o timing varia muito — às vezes rápido, às vezes demorado
const jitter = ms => {
  const base = Math.round(ms * (0.6 + Math.random() * 0.8)); // ±40% do delay base
  return Math.random() < 0.08 ? Math.round(base * (1.5 + Math.random() * 1.5)) : base;
};

// Aguarda `ms` milissegundos mantendo o service worker vivo.
// MV3: o Chrome mata o SW após ~30s de inatividade. Cada chamada à chrome API
// reseta esse timer. Dormimos em chunks de 20s + ping ao storage → SW nunca morre.
// onTick(secsLeft) é chamado a cada chunk para exibir contagem regressiva no log.
async function sleepKeepAlive(ms, onTick) {
  const deadline = Date.now() + ms;
  while (state.running) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(20000, remaining));          // chunk máximo de 20s
    await chrome.storage.local.get("_ka").catch(() => {}); // ping → reseta timer 30s
    if (onTick) {
      const secsLeft = Math.ceil((deadline - Date.now()) / 1000);
      if (secsLeft > 0) onTick(secsLeft);
    }
  }
}

async function getConfig() {
  const s = await chrome.storage.local.get("config");
  return s.config || {};
}

async function getProfiles() {
  const s = await chrome.storage.local.get("profiles");
  return s.profiles || [];
}

// ---------------------------------------------------------------------------
// Métricas de velocidade
// ---------------------------------------------------------------------------
function recordPageTime() {
  const now = Date.now();
  state.pageTimestamps.push(now);
  if (state.pageTimestamps.length > 12) state.pageTimestamps.shift();
}

function getSpeedStats() {
  const pts = state.pageTimestamps;
  if (pts.length < 2) return { ppm: 0, spm: 0, etaSec: 0 };
  const elapsed = pts[pts.length - 1] - pts[0];
  const pages   = pts.length - 1;
  const ppm     = (pages / elapsed) * 60000;          // páginas por minuto
  const spm     = Math.round(ppm * 50);                 // seguidores estimados/min (50 por página)
  return { ppm: ppm.toFixed(1), spm, elapsed };
}

// ---------------------------------------------------------------------------
// Pool de contas — seleciona próxima disponível
// ---------------------------------------------------------------------------
function getNextAccount() {
  const now = Date.now();
  const pool = state.accountPool;
  if (!pool.length) return null;

  // Procura disponível a partir do índice atual (round-robin)
  for (let i = 0; i < pool.length; i++) {
    const idx = (state.poolIndex + i) % pool.length;
    if (pool[idx].cooldownUntil <= now) {
      state.poolIndex = (idx + 1) % pool.length;
      return pool[idx];
    }
  }

  // Todas em cooldown — espera a que termina primeiro
  const earliest = pool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b);
  const wait = earliest.cooldownUntil - now;
  return { waitMs: wait, account: earliest };
}

// ---------------------------------------------------------------------------
// Troca cookies para a conta selecionada
// ---------------------------------------------------------------------------
async function applyCookies(profile) {
  if (!profile?.cookies) return;
  // Limpa cookies de ambos os domínios: ".instagram.com" (com ponto) e "instagram.com" (sem ponto)
  // Alguns cookies são definidos no domínio sem ponto e precisam ser removidos separadamente.
  const [existing, existing2] = await Promise.all([
    chrome.cookies.getAll({ domain: ".instagram.com" }),
    chrome.cookies.getAll({ domain: "instagram.com" }),
  ]);
  for (const c of [...existing, ...existing2]) {
    await chrome.cookies.remove({
      url:  `https://${c.domain.replace(/^\./, "")}${c.path}`,
      name: c.name,
    }).catch(() => {});
  }
  for (const c of profile.cookies) {
    await chrome.cookies.set({
      url:      "https://www.instagram.com/",
      name:     c.name,
      value:    c.value,
      domain:   c.domain  || ".instagram.com",
      path:     c.path    || "/",
      secure:   c.secure  ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: c.sameSite || "no_restriction",
      expirationDate: c.expirationDate,
    }).catch(() => {});
  }
}

async function captureCurrentCookies() {
  const cookies = await chrome.cookies.getAll({ domain: ".instagram.com" });
  return cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain,
    path: c.path, secure: c.secure, httpOnly: c.httpOnly,
    sameSite: c.sameSite, expirationDate: c.expirationDate,
  }));
}

// ---------------------------------------------------------------------------
// Executa fetch DENTRO de uma aba do Instagram (cookies completos garantidos)
// O service worker não tem acesso às cookies da sessão do browser — esta
// abordagem injeta o fetch na própria página do Instagram via scripting API.
// ---------------------------------------------------------------------------
let igTabId         = null; // aba do Instagram reutilizada durante a extração
let igWwwClaim      = "0";  // x-ig-www-claim — Instagram envia x-ig-set-www-claim e espera receber de volta
let currentIgAccount = null; // conta atualmente fazendo requests — mantém wwwClaim por conta no pool
let fbTabId         = null; // aba do Facebook reutilizada durante extração de comentários FB

// Aguarda aba atingir status "complete" (timeout padrão 12s)
async function waitForTabComplete(tabId, timeout = 12000) {
  return new Promise(resolve => {
    let done  = false;
    let timer = null;
    const listener = (tId, info) => {
      if (tId === tabId && info.status === "complete") finish();
    };
    // finish() remove o onUpdated SEMPRE — inclusive no timeout. Antes o
    // removeListener só rodava no caminho de sucesso; toda espera que estourava
    // (cada rotação de conta recarrega a aba e chama esta função) deixava um
    // listener órfão disparando pra sempre em todo update de aba. Vazava.
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(finish, timeout);
  });
}

// Verifica se a aba do Instagram está autenticada.
// 1. Checa a URL (login explícito / challenge)
// 2. chrome.cookies.get lê httpOnly cookies — document.cookie NÃO consegue (httpOnly invisível para JS)
async function checkTabAuth(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    if (url.includes("/accounts/login/") || url.includes("/accounts/emailsignup/") || url.includes("/challenge/")) {
      return false;
    }
    // Verifica sessionid via chrome.cookies (única forma de ler cookies httpOnly no SW)
    const sessionCookie = await chrome.cookies.get({ url: "https://www.instagram.com/", name: "sessionid" });
    return !!sessionCookie;
  } catch {
    return false;
  }
}

async function getIgTab() {
  // Reutiliza aba já conhecida se ainda existir e estiver completa
  if (igTabId !== null) {
    const tabs = await chrome.tabs.query({});
    const still = tabs.find(t => t.id === igTabId && t.url?.includes("instagram.com"));
    if (still) {
      if (still.status !== "complete") {
        await waitForTabComplete(igTabId);
        await sleep(500);
      }
      return igTabId;
    }
    igTabId = null;
  }
  // Procura aba existente do Instagram
  const igTabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  if (igTabs.length) {
    igTabId = igTabs[0].id;
    if (igTabs[0].status !== "complete") {
      await waitForTabComplete(igTabId);
      await sleep(500);
    }
    return igTabId;
  }
  // Abre aba em segundo plano
  broadcast("STATUS", { msg: "Abrindo aba do Instagram em segundo plano…" });
  const tab = await chrome.tabs.create({ url: "https://www.instagram.com/", active: false });
  igTabId = tab.id;
  await waitForTabComplete(igTabId, 15000);
  await sleep(1200); // aguarda scripts da página inicializarem
  return igTabId;
}

// Função injetada na aba do Instagram — roda com cookies completos da sessão.
// IMPORTANTE: deve ter try/catch global — se jogar exceção, executeScript retorna
// undefined e o background não consegue detectar o erro real.
// wwwClaim: token x-ig-www-claim do request anterior (Instagram retorna x-ig-set-www-claim)
// referer:  URL de onde veio a navegação (simula comportamento real do browser)
async function _igFetch(url, wwwClaim, referer) {
  try {
    const cookies   = document.cookie;
    const csrfMatch = cookies.match(/csrftoken=([^;]+)/);
    const csrf      = csrfMatch ? csrfMatch[1] : "";

    if (!csrf) {
      return { ok: false, status: 0, error: "csrftoken não encontrado em document.cookie — cookies não aplicados?" };
    }

    // Device ID do localStorage — Instagram usa para identificar dispositivo.
    // Ausência deste header é sinal de automação; lemos direto do localStorage da aba.
    const igDid = (typeof localStorage !== 'undefined')
      ? (localStorage.getItem('ig_did') || localStorage.getItem('ig-did') || '')
      : '';

    const resp = await fetch(url, {
      method:      "GET",
      credentials: "include",
      headers: {
        "accept":           "*/*",
        "accept-language":  "pt-BR,pt;q=0.9,en;q=0.7",
        "x-csrftoken":      csrf,
        "x-ig-app-id":      "936619743392459",
        "x-asbd-id":        "129477",
        "x-ig-www-claim":   wwwClaim || "0",
        "x-ig-device-id":   igDid,
        "x-requested-with": "XMLHttpRequest",
        "sec-fetch-dest":   "empty",
        "sec-fetch-mode":   "cors",
        "sec-fetch-site":   "same-origin",
        "referer":          referer || "https://www.instagram.com/",
      },
    });

    const status = resp.status;

    // Captura x-ig-set-www-claim da resposta — Instagram envia token atualizado
    // que DEVE ser enviado de volta na próxima requisição. Ignorar = sinal de bot.
    const newWwwClaim = resp.headers.get("x-ig-set-www-claim") || null;

    if (!resp.ok) return { ok: false, status, newWwwClaim };

    // Detecta resposta HTML (redirect para login ou erro do Instagram)
    // Isso acontece quando a sessão é inválida e o Instagram redireciona.
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      return { ok: false, status: 401, htmlResponse: true, newWwwClaim };
    }

    const json = await resp.json();
    return { ok: true, status, json, newWwwClaim };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

async function igFetch(url, referer = "https://www.instagram.com/") {
  const tabId = await getIgTab();
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func:   _igFetch,
      args:   [url, igWwwClaim, referer],  // passa claim atual e referer correto
    });
  } catch (e) {
    // Invalida a aba memorizada — pode estar num estado ruim
    igTabId = null;
    throw new Error(`Scripting falhou: ${e.message}. Abra uma aba do Instagram.`);
  }
  const result = results?.[0]?.result;
  if (!result) {
    // Script não retornou nada — provavelmente aba em estado inválido
    igTabId = null;
    throw new Error("Script não respondeu na aba do Instagram — aba pode estar em página restrita. Recarregue instagram.com.");
  }
  // Atualiza o claim se Instagram enviou um novo — crítico para não ser detectado como bot
  // Também salva no objeto da conta atual para preservar entre rotações de pool.
  if (result.newWwwClaim) {
    igWwwClaim = result.newWwwClaim;
    if (currentIgAccount) currentIgAccount.wwwClaim = result.newWwwClaim;
  }

  if (result.htmlResponse) {
    // Instagram devolveu HTML — sessão inválida ou expirada
    broadcast("STATUS", { msg: "⚠ Instagram devolveu página HTML — sessão inválida. Recapture ou reimporte os cookies desta conta." });
    throw Object.assign(new Error("AUTH_FAIL"), { status: 401 });
  }
  if (result.error) {
    broadcast("STATUS", { msg: `[FETCH-ERR] ${result.error}` });
    throw new Error(`Fetch falhou: ${result.error}`);
  }
  if (result.status === 429) throw Object.assign(new Error("RATE_LIMIT"), { status: 429 });
  if (result.status === 401) throw Object.assign(new Error("AUTH_FAIL"),  { status: 401 });
  if (!result.ok) throw new Error(`HTTP ${result.status}`);
  return result.json;
}

// ---------------------------------------------------------------------------
// API: resolve username → userId + meta
// ---------------------------------------------------------------------------
async function resolveUserId(username) {
  const url  = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const json = await igFetch(url);
  const u    = json?.data?.user;
  if (!u) throw new Error("Perfil não encontrado ou privado");
  return {
    userId:           u.id,
    fullname:         u.full_name || "",
    followers:        u.edge_followed_by?.count ?? u.follower_count ?? 0,
    following:        u.edge_follow?.count      ?? u.following_count ?? 0,
    posts:            u.edge_owner_to_timeline_media?.count ?? u.media_count ?? 0,
    isPrivate:        u.is_private ?? false,
    // Retornado pela API quando a conta extratora é autenticada:
    followedByViewer: u.friendship_status?.following ?? u.followed_by_viewer ?? null,
  };
}

// ---------------------------------------------------------------------------
// API: retorna username + fullname da conta atualmente logada nos cookies
// Útil para diagnosticar se a conta de extração é a que o usuário espera.
// ---------------------------------------------------------------------------
async function getCurrentUser() {
  try {
    const url  = `https://www.instagram.com/api/v1/accounts/current_user/?edit=true`;
    const json = await igFetch(url, `https://www.instagram.com/`);
    const u    = json?.user;
    return u ? { username: u.username, fullname: u.full_name, pk: u.pk } : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API: verifica relação de followship entre conta extratora e alvo
// Endpoint mais confiável que o campo friendship_status do web_profile_info.
// ---------------------------------------------------------------------------
async function checkFollowship(userId) {
  try {
    const url  = `https://www.instagram.com/api/v1/friendships/show/${userId}/`;
    const json = await igFetch(url, `https://www.instagram.com/`);
    return {
      following:         !!json.following,
      followedBy:        !!json.followed_by,
      blocking:          !!json.blocking,
      isPrivate:         !!json.is_private,
      incomingRequest:   !!json.incoming_request,
      outgoingRequest:   !!json.outgoing_request,
    };
  } catch (_) {
    return null; // não bloqueia extração se falhar
  }
}

// ---------------------------------------------------------------------------
// Gera UUID v4 para rank_token (obrigatório nas requisições de paginação)
// ---------------------------------------------------------------------------
function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ---------------------------------------------------------------------------
// API: busca página de seguidores
// Tenta três estratégias de cursor para cobrir todas as versões da API
// ---------------------------------------------------------------------------
async function fetchPage(userId, cursor, rankToken, username) {
  // rank_token UUID é obrigatório em todas as requisições — inclusive a primeira
  let url = `https://www.instagram.com/api/v1/friendships/${userId}/followers/?count=50&search_surface=follow_list_page&rank_token=${encodeURIComponent(rankToken)}`;
  if (cursor) url += `&max_id=${encodeURIComponent(cursor)}`;

  // Referer correto: usuário real estaria na página de seguidores do perfil alvo
  const referer = username
    ? `https://www.instagram.com/${username}/followers/`
    : "https://www.instagram.com/";

  const json  = await igFetch(url, referer);
  const users = json.users || [];

  // ── Aviso: Instagram limitando lista de seguidores ────────────────────────
  // should_limit_list_of_followers=true significa que a conta usada não segue
  // o perfil alvo, ou o perfil tem restrições de privacidade ativas.
  // A paginação pode continuar, mas o total visível será reduzido.
  if (json.should_limit_list_of_followers) {
    broadcast("STATUS", {
      msg: `⚠ Instagram limitando lista (should_limit_list_of_followers=true). `
         + `Para ver TODOS os seguidores, a conta de extração precisa SEGUIR o perfil alvo. Tentando paginar mesmo assim…`,
    });
  }

  // ── Detecta cursor ─────────────────────────────────────────────────────────
  // O Instagram atual retorna has_more=false mas muda o follow_ranking_token
  // a cada página — esse token É o cursor real para a próxima requisição.
  // Paramos quando: 0 usuários retornados OU token igual ao anterior.
  // IMPORTANTE: aceitamos páginas com < 50 usuários para suportar o modo
  // "should_limit_list_of_followers" e a última página de extrações normais.

  const nmi   = json.next_max_id;
  const token = json.follow_ranking_token || null;

  let nextCursor = null;

  // Prioridade 1: next_max_id explícito (formato antigo)
  if (nmi !== null && nmi !== undefined && nmi !== "" && nmi !== 0 && nmi !== false) {
    nextCursor = String(nmi);
  }
  // Prioridade 2: follow_ranking_token mudou E há usuários → tenta próxima página
  // (Relaxado: aceita pages < 50 para contas limitadas e últimas páginas normais)
  else if (token && token !== cursor && users.length > 0) {
    nextCursor = token;
  }
  // Prioridade 3: has_more=true + pk do último usuário (fallback legado)
  else if (json.has_more && users.length > 0) {
    nextCursor = String(users[users.length - 1].pk);
  }
  // Sem cursor: 0 usuários ou token repetido → fim real da listagem

  return {
    users,
    nextCursor,
    limitedList: !!json.should_limit_list_of_followers,
    rankToken: token || rankToken,
  };
}

// ---------------------------------------------------------------------------
// Converte usuário para linha CSV (seguidores/curtidas)
// ---------------------------------------------------------------------------
function toRow(u) {
  return {
    "User Id":         u.pk || u.id || "",
    "Username":        u.username   || "",
    "Fullname":        u.full_name  || "",
    "Followed by you": u.followed_by_viewer ? "YES" : "NO",
    "Followers":       u.follower_count  ?? u.edge_followed_by?.count ?? "",
    "Following":       u.following_count ?? u.edge_follow?.count      ?? "",
    "Posts":           u.media_count     ?? u.edge_owner_to_timeline_media?.count ?? "",
    "Public Email":    "",
    "Contact Phone":   "",
    "City":            "",
    "Street Address":  "",
    "Is private":      u.is_private  ? "YES" : "NO",
    "Is verified":     u.is_verified ? "YES" : "NO",
    "Is business":     u.is_business ? "YES" : "NO",
    "External URL":    u.external_url || "",
    "Bio":             u.biography || u.bio || "",
    "Profile URL":     `https://www.instagram.com/${u.username}/`,
    "Avatar URL":      u.profile_pic_url || "",
  };
}

// ---------------------------------------------------------------------------
// Converte comentário (API privada) para linha CSV
// ---------------------------------------------------------------------------
function toCommentRow(comment, parentId = "") {
  const ts   = comment.created_at_utc ?? comment.created_at ?? null;
  const date = ts ? new Date(ts * 1000).toLocaleString("pt-BR") : "";
  return {
    "Comment Id":  comment.pk                      || "",
    "Parent Id":   parentId,                         // vazio = top-level; preenchido = resposta
    "Username":    comment.user?.username           || "",
    "User Id":     comment.user?.pk                || "",
    "Comment":     comment.text                    || "",
    "Date":        date,
    "Profile URL": comment.user?.username
      ? `https://www.instagram.com/${comment.user.username}/`
      : "",
    "Avatar URL":  comment.user?.profile_pic_url   || "",
  };
}

// ---------------------------------------------------------------------------
// Broadcast para a aba
// ---------------------------------------------------------------------------
function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Delay adaptativo: reduz se sucesso, aumenta no rate-limit
// ---------------------------------------------------------------------------
function onSuccess() {
  state.successStreak++;
  if (state.successStreak >= 5) {
    // Floor: nunca vai abaixo de 70% do delay configurado pelo usuário
    // Garante que o preset escolhido define o teto inferior de velocidade
    const floor = Math.round(state.delayMs * 0.7);
    state.adaptiveDelay = Math.max(floor, Math.round(state.adaptiveDelay * 0.93));
    state.successStreak = 0;
  }
}
function onRateLimit(account) {
  state.successStreak = 0;
  state.adaptiveDelay = Math.min(8000, Math.round(state.adaptiveDelay * 1.6));
  if (account) {
    account.cooldownUntil = Date.now() + 60000; // conta em cooldown por 60s
    account.errors++;
  }
}

// ---------------------------------------------------------------------------
// Motor principal de extração
// ---------------------------------------------------------------------------
async function runExtraction() {
  // Carrega config
  const cfg = await getConfig();
  state.delayMs      = cfg.delayMs      ?? 1200;  // default: Balanceado
  state.rotateAfter  = cfg.rotateAfter  ?? 4;     // default: troca a cada 4 páginas
  state.maxFollowers = cfg.maxFollowers ?? 0;
  state.adaptiveDelay = state.delayMs;

  // Monta pool de contas
  const profiles = await getProfiles();
  state.accountPool = profiles.map((p, i) => ({
    profile:       p,
    name:          p.name || `Perfil ${i + 1}`,
    cooldownUntil: 0,
    totalRequests: 0,
    errors:        0,
    wwwClaim:      "0", // claim preservado entre rotações — evita enviar "0" em conta já ativa
  }));
  // poolIndex começa em 1: pool[0] é aplicado explicitamente abaixo,
  // então a primeira rotação deve pegar pool[1], não pool[0] de novo.
  state.poolIndex = 1;

  const usePool = state.accountPool.length > 0;

  // Aplica primeira conta do pool se disponível e garante que a aba recarregue
  if (usePool) {
    currentIgAccount = state.accountPool[0];
    await applyCookies(state.accountPool[0].profile);
    igWwwClaim = "0"; // reseta claim — nova conta, novo token
    // Força navegação da aba do Instagram para carregar com os novos cookies.
    // Sem isso, o Instagram detecta a troca de sessionid e redireciona
    // assincronamente — e o executeScript no meio da navegação retorna undefined.
    try {
      const existingTabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
      if (existingTabs.length) {
        igTabId = existingTabs[0].id;
        await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
        broadcast("STATUS", { msg: "Recarregando aba do Instagram com nova conta…" });
        await waitForTabComplete(igTabId, 15000);
        await sleep(1200);
      }
    } catch (_) {}
  }

  // ── Warm-up de sessão ──────────────────────────────────────────────────────
  // Visita o perfil alvo antes de qualquer chamada de API.
  // Usuário real navega ao perfil → vê foto/bio → clica em Seguidores.
  // Pular esta etapa é um sinal forte de automação.
  broadcast("STATUS", { msg: `Carregando perfil @${state.username}…` });
  try {
    const warmTabId = igTabId !== null ? igTabId : await getIgTab();
    igTabId = warmTabId;
    await chrome.tabs.update(warmTabId, { url: `https://www.instagram.com/${state.username}/` });
    await waitForTabComplete(warmTabId, 12000);
    await sleep(1500 + Math.random() * 2500); // 1.5–4s "lendo" o perfil
  } catch (_) {}

  // Resolve username
  broadcast("STATUS", { msg: `Resolvendo @${state.username}…` });
  let meta;
  try {
    meta = await resolveUserId(state.username);
    state.userId = meta.userId;
    state.meta = meta;
  } catch (e) {
    broadcast("ERROR", { msg: `Erro ao resolver perfil: ${e.message}` });
    state.running = false;
    await saveState();
    return;
  }

  broadcast("STATUS", {
    msg: `@${state.username} — ${meta.followers.toLocaleString("pt-BR")} seguidores detectados`,
    total: meta.followers,
    userId: meta.userId,
  });

  // ── Diagnóstico de conta + followship ───────────────────────────────────
  // Identifica qual conta está nos cookies e se ela segue o alvo.
  // should_limit_list_of_followers=true ocorre quando a conta extratora
  // NÃO segue o alvo OU tem trust score baixo (conta nova/suspeita).
  broadcast("STATUS", { msg: `Identificando conta de extração e relação com @${state.username}…` });
  const [currentUser, friendship] = await Promise.all([
    getCurrentUser(),
    checkFollowship(meta.userId),
  ]);

  // Mostra qual conta está logada (essencial para diagnosticar mismatch)
  if (currentUser) {
    broadcast("STATUS", {
      msg: `👤 Conta de extração identificada: @${currentUser.username}${currentUser.fullname ? ` (${currentUser.fullname})` : ""}`,
    });
  } else {
    broadcast("STATUS", { msg: `⚠ Não foi possível identificar a conta de extração — cookies podem estar inválidos.` });
  }

  if (friendship !== null) {
    if (!friendship.following) {
      broadcast("STATUS", {
        msg: `⚠ AVISO: @${currentUser?.username || "conta extratora"} NÃO segue @${state.username}. `
           + `Instagram vai ciclar os mesmos seguidores em loop. `
           + `→ Solução: siga @${state.username} com a conta @${currentUser?.username || "extratora"}, `
           + `OU recapture os cookies de uma conta que já segue o perfil alvo.`,
      });
    } else {
      broadcast("STATUS", {
        msg: `✔ @${currentUser?.username || "conta extratora"} segue @${state.username} — lista completa disponível. `
           + `Se still_limit aparecer, é limitação de trust score (conta nova/suspeita pelo Instagram).`,
      });
    }
    if (friendship.outgoingRequest) {
      broadcast("STATUS", { msg: `ℹ Solicitação enviada mas não aceita — Instagram trata como não-seguidor até aceitar.` });
    }
  }

  // pagesWithCurrent conta quantas páginas foram feitas com a conta atual.
  // rotateAfter=4 → troca a cada 4 páginas, rotateAfter=0 → sem rotação
  let pagesWithCurrent   = 0;
  let limitedWindow      = []; // janela deslizante de novos seguidores por página (limitedList=true)
  const LIMIT_WINDOW     = 10; // tamanho da janela
  const LIMIT_THRESHOLD  = 3;  // mínimo de únicos por janela antes de desistir
  let rankToken = generateUUID(); // UUID fixo por sessão — obrigatório no rank_token
  const seenIds = new Set();     // deduplicação cross-account (cursores não são portáveis entre contas)

  // Pausa humana — a cada 15–25 páginas, pausa de 5–20s para imitar comportamento real
  // Usuário real pára para ler perfis, muda de app, distrai. Bot não faz isso.
  let nextBreakAtPage = 15 + Math.floor(Math.random() * 11);
  let historySaved = false;

  // ── Loop de paginação ──
  while (state.running) {
    if (state.paused) { await sleep(300); continue; }

    // Limite máximo atingido
    if (state.maxFollowers > 0 && state.followers.length >= state.maxFollowers) {
      broadcast("DONE", {
        extracted: state.followers.length,
        total: meta.followers,
        pages: state.page,
        limitReached: true,
      });
      state.running = false;
      break;
    }

    // Rotação de conta — baseada em PÁGINAS (não seguidores)
    // rotateAfter=0 → sem rotação; rotateAfter=1 → troca a cada página
    if (usePool && state.rotateAfter > 0 && pagesWithCurrent >= state.rotateAfter) {
      const next = getNextAccount();
      if (!next) { await sleep(200); continue; }
      if (next.waitMs) {
        broadcast("STATUS", {
          msg: `Todas as contas em cooldown — aguardando ~${Math.ceil(next.waitMs / 1000)}s…`,
          extracted: state.followers.length, total: meta.followers,
        });
        await sleepKeepAlive(next.waitMs, s =>
          broadcast("STATUS", { msg: `⏸ Cooldown — retomando em ~${s}s…`, extracted: state.followers.length })
        );
        continue;
      }
      broadcast("STATUS", {
        msg: `Rotacionando para ${next.name}…`,
        extracted: state.followers.length, total: meta.followers,
      });
      // Preserva o claim da conta que está saindo para restaurar se voltar a ela
      if (currentIgAccount) currentIgAccount.wwwClaim = igWwwClaim;
      await applyCookies(next.profile);
      currentIgAccount = next;
      igWwwClaim = next.wwwClaim || "0"; // restaura o claim salvo desta conta (ou "0" se nunca usada)
      // Recarrega a aba com os novos cookies e valida autenticação.
      // O follow_ranking_token codifica o userId da conta extratora — não é portável
      // para outra conta. Ao zerar cursor, paginação reinicia do zero com a nova conta.
      // Duplicatas são descartadas via seenIds.
      if (igTabId !== null) {
        try {
          await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
          await waitForTabComplete(igTabId, 12000);
          await sleep(800 + Math.random() * 700); // 0.8–1.5s após login
          const authed = await checkTabAuth(igTabId);
          if (!authed) {
            broadcast("STATUS", {
              msg: `⚠ ${next.name} redirecionou para login — cookie inválido. Desativando por 5min e tentando próxima conta…`,
              extracted: state.followers.length, total: meta.followers,
            });
            next.cooldownUntil = Date.now() + 300000;
            next.errors++;
            pagesWithCurrent = 0;
            continue;
          }
        } catch (_) { igTabId = null; }
      }
      // Nova conta OK — zera cursor (token anterior não portável) e reinicia UUID
      state.cursor = null;
      rankToken    = generateUUID();
      pagesWithCurrent = 0;
    }

    // Identifica conta atual pelo último índice escolhido por getNextAccount
    let currentAccount = usePool
      ? state.accountPool[(state.poolIndex - 1 + state.accountPool.length) % state.accountPool.length]
      : null;

    try {
      // ── Pausa humana ─────────────────────────────────────────────────────
      // A cada 15–25 páginas, para de 5–20s imitando usuário que se distrai.
      // Esse padrão irregular é o que mais diferencia humano de bot.
      if (state.page >= nextBreakAtPage) {
        const breakMs = 5000 + Math.random() * 15000; // 5–20s
        broadcast("STATUS", {
          msg: `☕ Pausa natural — retomando em ${Math.round(breakMs / 1000)}s…`,
          extracted: state.followers.length,
        });
        await sleepKeepAlive(breakMs);
        if (!state.running) break;
        nextBreakAtPage = state.page + 15 + Math.floor(Math.random() * 11);
      }

      const { users, nextCursor, rankToken: newRankToken, limitedList } = await fetchPage(state.userId, state.cursor, rankToken, state.username);
      rankToken = newRankToken; // atualiza para a próxima requisição
      state.page++;
      pagesWithCurrent++;
      recordPageTime();
      onSuccess();
      // Persiste dados a cada 30 páginas — protege contra morte do service worker
      if (state.page % 30 === 0) savePartialFollowers().catch(() => {});

      let newCount = 0;
      for (const u of users) {
        const uid = String(u.pk || u.id || "");
        if (uid && seenIds.has(uid)) continue;   // duplicata — cursor reiniciado após rotação
        if (uid) seenIds.add(uid);
        state.followers.push(toRow(u));
        newCount++;
      }
      state.cursor = nextCursor;
      if (currentAccount) currentAccount.totalRequests++;

      // ── Detecção de "cycling" com janela deslizante ───────────────────────
      // Quando should_limit_list_of_followers=true, o Instagram cicla os mesmos
      // ~50-200 seguidores. Às vezes vaza 1 único por página — contador simples
      // de "N consecutivos" resetava com qualquer um. Usamos janela de 10 páginas:
      // se soma de únicos na janela < 3, o cycling está confirmado → parar.
      if (limitedList) {
        limitedWindow.push(newCount);
        if (limitedWindow.length > LIMIT_WINDOW) limitedWindow.shift();
        if (limitedWindow.length >= LIMIT_WINDOW) {
          const windowSum = limitedWindow.reduce((a, b) => a + b, 0);
          if (windowSum < LIMIT_THRESHOLD) {
            const cyclingMsg =
              `⛔ Cycling detectado: apenas ${windowSum} seguidores únicos nas últimas ${LIMIT_WINDOW} páginas `
            + `(deveria ser ${LIMIT_WINDOW * 50}). Instagram está ciclando os mesmos perfis com `
            + `should_limit_list_of_followers=true. `
            + (currentUser ? `A conta @${currentUser.username} ` : `A conta extratora `)
            + (friendship?.following
                ? `SEGUE @${state.username}, mas tem trust score baixo (conta nova ou suspeita). `
                  + `Tente uma conta com mais atividade real.`
                : `NÃO segue @${state.username}. Siga o perfil com esta conta ou recapture cookies de uma conta que já segue.`)
            + ` Total extraído: ${state.followers.length.toLocaleString("pt-BR")} (${state.page} páginas).`;
            broadcast("STATUS", { msg: cyclingMsg, extracted: state.followers.length });
            broadcast("DONE", {
              extracted:  state.followers.length,
              total:      meta.followers,
              pages:      state.page,
              limitedMsg: cyclingMsg,
            });
            await saveHistory(meta, "stopped");
            state.running = false;
            break;
          }
        }
      } else {
        limitedWindow = []; // sai do modo limitado → reseta janela
      }

      const speed = getSpeedStats();
      const totalKnown = meta.followers || 0;
      const remaining  = totalKnown > 0 ? totalKnown - state.followers.length : 0;
      const etaSec     = speed.ppm > 0 && remaining > 0
        ? Math.round((remaining / 50) / (speed.ppm / 60))
        : 0;

      const poolStatus = usePool
        ? ` | ${currentAccount?.name || "?"} (${state.accountPool.filter(a => a.cooldownUntil <= Date.now()).length}/${state.accountPool.length} disponíveis)`
        : "";

      broadcast("PROGRESS", {
        extracted:  state.followers.length,
        total:      totalKnown,
        page:       state.page,
        hasMore:    !!nextCursor,
        ppm:        speed.ppm,
        spm:        speed.spm,
        etaSec,
        adaptiveDelay: state.adaptiveDelay,
        poolStatus,
        logLine: `Pág. ${state.page} | +${newCount} seg${newCount < users.length ? ` (${users.length - newCount} dup)` : ""}${limitedList ? " ⚠" : ""} | ${speed.ppm} pág/min | delay ${state.adaptiveDelay}ms${poolStatus}`,
      });

      // Salva progresso parcial
      await chrome.storage.local.set({
        currentExtraction: {
          username:  state.username,
          extracted: state.followers.length,
          total:     totalKnown,
          page:      state.page,
          running:   true,
          paused:    state.paused,
        }
      });

      if (!nextCursor) {
        const doneMsg = limitedList
          ? `Extração limitada pelo Instagram — ${state.followers.length} perfis visíveis com esta conta. Para ver todos, siga @${state.username} com a conta de extração.`
          : `${state.followers.length} seguidores extraídos.`;
        broadcast("DONE", {
          extracted: state.followers.length,
          total:     meta.followers,
          pages:     state.page,
          limitedMsg: limitedList ? doneMsg : undefined,
        });
        await saveHistory(meta);
        historySaved = true;
        state.running = false;
        break;
      }

      await sleep(jitter(state.adaptiveDelay));

    } catch (e) {
      if (e.message === "RATE_LIMIT") {
        onRateLimit(currentAccount);
        broadcast("STATUS", {
          msg: `Rate limit${currentAccount ? ` (${currentAccount.name})` : ""} — cooldown 60s | delay ajustado: ${state.adaptiveDelay}ms`,
          extracted: state.followers.length, total: meta.followers,
        });
        if (!usePool || state.accountPool.every(a => a.cooldownUntil > Date.now())) {
          await sleepKeepAlive(60000, s =>
            broadcast("STATUS", { msg: `⏸ Rate limit — todas as contas em cooldown, retomando em ~${s}s…`, extracted: state.followers.length })
          );
          if (!state.running) break;
        }
        continue;
      }
      if (e.message === "AUTH_FAIL") {
        if (currentAccount) {
          currentAccount.cooldownUntil = Date.now() + 300000; // 5 min
          currentAccount.errors++;
          broadcast("STATUS", {
            msg: `Auth falhou (${currentAccount.name}) — desativada por 5min. Tentando próxima conta…`,
            extracted: state.followers.length, total: meta.followers,
          });
          // Diagnóstico: informa se o sessionid existe ou está ausente/expirado
          try {
            const sc = await chrome.cookies.get({ url: "https://www.instagram.com/", name: "sessionid" });
            if (!sc) {
              broadcast("STATUS", { msg: `⚠ sessionid NÃO encontrado para "${currentAccount.name}" — cookie ausente ou expirado. Vá em Perfis → recapture ou reimporte os cookies desta conta.` });
            } else {
              const exp = sc.expirationDate
                ? new Date(sc.expirationDate * 1000).toLocaleDateString("pt-BR")
                : "sessão do browser";
              broadcast("STATUS", { msg: `ℹ "${currentAccount.name}": sessionid presente (exp: ${exp}). O Instagram bloqueou temporariamente esta sessão por detecção de scraping — aguardando cooldown.` });
            }
          } catch (_) {}

          // Força rotação imediata para a próxima conta disponível.
          // Sem isso, o loop continuaria tentando com os mesmos cookies inválidos.
          const nextOnFail = getNextAccount();
          if (nextOnFail && !nextOnFail.waitMs) {
            if (currentIgAccount) currentIgAccount.wwwClaim = igWwwClaim;
            await applyCookies(nextOnFail.profile);
            currentIgAccount = nextOnFail;
            igWwwClaim = nextOnFail.wwwClaim || "0";
            if (igTabId !== null) {
              try {
                await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
                await waitForTabComplete(igTabId, 12000);
                await sleep(1000 + Math.random() * 500);
              } catch (_) { igTabId = null; }
            }
            // Cursor do token anterior não é portável — reinicia paginação com nova conta.
            // pagesWithCurrent=0 evita que a rotação dispare novamente na próxima iteração.
            state.cursor = null;
            rankToken    = generateUUID();
            pagesWithCurrent = 0;
          } else {
            // Todas as contas estão em cooldown — aguarda a primeira sair e retoma automaticamente.
            // Não para a extração: bloqueios do Instagram costumam ser temporários (5–15 min).
            // Se o bloqueio for permanente, o usuário pode clicar em Parar manualmente.
            const waitSec = Math.ceil(nextOnFail.waitMs / 1000);
            broadcast("STATUS", {
              msg: `⏸ Todas as contas bloqueadas — retomando automaticamente em ~${waitSec}s… (clique Parar para cancelar)`,
              extracted: state.followers.length, total: meta.followers,
            });
            await sleepKeepAlive(nextOnFail.waitMs + 2000, s =>
              broadcast("STATUS", { msg: `⏸ Aguardando desbloqueio… ~${s}s restantes`, extracted: state.followers.length })
            );
            if (!state.running) break;
            // Tenta pegar a conta que saiu de cooldown
            const recovered = getNextAccount();
            if (recovered && !recovered.waitMs) {
              broadcast("STATUS", {
                msg: `▶ Retomando extração com ${recovered.name}…`,
                extracted: state.followers.length, total: meta.followers,
              });
              if (currentIgAccount) currentIgAccount.wwwClaim = igWwwClaim;
              await applyCookies(recovered.profile);
              currentIgAccount = recovered;
              igWwwClaim = recovered.wwwClaim || "0";
              if (igTabId !== null) {
                try {
                  await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
                  await waitForTabComplete(igTabId, 12000);
                  await sleep(1000 + Math.random() * 500);
                } catch (_) { igTabId = null; }
              }
            }
            state.cursor = null;
            rankToken    = generateUUID();
            pagesWithCurrent = 0;
          }
        } else {
          broadcast("ERROR", { msg: "Sessão expirada. Faça login no Instagram e tente novamente." });
          state.running = false;
          break;
        }
        continue;
      }
      broadcast("STATUS", {
        msg: `Erro: ${e.message} — aguardando 10s…`,
        extracted: state.followers.length, total: meta.followers,
      });
      await sleep(10000);
    }
  }

  state.running = false;
  // Salva histórico mesmo quando extração foi interrompida pelo usuário
  if (!historySaved && state.followers.length > 0 && state.meta) {
    await saveHistory(state.meta, "stopped").catch(() => {});
  }
  await savePartialFollowers().catch(() => {}); // garante dados para download mesmo após reinício do SW
  await saveState();
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------
async function saveHistory(meta, type = "completed") {
  const s = await chrome.storage.local.get("history");
  const history = s.history || [];
  // Para posts (curtidas, comentários), preserva a URL original e label legível
  const originalUrl = state.platform === "facebook"
    ? (state.fbUrl || state.username)
    : (type === "likes" || type === "comments")
      ? `https://www.instagram.com/${state.urlType || "p"}/${state.username}/`
      : null;
  history.unshift({
    id:          Date.now(),
    username:    state.username,
    userId:      state.userId,
    date:        new Date().toISOString(),
    count:       state.followers.length,
    total:       meta.followers,
    pages:       state.page,
    durationSec: Math.round((Date.now() - state.startedAt) / 1000),
    type:        type,
    platform:    state.platform || "instagram",
    originalUrl: originalUrl,     // URL completa para reextrair (null para seguidores)
  });
  // Mantém só os últimos 50
  if (history.length > 50) history.splice(50);
  await chrome.storage.local.set({ history });
}

// Persiste os seguidores já extraídos no storage local.
// Essencial para MV3: o service worker pode ser morto a qualquer momento durante
// idle. Sem isso, clicar em Baixar após o SW reiniciar retorna "nenhum dado".
async function savePartialFollowers() {
  if (state.followers.length === 0) return;
  await chrome.storage.local.set({ partialFollowers: state.followers });
}

async function saveState() {
  await chrome.storage.local.set({
    currentExtraction: {
      username:  state.username,
      extracted: state.followers.length,
      total:     0,
      page:      state.page,
      running:   false,
      paused:    false,
    }
  });
}

// ---------------------------------------------------------------------------
// Gerador de CSV
// ---------------------------------------------------------------------------
function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  // Escape de CSV injection (fórmula): valores começando com = + - @ ou TAB/CR
  // são executados como fórmula pelo Excel/Sheets ao abrir o arquivo. Campos
  // como Bio/Comment/Fullname/Username são 100% controlados pelo perfil
  // extraído — prefixar aspa simples neutraliza (mitigação OWASP). O envelope
  // em aspas + duplicação de " continua tratando a quebra de estrutura.
  const esc = v => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
}

// ---------------------------------------------------------------------------
// Extrator de curtidas (likes) de post
// ---------------------------------------------------------------------------

// Converte shortcode da URL para media_id numérico
function shortcodeToMediaId(shortcode) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = BigInt(0);
  for (const char of shortcode) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Caracter inválido no shortcode: "${char}"`);
    result = result * 64n + BigInt(idx);
  }
  return result.toString();
}

// Busca página de curtidores
async function fetchLikersPage(mediaId, cursor) {
  let url = `https://www.instagram.com/api/v1/media/${mediaId}/likers/?count=50`;
  if (cursor) url += `&max_id=${encodeURIComponent(cursor)}`;
  const referer = `https://www.instagram.com/p/${mediaId}/liked_by/`;
  const json = await igFetch(url, referer);
  const users = json.users || [];
  const nextCursor = json.next_max_id || null;
  const userCount  = json.user_count  || 0;
  return { users, nextCursor, userCount };
}

// ---------------------------------------------------------------------------
// Extrator de comentários (API privada do Instagram)
// ---------------------------------------------------------------------------
// Usa /api/v1/media/{media_id}/comments/ — sem o limite de ~500 do GraphQL.
// Paginação via min_id: cada resposta traz next_min_id + has_more_comments.
// IMPORTANTE: o Instagram às vezes retorna has_more_comments:false com next_min_id válido.
// → confia no next_min_id como sinal definitivo; ignora has_more_comments.
async function fetchCommentsPage(mediaId, cursor) {
  let url = `https://www.instagram.com/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false`;
  if (cursor) url += `&min_id=${encodeURIComponent(cursor)}`;
  const utype     = state.urlType || "p";
  const shortcode = state.username;
  const referer   = `https://www.instagram.com/${utype}/${shortcode}/`;
  const json      = await igFetch(url, referer);
  const comments   = json.comments    || [];
  const totalCount = json.comment_count ?? 0;
  // Cursor presente = há mais páginas, independente do has_more_comments
  const nextCursor = json.next_min_id || null;
  return { comments, nextCursor, totalCount };
}

// Busca uma página de respostas (child comments) de um comentário específico.
// Endpoint: /api/v1/media/{mediaId}/comments/{parentId}/child_comments/?max_id={cursor}
async function fetchChildCommentsPage(mediaId, parentId, cursor, shortcode, utype) {
  let url = `https://www.instagram.com/api/v1/media/${mediaId}/comments/${parentId}/child_comments/`;
  if (cursor) url += `?max_id=${encodeURIComponent(cursor)}`;
  const referer = `https://www.instagram.com/${utype || "p"}/${shortcode}/`;
  const json = await igFetch(url, referer);
  // O Instagram pode retornar o array como "child_comments" ou "comments"
  const comments   = json.child_comments || json.comments || [];
  // Cursor pode ter vários nomes dependendo da versão da API
  const nextCursor = json.next_max_child_cursor || json.next_max_id || json.next_min_id || null;
  // Confia no cursor como sinal de continuidade — ignora has_more_*
  return { comments, nextCursor };
}

// Extração principal de comentários (Instagram)
async function runCommentsExtraction() {
  const cfg = await getConfig();
  state.delayMs       = cfg.delayMs      ?? 1200;
  state.rotateAfter   = cfg.rotateAfter  ?? 4;
  state.maxFollowers  = cfg.maxFollowers ?? 0;
  state.adaptiveDelay = state.delayMs;

  const profiles = await getProfiles();
  state.accountPool = profiles.map((p, i) => ({
    profile: p, name: p.name || `Perfil ${i + 1}`,
    cooldownUntil: 0, totalRequests: 0, errors: 0,
    wwwClaim: "0",
  }));
  state.poolIndex = 1;
  const usePool = state.accountPool.length > 0;

  if (usePool) {
    currentIgAccount = state.accountPool[0];
    await applyCookies(state.accountPool[0].profile);
    igWwwClaim = "0";
    try {
      const existingTabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
      if (existingTabs.length) {
        igTabId = existingTabs[0].id;
        await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
        await waitForTabComplete(igTabId, 15000);
        await sleep(1200);
      }
    } catch (_) {}
  }

  const shortcode = state.username; // state.username guarda o shortcode

  // Converte shortcode para media_id numérico (obrigatório para a API privada)
  let mediaId;
  try {
    mediaId = shortcodeToMediaId(shortcode);
  } catch (e) {
    broadcast("ERROR", { msg: `Shortcode inválido: ${e.message}` });
    state.running = false;
    return;
  }

  // Warm-up: visita a mídia antes de chamar a API — usando o path correto
  const utype    = state.urlType || "p";  // "p" | "reel" | "tv"
  const mediaUrl = `https://www.instagram.com/${utype}/${shortcode}/`;
  broadcast("STATUS", { msg: `Carregando /${utype}/${shortcode}/… (warm-up)` });
  try {
    const warmTabId = igTabId !== null ? igTabId : await getIgTab();
    igTabId = warmTabId;
    await chrome.tabs.update(warmTabId, { url: mediaUrl });
    await waitForTabComplete(warmTabId, 12000);
    await sleep(1500 + Math.random() * 2000); // 1.5–3.5s "lendo" a mídia
  } catch (_) {}

  broadcast("STATUS", { msg: `Extraindo comentários de /${utype}/${shortcode}/…` });

  let cursor            = null;
  let totalComments     = 0;
  let nextBreakAtPage   = 10 + Math.floor(Math.random() * 7);
  let historySaved      = false;
  let pagesWithCurrent  = 0;
  let phase1Done        = false;
  const seenIds         = new Set();
  const pendingReplies  = []; // comentários top-level que têm replies além do preview

  while (state.running) {
    if (state.paused) { await sleep(300); continue; }
    if (state.maxFollowers > 0 && state.followers.length >= state.maxFollowers) {
      broadcast("DONE", { extracted: state.followers.length, total: totalComments, pages: state.page, limitReached: true });
      state.running = false;
      break;
    }

    // Rotação de conta — baseada em páginas (igual ao módulo de seguidores)
    if (usePool && state.rotateAfter > 0 && pagesWithCurrent >= state.rotateAfter) {
      const next = getNextAccount();
      if (!next) { await sleep(200); continue; }
      if (next.waitMs) {
        broadcast("STATUS", {
          msg: `Todas as contas em cooldown — aguardando ~${Math.ceil(next.waitMs / 1000)}s…`,
          extracted: state.followers.length,
        });
        await sleepKeepAlive(next.waitMs, s =>
          broadcast("STATUS", { msg: `⏸ Cooldown — retomando em ~${s}s…`, extracted: state.followers.length })
        );
        continue;
      }
      broadcast("STATUS", { msg: `Rotacionando para ${next.name}…`, extracted: state.followers.length });
      if (currentIgAccount) currentIgAccount.wwwClaim = igWwwClaim;
      await applyCookies(next.profile);
      currentIgAccount = next;
      igWwwClaim = next.wwwClaim || "0";
      if (igTabId !== null) {
        try {
          await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
          await waitForTabComplete(igTabId, 12000);
          await sleep(800 + Math.random() * 700);
          const authed = await checkTabAuth(igTabId);
          if (!authed) {
            broadcast("STATUS", { msg: `⚠ ${next.name} — cookie inválido, desativando 5min e tentando próxima conta…`, extracted: state.followers.length });
            next.cooldownUntil = Date.now() + 300000;
            next.errors++;
            pagesWithCurrent = 0;
            continue;
          }
        } catch (_) { igTabId = null; }
      }
      pagesWithCurrent = 0;
    }

    // Identifica conta atual (selecionada pelo último getNextAccount)
    const currentAccount = usePool
      ? state.accountPool[(state.poolIndex - 1 + state.accountPool.length) % state.accountPool.length]
      : null;

    // Pausa humana — a cada 10–16 páginas, pausa de 5–17s
    if (state.page >= nextBreakAtPage) {
      const breakMs = 5000 + Math.random() * 12000;
      broadcast("STATUS", { msg: `☕ Pausa — retomando em ${Math.round(breakMs / 1000)}s…`, extracted: state.followers.length });
      await sleepKeepAlive(breakMs);
      if (!state.running) break;
      nextBreakAtPage = state.page + 10 + Math.floor(Math.random() * 7);
    }

    try {
      const { comments, nextCursor, totalCount } = await fetchCommentsPage(mediaId, cursor);
      if (totalCount > 0 && totalComments === 0) totalComments = totalCount;
      state.page++;
      pagesWithCurrent++;
      recordPageTime();
      onSuccess();
      if (currentAccount) currentAccount.totalRequests++;
      if (state.page % 10 === 0) savePartialFollowers().catch(() => {});

      let newCount = 0;
      for (const comment of comments) {
        const cid = String(comment.pk || "");
        if (cid && seenIds.has(cid)) continue;
        if (cid) seenIds.add(cid);
        state.followers.push(toCommentRow(comment, ""));   // top-level — Parent Id vazio
        newCount++;

        // Adiciona preview_child_comments (já vêm na resposta, sem request extra)
        const previews = comment.preview_child_comments || [];
        for (const reply of previews) {
          const rid = String(reply.pk || "");
          if (rid && seenIds.has(rid)) continue;
          if (rid) seenIds.add(rid);
          state.followers.push(toCommentRow(reply, cid)); // resposta — Parent Id = comentário pai
          newCount++;
        }

        // Se há mais replies do que o preview, enfileira para busca completa (Fase 2)
        const childCount = comment.child_comment_count || 0;
        if (childCount > previews.length) {
          pendingReplies.push({ parentId: cid, childCount });
        }
      }
      cursor = nextCursor;

      const speed = getSpeedStats();
      const poolStatusStr = usePool
        ? ` | ${currentAccount?.name || "?"} (${state.accountPool.filter(a => a.cooldownUntil <= Date.now()).length}/${state.accountPool.length} disponíveis)`
        : "";
      broadcast("PROGRESS", {
        extracted:     state.followers.length,
        total:         totalComments,
        page:          state.page,
        hasMore:       !!nextCursor,
        ppm:           speed.ppm,
        spm:           0,
        etaSec:        0,
        adaptiveDelay: state.adaptiveDelay,
        poolStatus:    poolStatusStr,
        logLine: `Pág. ${state.page} | +${newCount} comentários | ${speed.ppm} pág/min | delay ${state.adaptiveDelay}ms${poolStatusStr}`,
      });

      await chrome.storage.local.set({
        currentExtraction: {
          username:  shortcode,
          extracted: state.followers.length,
          total:     totalComments,
          page:      state.page,
          running:   true,
          paused:    state.paused,
        }
      });

      if (!nextCursor || comments.length === 0) {
        phase1Done = true;  // Fase 1 concluída — Fase 2 (replies) vai rodar depois do loop
        break;
      }

      await sleep(jitter(state.adaptiveDelay));

    } catch (e) {
      if (e.message === "RATE_LIMIT") {
        onRateLimit(currentAccount); // passa conta atual para cooldown individual
        broadcast("STATUS", {
          msg: `Rate limit${currentAccount ? ` (${currentAccount.name})` : ""} — cooldown 60s | delay ${state.adaptiveDelay}ms`,
          extracted: state.followers.length,
        });
        if (!usePool || state.accountPool.every(a => a.cooldownUntil > Date.now())) {
          await sleepKeepAlive(60000, s =>
            broadcast("STATUS", { msg: `⏸ Rate limit — ~${s}s…`, extracted: state.followers.length })
          );
          if (!state.running) break;
        }
        continue;
      }
      if (e.message === "AUTH_FAIL") {
        if (currentAccount) {
          currentAccount.cooldownUntil = Date.now() + 300000;
          currentAccount.errors++;
          broadcast("STATUS", {
            msg: `Auth falhou (${currentAccount.name}) — desativando 5min, tentando próxima conta…`,
            extracted: state.followers.length,
          });
          const nextOnFail = getNextAccount();
          if (nextOnFail && !nextOnFail.waitMs) {
            if (currentIgAccount) currentIgAccount.wwwClaim = igWwwClaim;
            await applyCookies(nextOnFail.profile);
            currentIgAccount = nextOnFail;
            igWwwClaim = nextOnFail.wwwClaim || "0";
            if (igTabId !== null) {
              try {
                await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
                await waitForTabComplete(igTabId, 12000);
                await sleep(1000 + Math.random() * 500);
              } catch (_) { igTabId = null; }
            }
            pagesWithCurrent = 0;
            continue;
          } else {
            const waitMs2 = nextOnFail?.waitMs ?? 300000;
            broadcast("STATUS", {
              msg: `⏸ Todas as contas bloqueadas — retomando em ~${Math.ceil(waitMs2 / 1000)}s…`,
              extracted: state.followers.length,
            });
            await sleepKeepAlive(waitMs2 + 2000, s =>
              broadcast("STATUS", { msg: `⏸ Aguardando desbloqueio… ~${s}s`, extracted: state.followers.length })
            );
            if (!state.running) break;
            pagesWithCurrent = 0;
            continue;
          }
        } else {
          broadcast("ERROR", { msg: "Sessão inválida. Recapture os cookies e tente novamente." });
          state.running = false;
          break;
        }
      }
      broadcast("STATUS", { msg: `Erro: ${e.message} — aguardando 10s…`, extracted: state.followers.length });
      await sleep(10000);
    }
  }

  // ── Fase 2: Buscar respostas (child comments) além do preview ──────────────
  if (phase1Done && pendingReplies.length > 0 && state.running) {
    broadcast("STATUS", {
      msg: `↳ Buscando respostas de ${pendingReplies.length} comentário(s) com replies…`,
      extracted: state.followers.length,
    });

    for (const { parentId } of pendingReplies) {
      if (!state.running) break;
      let replyCursor = null;

      while (state.running) {
        try {
          const { comments: replies, nextCursor: rNext } =
            await fetchChildCommentsPage(mediaId, parentId, replyCursor, shortcode, utype);

          let added = 0;
          for (const reply of replies) {
            const rid = String(reply.pk || "");
            if (rid && seenIds.has(rid)) continue;
            if (rid) seenIds.add(rid);
            state.followers.push(toCommentRow(reply, parentId));
            added++;
          }
          replyCursor = rNext;

          if (added > 0) {
            broadcast("PROGRESS", {
              extracted:     state.followers.length,
              total:         totalComments,
              page:          state.page,
              adaptiveDelay: state.adaptiveDelay,
              logLine: `↳ replies +${added} | total: ${state.followers.length}`,
            });
          }

          if (!rNext || replies.length === 0) break;
          await sleep(jitter(state.adaptiveDelay));

        } catch (e) {
          if (e.message === "RATE_LIMIT") {
            onRateLimit(currentAccount);
            broadcast("STATUS", { msg: `Rate limit (replies) — cooldown 60s`, extracted: state.followers.length });
            if (!usePool || state.accountPool.every(a => a.cooldownUntil > Date.now())) {
              await sleepKeepAlive(60000, s =>
                broadcast("STATUS", { msg: `⏸ Rate limit (replies) — ~${s}s…`, extracted: state.followers.length })
              );
              if (!state.running) break;
            }
          } else {
            broadcast("STATUS", { msg: `⚠ Replies: ${e.message} — pulando…`, extracted: state.followers.length });
            break; // pula este comentário pai
          }
        }
      }
    }
  }

  // ── DONE ───────────────────────────────────────────────────────────────────
  if (phase1Done) {
    broadcast("DONE", { extracted: state.followers.length, total: totalComments, pages: state.page });
    await saveHistory(
      { followers: totalComments, following: 0, posts: 0, fullname: "", userId: shortcode },
      "comments"
    );
    historySaved = true;
  }

  state.running = false;
  if (!historySaved && state.followers.length > 0) {
    await saveHistory(
      { followers: totalComments || state.followers.length, following: 0, posts: 0, fullname: "", userId: shortcode },
      "comments"
    ).catch(() => {});
  }
  await savePartialFollowers().catch(() => {});
  await saveState();
}

// ---------------------------------------------------------------------------
// FACEBOOK COMMENT EXTRACTION
// Usa mbasic.facebook.com (HTML simples) injetando script na aba do browser.
// Não requer autenticação interna — aproveita a sessão logada do usuário.
// ---------------------------------------------------------------------------

/** Converte qualquer URL do Facebook para a versão mbasic */
function fbUrlToMbasic(url) {
  try {
    const u = new URL(url.includes("://") ? url : "https://" + url);
    u.hostname = "mbasic.facebook.com";
    return u.toString();
  } catch (_) {
    return url.replace(/(?:www\.|m\.)?facebook\.com/, "mbasic.facebook.com");
  }
}

/** Obtém ou cria aba facebook.com para extração.
 *  CRÍTICO: active:true — Facebook (React) não renderiza comentários se
 *  document.visibilityState === 'hidden' (aba oculta). */
async function getFbTab() {
  if (fbTabId !== null) {
    try {
      const t = await chrome.tabs.get(fbTabId);
      if (t && !t.discarded) {
        await chrome.tabs.update(fbTabId, { active: true });
        return fbTabId;
      }
    } catch (_) {}
    fbTabId = null;
  }
  const existing = await chrome.tabs.query({ url: "https://www.facebook.com/*" });
  if (existing.length) {
    fbTabId = existing[0].id;
    await chrome.tabs.update(fbTabId, { active: true });
    return fbTabId;
  }
  const tab = await chrome.tabs.create({ url: "https://www.facebook.com/", active: true });
  fbTabId = tab.id;
  await waitForTabComplete(fbTabId, 15000);
  return fbTabId;
}

/** Script injetado na aba mbasic: extrai comentários visíveis e próxima página */
/**
 * Polling: aguarda comentários aparecerem no DOM da aba FB.
 * Substitui sleep fixo — retorna assim que encontra, ou após timeout.
 */
async function _fbWaitForComments(tabId, timeoutMs = 14000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: "ISOLATED",
      func: () => {
        // S1: comentário dentro de dialog (posts de grupos)
        if (document.querySelector('[role="dialog"] [role="article"]')) return true;
        // S2: comentário direto no document com link de comment_id (perfis/páginas)
        if (document.querySelector('div[role="article"] a[href*="comment_id"]')) return true;
        // S3: botão de reply visível indica que comentários carregaram
        if (document.querySelector('[aria-label*="Reply"], [aria-label*="Responder"]')) return true;
        // S4: data-testid legado do Facebook
        if (document.querySelector('[data-testid*="UFI2Comment"]')) return true;
        return false;
      },
    }).catch(() => []);
    if (results?.[0]?.result === true) return true;
    await sleep(700);
  }
  return false;
}

// Script injetado para extrair comentários — funciona em www.facebook.com e mbasic.facebook.com
function _fbExtractComments() {
  try {
    const url = window.location.href;
    if (/login|checkpoint|recover|disabled/i.test(url)) {
      return { ok: false, error: "LOGIN_REQUIRED", comments: [], hasMore: false, nextUrl: null, totalCount: 0, debugUrl: url };
    }

    const seen = new Set();
    const comments = [];
    const isMbasic = url.includes("mbasic.facebook.com");

    // ═══════════════════════════════════════════════════════════════════════
    // ESTRATÉGIA A — www.facebook.com (SPA React)
    // Comments são div[role="article"] que contêm link de tempo com comment_id
    // ═══════════════════════════════════════════════════════════════════════
    if (!isMbasic) {
      // Posts de GRUPOS: comentários renderizam dentro de [role="dialog"] (modal lateral)
      // Posts de perfil/página: comentários ficam direto no document
      // → busca dentro do dialog primeiro, fallback para document inteiro
      const searchRoot = document.querySelector('[role="dialog"]') || document;
      const articles = Array.from(searchRoot.querySelectorAll('div[role="article"]'));
      // Filtra: comentários têm link com comment_id (timestamp link) OU botão Reply
      const commentArticles = articles.filter(a =>
        a.querySelector('a[href*="comment_id"]') ||
        a.querySelector('[aria-label*="Reply"], [aria-label*="Responder"], [aria-label*="Curtir este comentário"], [aria-label*="Like this comment"]')
      );

      for (const article of commentArticles) {
        const allLinks = Array.from(article.querySelectorAll('a[href]'));

        // Profile link: first <a> that goes to a user page (not post/comment/reaction)
        const profileLink = allLinks.find(a => {
          const h = a.href || "";
          return /facebook\.com\/(?!(?:groups|pages|events|watch|marketplace|story\.php|permalink|sharer|photo|video|hashtag|reaction|share|posts)[/?#])[^?/#]+/i.test(h)
            || h.includes('/profile.php?id=')
            || h.includes('/people/');
        });

        let profileUrl = profileLink ? profileLink.href.replace(/[?#].*$/, '') : "";
        // Remove tracking params but keep profile.php?id=
        if (profileLink && profileLink.href.includes('profile.php')) {
          const idM = profileLink.href.match(/id=(\d+)/);
          profileUrl = idM ? `https://www.facebook.com/profile.php?id=${idM[1]}` : profileUrl;
        }

        let username = "";
        if (profileUrl) {
          const m = profileUrl.match(/facebook\.com\/(?:profile\.php\?id=(\d+)|([^?/#]+))/);
          username = m ? decodeURIComponent(m[1] ? `id_${m[1]}` : (m[2] || "")) : "";
          if (/^(groups|pages|events|watch|marketplace|story|permalink|sharer|photo|video)$/.test(username)) username = "";
        }
        // Prefer: author name from aria-label on the article ("Comment by NAME")
        const ariaLabel = article.getAttribute("aria-label") || "";
        const ariaMatch = ariaLabel.match(/(?:Comment|Comentário)\s+(?:by|de)\s+(.+)/i);
        if (ariaMatch && !username) username = ariaMatch[1].trim();

        // Comment ID from timestamp link
        let commentId = "";
        const timeLink = allLinks.find(a => a.href && a.href.includes("comment_id"));
        if (timeLink) {
          const m = timeLink.href.match(/comment_id=(\d+)/);
          if (m) commentId = m[1];
        }

        // Comment text: div[dir="auto"] or span[dir="auto"] with most content
        const textEls = Array.from(article.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
        let text = "";
        for (const el of textEls) {
          const t = (el.innerText || el.textContent || "").trim();
          if (t.length > text.length && t !== username) text = t;
        }
        if (!text) continue;
        if (username && text.toLowerCase().startsWith(username.toLowerCase())) {
          text = text.slice(username.length).trim();
        }

        // Date from timestamp link text
        let dateStr = "";
        if (timeLink) dateStr = (timeLink.innerText || timeLink.textContent || "").trim();
        if (!dateStr) {
          const abbr = article.querySelector("abbr");
          if (abbr) dateStr = (abbr.title || abbr.textContent || "").trim();
        }

        // Avatar
        const img = article.querySelector('img[src*="scontent"], img[src*="fbcdn"], img[alt]');
        const avatarUrl = img ? img.src : "";

        const key = commentId || (username + "|" + text.slice(0, 50));
        if (seen.has(key)) continue;
        seen.add(key);
        comments.push({ commentId, username, profileUrl, text, dateStr, avatarUrl });
      }

      // "Load more comments" button (www uses role=button, not <a>)
      const allClickable = Array.from(document.querySelectorAll('[role="button"], button'));
      const loadMoreBtn = allClickable.find(el => {
        const t = (el.innerText || el.textContent || "").trim();
        return /^\s*(\d+\s*)?(view|see|load|ver|mostrar|carregar)\s*(\d+\s*)?(more|mais|all|todos)\s*(comments?|comentários?|replies?|respostas?)/i.test(t)
          || /\d+\s*(comments?|comentários?)\s*$/i.test(t);
      });
      const hasMore = !!loadMoreBtn;

      // Total count
      let totalCount = 0;
      const bText = document.body.innerText || "";
      const cm = bText.match(/(\d[\d,.]*)\s*(comments?|comentários?)/i);
      if (cm) totalCount = parseInt(cm[1].replace(/[,.]/g, ""), 10);
      if (totalCount === 0 && comments.length > 0) totalCount = comments.length;

      const inDialog = !!document.querySelector('[role="dialog"]');
      return {
        ok: true, comments, hasMore, nextUrl: null, totalCount,
        debugUrl: url,
        debugStrategy: `dialog:${inDialog}|root_articles:${articles.length}|comment_articles:${commentArticles.length}`,
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ESTRATÉGIA B — mbasic.facebook.com
    // ═══════════════════════════════════════════════════════════════════════
    const containers = [];
    const containerSet = new Set();

    // B1: links com comment_id → sobe pelo DOM até achar container com perfil
    const replyLinks = Array.from(document.querySelectorAll('a[href*="comment_id"]'));
    for (const link of replyLinks) {
      let el = link.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        const hasProfile = el.querySelector(
          'a[href*="/profile.php"], a[href*="facebook.com/"]:not([href*="comment_id"]):not([href*="like"]):not([href*="reply"])'
        );
        if (hasProfile && !containerSet.has(el)) {
          containerSet.add(el);
          containers.push({ node: el, replyLink: link });
          break;
        }
        el = el.parentElement;
      }
    }

    // B2: id^="comment_id_"
    if (containers.length === 0) {
      document.querySelectorAll('[id^="comment_id_"]').forEach(node => {
        if (!containerSet.has(node)) { containerSet.add(node); containers.push({ node, replyLink: null }); }
      });
    }

    // B3: <h3> com link de perfil (mbasic clássico)
    if (containers.length === 0) {
      document.querySelectorAll('h3').forEach(h3 => {
        const a = h3.querySelector('a');
        if (a && (a.href.includes('profile.php') || /facebook\.com\/[^?/#]+/.test(a.href))) {
          const c = h3.parentElement;
          if (c && !containerSet.has(c)) { containerSet.add(c); containers.push({ node: c, replyLink: null }); }
        }
      });
    }

    const IGNORE_TEXT = /^(Like|Curtir|Reply|Responder|Report|Denunciar|Share|Compartilhar|\d+\s*(like|curtida|mins?|hrs?|days?|week|month|year|ago|atrás|horas?|dias?|semana|mês|mes|anos?))$/i;

    for (const { node, replyLink } of containers) {
      const allLinks = Array.from(node.querySelectorAll('a'));
      const profileLink = allLinks.find(a => {
        const h = a.href || "";
        return (h.includes('/profile.php') || /facebook\.com\/[^?/#]+/.test(h))
          && !h.includes('comment_id') && !h.includes('like') && !h.includes('reply')
          && !h.includes('report') && !h.includes('share') && !h.includes('photo')
          && !h.includes('/groups/') && !h.includes('/pages/');
      });
      const profileUrl = profileLink ? profileLink.href.replace("mbasic.facebook.com", "www.facebook.com") : "";
      let username = "";
      if (profileUrl) {
        const m = profileUrl.match(/facebook\.com\/(?:profile\.php\?id=(\d+)|([^?/#]+))/);
        username = m ? decodeURIComponent(m[1] || m[2] || "") : "";
        if (/^(groups|pages|events|watch|marketplace)$/.test(username)) username = "";
      }

      let commentId = "";
      const rl = replyLink || node.querySelector('a[href*="comment_id"]');
      if (rl) { const m = (rl.href || "").match(/comment_id[=%3D]+([0-9]+)/i); if (m) commentId = m[1]; }
      if (!commentId && node.id) { const m = node.id.match(/comment_id_?(.+)/); if (m) commentId = m[1]; }

      const textCandidates = Array.from(node.querySelectorAll("div, span, p"))
        .map(el => (el.innerText || el.textContent || "").trim())
        .filter(t => t.length > 1 && t !== username && !IGNORE_TEXT.test(t));
      textCandidates.sort((a, b) => b.length - a.length);
      let text = textCandidates[0] || "";
      if (username && text.toLowerCase().startsWith(username.toLowerCase())) text = text.slice(username.length).trim();

      const abbr = node.querySelector("abbr");
      let dateStr = abbr ? (abbr.title || abbr.textContent || "").trim() : "";
      if (!dateStr) { const ts = allLinks.find(a => /\d+\s*(min|hr|day|h|d|ago|atrás)/i.test(a.textContent)); if (ts) dateStr = ts.textContent.trim(); }

      const img = node.querySelector("img");
      const avatarUrl = img ? img.src : "";

      const dedupKey = commentId || (username + "|" + text.slice(0, 50));
      if (seen.has(dedupKey) || text.length === 0) continue;
      seen.add(dedupKey);
      comments.push({ commentId, username, profileUrl, text, dateStr, avatarUrl });
    }

    // Paginação mbasic via <a>
    const nextLink =
      document.querySelector('a[href*="last_comment_fbid"]') ||
      document.querySelector('a[href*="comment_fbid"]') ||
      document.querySelector('a[href*="?p="]') ||
      document.querySelector('a[href*="&p="]') ||
      Array.from(document.querySelectorAll('a')).find(a =>
        /ver mais|more comments|load more|see more/i.test(a.textContent || "") && (a.href || "").includes("facebook.com")
      ) || null;

    let totalCount = 0;
    const bodyText = document.body.innerText || "";
    const cm2 = bodyText.match(/(\d[\d,.]*)\s*(comments?|comentários?)/i);
    if (cm2) totalCount = parseInt(cm2[1].replace(/[,.]/g, ""), 10);
    if (totalCount === 0 && comments.length > 0) totalCount = comments.length;

    return {
      ok: true, comments, hasMore: !!nextLink, nextUrl: nextLink ? nextLink.href : null, totalCount,
      debugUrl: url, debugStrategy: `mbasic_containers:${containers.length}`,
    };
  } catch (e) {
    return { ok: false, error: e.message, comments: [], hasMore: false, nextUrl: null, totalCount: 0, debugUrl: window.location.href };
  }
}

// Script injetado para clicar em "Ver mais comentários" no www.facebook.com
function _fbClickLoadMore() {
  const allClickable = Array.from(document.querySelectorAll('[role="button"], button'));
  const btn = allClickable.find(el => {
    const t = (el.innerText || el.textContent || "").trim();
    return /(\d+\s*)?(view|see|load|ver|mostrar|carregar)\s*(\d+\s*)?(more|mais|all|todos)\s*(comments?|comentários?|replies?|respostas?)/i.test(t)
      || /\d+\s*(comments?|comentários?)\s*$/i.test(t);
  });
  if (btn) { btn.click(); return { clicked: true, btnText: (btn.innerText || btn.textContent || "").trim() }; }
  return { clicked: false };
}

/** Navega a aba FB para `pageUrl` (ou fica na mesma página se null), injeta extractor.
 *  Se estiver no www e tiver botão "Ver mais", clica + espera antes de extrair.
 *  `navigate=false` para apenas extrair sem mudar de página.
 */
async function fbExtractPage(pageUrl, { navigate = true, clickMore = false } = {}) {
  const tabId = await getFbTab();

  if (navigate) {
    await chrome.tabs.update(tabId, { url: pageUrl });
    await waitForTabComplete(tabId, 20000);
    // Polling inteligente: espera comentários aparecerem no DOM (até 14s)
    // Substitui sleep fixo — mais rápido se rápido, mais robusto se lento
    const found = await _fbWaitForComments(tabId, 14000);
    if (!found) await sleep(2000); // fallback: aguarda mais 2s
  }

  if (clickMore) {
    await chrome.scripting.executeScript({ target: { tabId }, func: _fbClickLoadMore, world: "ISOLATED" });
    await sleep(600);
    await _fbWaitForComments(tabId, 6000);
  }

  // URL real após navegação
  let finalUrl = pageUrl || "";
  try { const tab = await chrome.tabs.get(tabId); finalUrl = tab.url || finalUrl; } catch (_) {}
  if (/login|checkpoint|recover|disabled/i.test(finalUrl)) {
    return { ok: false, error: "LOGIN_REQUIRED", comments: [], hasMore: false, nextUrl: null, totalCount: 0, debugUrl: finalUrl };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId }, func: _fbExtractComments, world: "ISOLATED",
  });
  return results[0]?.result ?? { ok: false, error: "no result", comments: [], hasMore: false, nextUrl: null, totalCount: 0, debugUrl: finalUrl };
}

/** Mapeia um comentário mbasic para linha de CSV */
function toFbCommentRow(c) {
  return {
    "Comment Id":  c.commentId   || "",
    "Username":    c.username    || "",
    "User Id":     "",
    "Comment":     c.text        || "",
    "Date":        c.dateStr     || "",
    "Profile URL": c.profileUrl  || "",
    "Avatar URL":  c.avatarUrl   || "",
  };
}

/** Extração principal de comentários do Facebook */
async function runFbCommentsExtraction() {
  const cfg = await getConfig();
  state.delayMs      = cfg.delayMs     ?? 1200;
  state.maxFollowers = cfg.maxFollowers ?? 0;

  const originalUrl = state.fbUrl || state.username;
  // Navega sempre para www.facebook.com (mbasic redireciona de volta pro www)
  const wwwUrl = originalUrl
    .replace(/(?:mbasic|m)\.facebook\.com/, "www.facebook.com")
    .replace(/^(?!https?:\/\/)/, "https://www.");

  broadcast("STATUS", { msg: `Abrindo post do Facebook…` });
  broadcast("STATUS", { msg: `URL: ${wwwUrl}` });

  let totalCount   = 0;
  let pageNum      = 0;
  let historySaved = false;
  const seenIds    = new Set();
  let consecutiveNoNew = 0;

  // Primeira carga: navega para a URL
  let result;
  try {
    result = await fbExtractPage(wwwUrl, { navigate: true, clickMore: false });
  } catch (e) {
    broadcast("ERROR", { msg: `Erro ao carregar página: ${e.message}` });
    state.running = false;
    return;
  }

  while (state.running) {
    while (state.paused && state.running) await sleep(500);
    if (!state.running) break;

    pageNum++;
    state.page = pageNum;

    // Debug
    if (result.debugUrl) broadcast("STATUS", { msg: `[debug] ${result.debugStrategy || ""} | URL: ${result.debugUrl}` });

    if (!result.ok) {
      if (result.error === "LOGIN_REQUIRED") {
        broadcast("ERROR", { msg: `Facebook requer login. Faça login no Facebook na aba aberta e tente novamente.` });
        state.running = false;
        break;
      }
      broadcast("STATUS", { msg: `Erro FB: ${result.error} — aguardando 10s…` });
      await sleep(10000);
      // Retenta sem navegar
      try { result = await fbExtractPage(null, { navigate: false }); } catch (_) {}
      continue;
    }

    if (result.totalCount > 0 && totalCount === 0) totalCount = result.totalCount;

    let newCount = 0;
    for (const comment of result.comments) {
      const cid = String(comment.commentId || (comment.username + "|" + comment.text.slice(0, 40)));
      if (seenIds.has(cid)) continue;
      seenIds.add(cid);
      state.followers.push(toFbCommentRow(comment));
      newCount++;
    }

    state.pageTimestamps.push(Date.now());
    if (state.pageTimestamps.length > 20) state.pageTimestamps.shift();
    const elapsed = state.pageTimestamps.length > 1
      ? (state.pageTimestamps.at(-1) - state.pageTimestamps[0]) / 60000 : 1;
    const ppm = elapsed > 0 ? (state.pageTimestamps.length / elapsed).toFixed(1) : "—";

    broadcast("PROGRESS", {
      extracted: state.followers.length,
      total:     totalCount || state.followers.length,
      page:      pageNum, ppm,
      logLine:   `Pág ${pageNum}: +${newCount} novos (total: ${state.followers.length})`,
    });

    // Verifica limite
    if (state.maxFollowers > 0 && state.followers.length >= state.maxFollowers) {
      broadcast("DONE", { extracted: state.followers.length, total: totalCount });
      state.running = false;
      return;
    }

    // mbasic: usa nextUrl para navegar
    if (result.nextUrl) {
      const nextUrl = result.nextUrl.includes("facebook.com") ? result.nextUrl : fbUrlToMbasic(result.nextUrl);
      const delay = state.delayMs * (0.7 + Math.random() * 0.6);
      await sleep(delay);
      try { result = await fbExtractPage(nextUrl, { navigate: true, clickMore: false }); } catch (e) {
        broadcast("STATUS", { msg: `Erro: ${e.message}` }); await sleep(8000);
        try { result = await fbExtractPage(nextUrl, { navigate: true }); } catch (_) { break; }
      }
      continue;
    }

    // www: usa click em "Ver mais comentários"
    if (result.hasMore && newCount >= 0) {
      consecutiveNoNew = newCount === 0 ? consecutiveNoNew + 1 : 0;
      if (consecutiveNoNew >= 3) {
        // Sem novos comentários por 3 cliques seguidos: encerrar
        break;
      }
      const delay = state.delayMs * (0.6 + Math.random() * 0.5);
      await sleep(delay);
      try { result = await fbExtractPage(null, { navigate: false, clickMore: true }); } catch (e) {
        broadcast("STATUS", { msg: `Erro ao clicar: ${e.message}` }); break;
      }
      continue;
    }

    // Sem mais comentários
    break;
  }

  // Fim
  const meta = { followers: state.followers.length, following: 0, posts: 0, fullname: "", userId: originalUrl };
  if (!historySaved && state.followers.length > 0) {
    await saveHistory(meta, "comments").catch(() => {});
    historySaved = true;
  }
  await savePartialFollowers().catch(() => {});
  await saveState();
  broadcast("DONE", { extracted: state.followers.length, total: totalCount || state.followers.length });
  state.running = false;
}

// Extração principal de curtidas
async function runLikesExtraction() {
  const cfg = await getConfig();
  state.delayMs       = cfg.delayMs      ?? 1200;
  state.rotateAfter   = cfg.rotateAfter  ?? 4;
  state.maxFollowers  = cfg.maxFollowers ?? 0;
  state.adaptiveDelay = state.delayMs;

  const profiles = await getProfiles();
  state.accountPool = profiles.map((p, i) => ({
    profile: p, name: p.name || `Perfil ${i + 1}`,
    cooldownUntil: 0, totalRequests: 0, errors: 0,
    wwwClaim: "0",
  }));
  state.poolIndex = 1;
  const usePool = state.accountPool.length > 0;

  if (usePool) {
    currentIgAccount = state.accountPool[0];
    await applyCookies(state.accountPool[0].profile);
    igWwwClaim = "0";
    try {
      const existingTabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
      if (existingTabs.length) {
        igTabId = existingTabs[0].id;
        await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
        await waitForTabComplete(igTabId, 15000);
        await sleep(1200);
      }
    } catch (_) {}
  }

  // Warm-up: visita o post antes de chamar a API
  let mediaId;
  try {
    mediaId = shortcodeToMediaId(state.username); // username stores the shortcode
  } catch (e) {
    broadcast("ERROR", { msg: `Shortcode inválido: ${e.message}` });
    state.running = false;
    return;
  }

  broadcast("STATUS", { msg: `Carregando post ${state.username}…` });
  try {
    const warmTabId = igTabId !== null ? igTabId : await getIgTab();
    igTabId = warmTabId;
    await chrome.tabs.update(warmTabId, { url: `https://www.instagram.com/p/${state.username}/` });
    await waitForTabComplete(warmTabId, 12000);
    await sleep(1500 + Math.random() * 2000);
  } catch (_) {}

  broadcast("STATUS", { msg: `Extraindo curtidas do post ${state.username} (media_id: ${mediaId})…` });

  let cursor           = null;
  let totalLikes       = 0;
  let nextBreakAtPage  = 10 + Math.floor(Math.random() * 6);
  let historySaved     = false;
  let pagesWithCurrent = 0;
  const seenIds        = new Set();

  while (state.running) {
    if (state.paused) { await sleep(300); continue; }
    if (state.maxFollowers > 0 && state.followers.length >= state.maxFollowers) {
      broadcast("DONE", { extracted: state.followers.length, total: totalLikes, pages: state.page, limitReached: true });
      state.running = false;
      break;
    }

    // Rotação de conta — baseada em páginas (igual ao módulo de seguidores)
    if (usePool && state.rotateAfter > 0 && pagesWithCurrent >= state.rotateAfter) {
      const next = getNextAccount();
      if (!next) { await sleep(200); continue; }
      if (next.waitMs) {
        broadcast("STATUS", {
          msg: `Todas as contas em cooldown — aguardando ~${Math.ceil(next.waitMs / 1000)}s…`,
          extracted: state.followers.length,
        });
        await sleepKeepAlive(next.waitMs, s =>
          broadcast("STATUS", { msg: `⏸ Cooldown — retomando em ~${s}s…`, extracted: state.followers.length })
        );
        continue;
      }
      broadcast("STATUS", { msg: `Rotacionando para ${next.name}…`, extracted: state.followers.length });
      if (currentIgAccount) currentIgAccount.wwwClaim = igWwwClaim;
      await applyCookies(next.profile);
      currentIgAccount = next;
      igWwwClaim = next.wwwClaim || "0";
      if (igTabId !== null) {
        try {
          await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
          await waitForTabComplete(igTabId, 12000);
          await sleep(800 + Math.random() * 700);
          const authed = await checkTabAuth(igTabId);
          if (!authed) {
            broadcast("STATUS", { msg: `⚠ ${next.name} — cookie inválido, desativando 5min e tentando próxima conta…`, extracted: state.followers.length });
            next.cooldownUntil = Date.now() + 300000;
            next.errors++;
            pagesWithCurrent = 0;
            continue;
          }
        } catch (_) { igTabId = null; }
      }
      pagesWithCurrent = 0;
    }

    // Identifica conta atual (selecionada pelo último getNextAccount)
    const currentAccount = usePool
      ? state.accountPool[(state.poolIndex - 1 + state.accountPool.length) % state.accountPool.length]
      : null;

    // Pausa humana — a cada 10–16 páginas, pausa de 5–17s
    if (state.page >= nextBreakAtPage) {
      const breakMs = 5000 + Math.random() * 12000;
      broadcast("STATUS", { msg: `☕ Pausa — retomando em ${Math.round(breakMs/1000)}s…`, extracted: state.followers.length });
      await sleepKeepAlive(breakMs);
      if (!state.running) break;
      nextBreakAtPage = state.page + 10 + Math.floor(Math.random() * 6);
    }

    try {
      const { users, nextCursor, userCount } = await fetchLikersPage(mediaId, cursor);
      if (userCount > 0 && totalLikes === 0) totalLikes = userCount;
      state.page++;
      pagesWithCurrent++;
      recordPageTime();
      onSuccess();
      if (currentAccount) currentAccount.totalRequests++;
      if (state.page % 10 === 0) savePartialFollowers().catch(() => {});

      let newCount = 0;
      for (const u of users) {
        const uid = String(u.pk || u.id || "");
        if (uid && seenIds.has(uid)) continue;
        if (uid) seenIds.add(uid);
        state.followers.push(toRow(u));
        newCount++;
      }
      cursor = nextCursor;

      const speed = getSpeedStats();
      const poolStatusStr = usePool
        ? ` | ${currentAccount?.name || "?"} (${state.accountPool.filter(a => a.cooldownUntil <= Date.now()).length}/${state.accountPool.length} disponíveis)`
        : "";
      broadcast("PROGRESS", {
        extracted:     state.followers.length,
        total:         totalLikes,
        page:          state.page,
        hasMore:       !!nextCursor,
        ppm:           speed.ppm,
        spm:           speed.spm,
        etaSec:        0,
        adaptiveDelay: state.adaptiveDelay,
        poolStatus:    poolStatusStr,
        logLine: `Pág. ${state.page} | +${newCount} curtidas | ${speed.ppm} pág/min | delay ${state.adaptiveDelay}ms${poolStatusStr}`,
      });

      if (!nextCursor || (users.length === 0)) {
        broadcast("DONE", { extracted: state.followers.length, total: totalLikes, pages: state.page });
        await saveHistory({ followers: totalLikes, following: 0, posts: 0, fullname: "", userId: mediaId }, "likes");
        historySaved = true;
        state.running = false;
        break;
      }

      await sleep(jitter(state.adaptiveDelay));

    } catch (e) {
      if (e.message === "RATE_LIMIT") {
        onRateLimit(currentAccount); // passa conta atual para cooldown individual
        broadcast("STATUS", {
          msg: `Rate limit${currentAccount ? ` (${currentAccount.name})` : ""} — cooldown 60s | delay ${state.adaptiveDelay}ms`,
          extracted: state.followers.length,
        });
        if (!usePool || state.accountPool.every(a => a.cooldownUntil > Date.now())) {
          await sleepKeepAlive(60000, s =>
            broadcast("STATUS", { msg: `⏸ Rate limit — ~${s}s…`, extracted: state.followers.length })
          );
          if (!state.running) break;
        }
        continue;
      }
      if (e.message === "AUTH_FAIL") {
        if (currentAccount) {
          currentAccount.cooldownUntil = Date.now() + 300000;
          currentAccount.errors++;
          broadcast("STATUS", {
            msg: `Auth falhou (${currentAccount.name}) — desativando 5min, tentando próxima conta…`,
            extracted: state.followers.length,
          });
          const nextOnFail = getNextAccount();
          if (nextOnFail && !nextOnFail.waitMs) {
            if (currentIgAccount) currentIgAccount.wwwClaim = igWwwClaim;
            await applyCookies(nextOnFail.profile);
            currentIgAccount = nextOnFail;
            igWwwClaim = nextOnFail.wwwClaim || "0";
            if (igTabId !== null) {
              try {
                await chrome.tabs.update(igTabId, { url: "https://www.instagram.com/" });
                await waitForTabComplete(igTabId, 12000);
                await sleep(1000 + Math.random() * 500);
              } catch (_) { igTabId = null; }
            }
            pagesWithCurrent = 0;
            continue;
          } else {
            const waitMs2 = nextOnFail?.waitMs ?? 300000;
            broadcast("STATUS", {
              msg: `⏸ Todas as contas bloqueadas — retomando em ~${Math.ceil(waitMs2 / 1000)}s…`,
              extracted: state.followers.length,
            });
            await sleepKeepAlive(waitMs2 + 2000, s =>
              broadcast("STATUS", { msg: `⏸ Aguardando desbloqueio… ~${s}s`, extracted: state.followers.length })
            );
            if (!state.running) break;
            pagesWithCurrent = 0;
            continue;
          }
        } else {
          broadcast("ERROR", { msg: "Sessão inválida. Recapture os cookies e tente novamente." });
          state.running = false;
          break;
        }
      }
      broadcast("STATUS", { msg: `Erro: ${e.message} — aguardando 10s…`, extracted: state.followers.length });
      await sleep(10000);
    }
  }

  state.running = false;
  if (!historySaved && state.followers.length > 0) {
    await saveHistory({ followers: totalLikes || state.followers.length, following: 0, posts: 0, fullname: "", userId: mediaId }, "likes").catch(() => {});
  }
  await savePartialFollowers().catch(() => {});
  await saveState();
}

// ---------------------------------------------------------------------------
// Versão standalone de fetchCommentsPage — não depende de state.username/urlType
// Usada pelo motor de comentários de perfil.
// ---------------------------------------------------------------------------
async function fetchCommentsForPost(mediaId, shortcode, cursor) {
  let url = `https://www.instagram.com/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false`;
  if (cursor) url += `&min_id=${encodeURIComponent(cursor)}`;
  const referer = `https://www.instagram.com/p/${shortcode}/`;
  const json    = await igFetch(url, referer);
  return {
    comments:   json.comments    || [],
    totalCount: json.comment_count ?? 0,
    nextCursor: json.has_more_comments ? (json.next_min_id || null) : null,
  };
}

// ---------------------------------------------------------------------------
// Estado da extração de comentários de todos os posts de um perfil
// ---------------------------------------------------------------------------
const profileCommentsState = {
  running:        false,
  targetUsername: "",
  maxPosts:       0,  // 0 = todos
  maxPerPost:     0,  // 0 = todos
  rows:           [],
  scannedPosts:   0,
  totalPosts:     0,
  totalComments:  0,
};

// ---------------------------------------------------------------------------
// Motor: extrai todos os comentários de todos os posts de um perfil
// ---------------------------------------------------------------------------
async function runProfileCommentsExtraction() {
  const username = profileCommentsState.targetUsername;

  broadcast("PC_STATUS", { msg: `Resolvendo @${username}…` });

  // Warm-up: visita o perfil (opcional mas anti-detecção)
  try {
    const warmTabId = igTabId !== null ? igTabId : await getIgTab();
    igTabId = warmTabId;
    await chrome.tabs.update(warmTabId, { url: `https://www.instagram.com/${username}/` });
    await waitForTabComplete(warmTabId, 12000);
    await sleep(1000 + Math.random() * 1000);
  } catch (_) {}

  // Resolve userId
  let meta;
  try {
    meta = await resolveUserId(username);
  } catch (e) {
    broadcast("PC_ERROR", { msg: `Perfil não encontrado: ${e.message}` });
    profileCommentsState.running = false;
    return;
  }

  broadcast("PC_STATUS", {
    msg: `@${username} — ${meta.posts.toLocaleString("pt-BR")} posts · buscando lista…`,
  });

  // ── FASE 1: coleta todos os posts ──────────────────────────────────────
  const maxPosts   = profileCommentsState.maxPosts   || Infinity;
  const maxPerPost = profileCommentsState.maxPerPost || Infinity;
  const allPosts   = [];
  let   postCursor = null;

  while (profileCommentsState.running && allPosts.length < maxPosts) {
    const batchSize = Math.min(12, maxPosts - allPosts.length);
    try {
      const feedJson = await fetchUserFeed(meta.userId, postCursor, batchSize);
      const items    = feedJson?.items || [];
      if (!items.length) break;

      for (const item of items) {
        if (allPosts.length >= maxPosts) break;
        const shortCode = item.code || "";
        if (!shortCode) continue;
        let mediaId;
        try { mediaId = shortcodeToMediaId(shortCode); } catch (_) { continue; }
        allPosts.push({
          shortCode,
          mediaId,
          url:          `https://www.instagram.com/p/${shortCode}/`,
          caption:      (item.caption?.text || "").slice(0, 150).replace(/[\r\n]+/g, " "),
          takenAt:      item.taken_at || 0,
          commentCount: item.comment_count || 0,
        });
      }

      broadcast("PC_STATUS", { msg: `${allPosts.length} posts encontrados…` });
      if (!feedJson.more_available || !feedJson.next_max_id) break;
      postCursor = feedJson.next_max_id;
      await sleep(600 + Math.random() * 400);
    } catch (e) {
      broadcast("PC_STATUS", { msg: `⚠ Erro ao buscar posts: ${e.message}` });
      break;
    }
  }

  if (!profileCommentsState.running) {
    broadcast("PC_ERROR", { msg: "Parado pelo usuário." });
    profileCommentsState.running = false;
    return;
  }

  profileCommentsState.totalPosts = allPosts.length;
  const postsWithComments = allPosts.filter(p => p.commentCount > 0).length;
  broadcast("PC_STATUS", {
    msg: `${allPosts.length} posts · ${postsWithComments} com comentários · iniciando extração…`,
  });

  // ── FASE 2: extrai comentários de cada post ───────────────────────────
  const rows        = [];
  const seenKeys    = new Set();

  for (let i = 0; i < allPosts.length; i++) {
    if (!profileCommentsState.running) break;
    const post = allPosts[i];

    if (post.commentCount === 0) {
      profileCommentsState.scannedPosts = i + 1;
      continue; // pula silenciosamente posts sem comentários
    }

    broadcast("PC_STATUS", {
      msg: `Post ${i + 1}/${allPosts.length}: ${post.shortCode} (~${post.commentCount} comentários)…`,
    });

    let commentCursor    = null;
    let postCommentCount = 0;

    while (profileCommentsState.running && postCommentCount < maxPerPost) {
      try {
        const { comments, nextCursor } = await fetchCommentsForPost(
          post.mediaId, post.shortCode, commentCursor
        );

        for (const c of comments) {
          if (postCommentCount >= maxPerPost) break;
          const cid = String(c.pk || c.id || "");
          const key = cid || `${c.user?.username}|${(c.text || "").slice(0, 40)}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          const ts   = c.created_at_utc ?? c.created_at ?? null;
          const date = ts ? new Date(ts * 1000).toLocaleString("pt-BR") : "";
          rows.push({
            "Post URL":       post.url,
            "Post Shortcode": post.shortCode,
            "Post Caption":   post.caption,
            "Comment Id":     cid,
            "Username":       c.user?.username           || "",
            "User Id":        String(c.user?.pk || ""),
            "Comment":        c.text                     || "",
            "Date":           date,
            "Profile URL":    c.user?.username ? `https://www.instagram.com/${c.user.username}/` : "",
            "Avatar URL":     c.user?.profile_pic_url    || "",
          });
          postCommentCount++;
        }

        broadcast("PC_PROGRESS", {
          post:          i + 1,
          totalPosts:    allPosts.length,
          totalComments: rows.length,
          logLine:       `Post ${i + 1}/${allPosts.length} (${post.shortCode}): +${postCommentCount} comentários · total: ${rows.length}`,
        });

        if (!nextCursor) break;
        commentCursor = nextCursor;
        await sleep(500 + Math.random() * 400);
      } catch (e) {
        if (e.message === "RATE_LIMIT") {
          broadcast("PC_STATUS", { msg: `⏸ Rate limit — aguardando 60s…` });
          await sleepKeepAlive(60000, s => broadcast("PC_STATUS", { msg: `⏸ Rate limit — retomando em ${s}s…` }));
          if (!profileCommentsState.running) break;
          continue;
        }
        broadcast("PC_STATUS", { msg: `⚠ ${post.shortCode}: ${e.message} — pulando…` });
        break;
      }
    }

    profileCommentsState.scannedPosts  = i + 1;
    profileCommentsState.totalComments = rows.length;

    // Pausa humana entre posts
    if (i < allPosts.length - 1 && profileCommentsState.running) {
      await sleep(700 + Math.random() * 600);
    }
  }

  profileCommentsState.rows    = rows;
  profileCommentsState.running = false;
  broadcast("PC_DONE", {
    totalComments: rows.length,
    totalPosts:    profileCommentsState.scannedPosts,
  });
}

// ---------------------------------------------------------------------------
// Estado da extração de perfil — isolado do state principal
// ---------------------------------------------------------------------------
const profileState = {
  running:        false,
  targetUsername: "",
  maxPosts:       12,
  data:           null,
};

// ---------------------------------------------------------------------------
// API: informações detalhadas do perfil (biografia, contato, flags)
// ---------------------------------------------------------------------------
async function fetchUserInfo(userId) {
  const url  = `https://www.instagram.com/api/v1/users/${userId}/info/`;
  const json = await igFetch(url, `https://www.instagram.com/`);
  return json?.user || null;
}

// ---------------------------------------------------------------------------
// API: feed de posts do usuário (paginado, 12 por página)
// ---------------------------------------------------------------------------
async function fetchUserFeed(userId, cursor = null, count = 12) {
  let url = `https://www.instagram.com/api/v1/feed/user/${userId}/?count=${count}&exclude_comment=true&only_fetch_first_carousel_media=false`;
  if (cursor) url += `&max_id=${encodeURIComponent(cursor)}`;
  return await igFetch(url, `https://www.instagram.com/${profileState.targetUsername}/`);
}

// ---------------------------------------------------------------------------
// Converte item do feed para objeto rico — formato compatível com Apify
// ---------------------------------------------------------------------------
function toPostObject(item) {
  const captionText = item.caption?.text || "";
  // Regex aceita hashtags e mentions com caracteres Unicode (português, etc.)
  const hashtags    = captionText.match(/#[\wÀ-ɏЀ-ӿ]+/g) || [];
  const mentions    = captionText.match(/@[\w.]+/g) || [];
  const mediaType   = (item.carousel_media_count || 0) > 0 ? "Sidecar"
    : item.is_video ? "Video" : "Image";
  const shortCode   = item.code || "";
  const imageUrl    = item.image_versions2?.candidates?.[0]?.url
    || item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url
    || "";
  const childPosts  = (item.carousel_media || []).map(c => ({
    id:             c.pk || c.id || "",
    type:           c.is_video ? "Video" : "Image",
    imageUrl:       c.image_versions2?.candidates?.[0]?.url || "",
    videoViewCount: c.view_count || 0,
  }));
  const obj = {
    id:             String(item.pk || item.id || ""),
    shortCode,
    url:            shortCode ? `https://www.instagram.com/p/${shortCode}/` : "",
    type:           mediaType,
    caption:        captionText,
    hashtags,
    mentions,
    likesCount:     item.like_count     || 0,
    commentsCount:  item.comment_count  || 0,
    videoViewCount: item.view_count     || item.video_view_count || 0,
    timestamp:      item.taken_at ? new Date(item.taken_at * 1000).toISOString() : null,
    imageUrl,
  };
  if (childPosts.length > 0) obj.childPosts = childPosts;
  return obj;
}

// ---------------------------------------------------------------------------
// Motor de scraping de perfil — busca bio + posts em formato rico
// ---------------------------------------------------------------------------
async function runProfileScrape() {
  const username = profileState.targetUsername;

  broadcast("PROFILE_STATUS", { msg: `Carregando @${username}…` });

  // Warm-up: visita o perfil (simula usuário real abrindo a página)
  try {
    const warmTabId = igTabId !== null ? igTabId : await getIgTab();
    igTabId = warmTabId;
    await chrome.tabs.update(warmTabId, { url: `https://www.instagram.com/${username}/` });
    await waitForTabComplete(warmTabId, 12000);
    await sleep(1200 + Math.random() * 1500);
  } catch (_) {}

  // Resolve userId + dados básicos via web_profile_info
  let meta;
  try {
    meta = await resolveUserId(username);
  } catch (e) {
    broadcast("PROFILE_ERROR", { msg: `Perfil não encontrado ou privado: ${e.message}` });
    profileState.running = false;
    return;
  }

  broadcast("PROFILE_STATUS", {
    msg: `@${username} encontrado — ${meta.followers.toLocaleString("pt-BR")} seguidores · buscando dados detalhados…`,
  });

  // Info completa: biography, contact, business flags, profile_pic_url_hd
  let userInfo = null;
  try {
    userInfo = await fetchUserInfo(meta.userId);
    await sleep(500 + Math.random() * 400);
  } catch (e) {
    broadcast("PROFILE_STATUS", { msg: `⚠ Info detalhada indisponível: ${e.message}` });
  }

  const u = userInfo || {};

  // External URLs — combina bio_links e external_url sem duplicatas
  const extUrls = [];
  if (u.external_url) extUrls.push(u.external_url);
  (u.bio_links || []).forEach(l => {
    const link = l.url || l.link_url || "";
    if (link && !extUrls.includes(link)) extUrls.push(link);
  });

  const profileData = {
    id:                   meta.userId,
    username,
    fullName:             u.full_name        || meta.fullname  || "",
    biography:            u.biography        || "",
    externalUrls:         extUrls,
    followersCount:       u.follower_count   || meta.followers || 0,
    followsCount:         u.following_count  || meta.following || 0,
    postsCount:           u.media_count      || meta.posts     || 0,
    isBusinessAccount:    u.is_business      || u.is_professional_account || false,
    isVerified:           u.is_verified      || false,
    isPrivate:            u.is_private       || meta.isPrivate || false,
    profilePicUrl:        u.profile_pic_url_hd || u.profile_pic_url || "",
    fbid:                 u.fbid             || "",
    businessCategoryName: u.category_name    || u.category     || "",
    contactEmail:         u.public_email     || "",
    contactPhone:         u.public_phone_number || "",
    latestPosts:          [],
    scrapedAt:            new Date().toISOString(),
  };

  // Busca posts paginando até atingir maxPosts
  const maxPosts = profileState.maxPosts || 0;
  if (maxPosts > 0) {
    broadcast("PROFILE_STATUS", { msg: `Buscando posts (limite: ${maxPosts})…` });

    let postCursor = null;
    let fetched    = 0;

    while (profileState.running && fetched < maxPosts) {
      const batchSize = Math.min(12, maxPosts - fetched);
      try {
        const feedJson = await fetchUserFeed(meta.userId, postCursor, batchSize);
        const items    = feedJson?.items || [];
        if (!items.length) break;

        for (const item of items) {
          if (fetched >= maxPosts) break;
          profileData.latestPosts.push(toPostObject(item));
          fetched++;
        }

        broadcast("PROFILE_STATUS", { msg: `${fetched} posts carregados…` });

        if (!feedJson.more_available || !feedJson.next_max_id) break;
        postCursor = feedJson.next_max_id;
        await sleep(700 + Math.random() * 500);
      } catch (e) {
        broadcast("PROFILE_STATUS", { msg: `⚠ Erro ao buscar posts: ${e.message}` });
        break;
      }
    }
  }

  profileState.data    = profileData;
  profileState.running = false;

  broadcast("PROFILE_DONE", { data: profileData });
}

// ---------------------------------------------------------------------------
// Listener de mensagens
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case "START": {
        if (state.running) { sendResponse({ ok: false, msg: "Já em execução." }); return; }
        state.running        = true;
        state.paused         = false;
        state.username       = msg.username.replace(/^@/, "").trim();
        state.userId         = "";
        state.followers      = [];
        state.cursor         = null;
        state.page           = 0;
        state.meta           = null;
        state.startedAt      = Date.now();
        state.extractionType = "followers";
        state.pageTimestamps = [];
        state.successStreak  = 0;
        await chrome.storage.local.remove("partialFollowers");
        runExtraction();
        sendResponse({ ok: true });
        break;
      }

      case "START_LIKES": {
        if (state.running) { sendResponse({ ok: false, msg: "Já em execução." }); return; }
        state.running        = true;
        state.paused         = false;
        state.username       = msg.shortcode; // shortcode stored in username field
        state.userId         = "";
        state.followers      = [];
        state.cursor         = null;
        state.page           = 0;
        state.meta           = null;
        state.startedAt      = Date.now();
        state.extractionType = "likes";
        state.pageTimestamps = [];
        state.successStreak  = 0;
        await chrome.storage.local.remove("partialFollowers");
        runLikesExtraction();
        sendResponse({ ok: true });
        break;
      }

      case "START_COMMENTS": {
        if (state.running) { sendResponse({ ok: false, msg: "Já em execução." }); return; }
        state.running        = true;
        state.paused         = false;
        state.username       = msg.shortcode; // shortcode / post identifier
        state.fbUrl          = msg.fbUrl || null; // URL completa do post FB (quando platform=facebook)
        state.platform       = msg.platform || "instagram";
        state.userId         = "";
        state.followers      = [];
        state.cursor         = null;
        state.page           = 0;
        state.meta           = null;
        state.startedAt      = Date.now();
        state.extractionType = "comments";
        state.urlType        = msg.urlType || "p"; // "p" | "reel" | "tv" (Instagram)
        state.pageTimestamps = [];
        state.successStreak  = 0;
        await chrome.storage.local.remove("partialFollowers");
        if (state.platform === "facebook") {
          runFbCommentsExtraction();
        } else {
          runCommentsExtraction();
        }
        sendResponse({ ok: true });
        break;
      }

      case "PAUSE": {
        state.paused = !state.paused;
        sendResponse({ ok: true, paused: state.paused });
        break;
      }

      case "STOP": {
        state.running = false;
        state.paused  = false;
        await savePartialFollowers().catch(() => {}); // salva antes do SW ser morto
        sendResponse({ ok: true, extracted: state.followers.length });
        break;
      }

      case "DOWNLOAD": {
        const rows = state.followers.length
          ? state.followers
          : (await chrome.storage.local.get("partialFollowers")).partialFollowers || [];
        if (!rows.length) { sendResponse({ ok: false, msg: "Nenhum dado para baixar." }); return; }
        // state.username pode estar vazio se o service worker foi reiniciado após a extração
        const username = state.username
          || (await chrome.storage.local.get("currentExtraction")).currentExtraction?.username
          || "unknown";
        const csv  = toCSV(rows);
        // TextEncoder → btoa: suporta qualquer Unicode (árabe, coreano, emoji, etc.)
        // unescape(encodeURIComponent()) é deprecated e falha com certos ranges acima de U+00FF
        const bytes  = new TextEncoder().encode("﻿" + csv); // BOM para Excel
        let binary   = "";
        bytes.forEach(b => { binary += String.fromCharCode(b); });
        const b64  = btoa(binary);
        const etype    = state.extractionType || "followers";
        const platform = state.platform || "instagram";
        const name = etype === "comments" && platform === "facebook"
          ? `FBComments_${rows.length}.csv`
          : etype === "comments"
          ? `IGComments_${username}_${rows.length}.csv`
          : etype === "likes"
          ? `IGLikes_${username}_${rows.length}.csv`
          : `IGFollow_${username}_${rows.length}_follower.csv`;
        await chrome.downloads.download({
          url:    `data:text/csv;charset=utf-8;base64,${b64}`,
          filename: name,
          saveAs: false,
        });
        sendResponse({ ok: true, filename: name, count: rows.length });
        break;
      }

      case "CAPTURE_COOKIES": {
        const cookies  = await captureCurrentCookies();
        const profiles = await getProfiles();
        const name     = msg.name || `Perfil ${profiles.length + 1}`;
        profiles.push({ name, cookies, capturedAt: Date.now() });
        await chrome.storage.local.set({ profiles });
        sendResponse({ ok: true, count: profiles.length });
        break;
      }

      case "IMPORT_COOKIE": {
        // Aceita dois formatos:
        //   1. Cookie string: "sessionid=abc; csrftoken=xyz; ..."
        //   2. JSON array:    [{"name":"sessionid","value":"abc",...}, ...]
        try {
          const profiles = await getProfiles();
          const name     = msg.name || `Perfil ${profiles.length + 1}`;
          let cookies    = [];

          const raw = msg.raw.trim();

          if (raw.startsWith("[") || raw.startsWith("{")) {
            // Formato JSON (exportado por Cookie Editor)
            const parsed = JSON.parse(raw.startsWith("{") ? `[${raw}]` : raw);
            cookies = parsed
              .filter(c => c.name && (c.value !== undefined))
              .map(c => ({
                name:     c.name,
                value:    String(c.value ?? ""),
                domain:   c.domain || ".instagram.com",
                path:     c.path   || "/",
                secure:   c.secure   ?? true,
                httpOnly: c.httpOnly ?? false,
                sameSite: c.sameSite || "no_restriction",
                expirationDate: c.expirationDate,
              }));
          } else {
            // Formato header string: "name=value; name2=value2"
            cookies = raw.split(";")
              .map(pair => {
                const idx   = pair.indexOf("=");
                if (idx < 0) return null;
                const cname = pair.slice(0, idx).trim();
                const cval  = pair.slice(idx + 1).trim();
                if (!cname) return null;
                return {
                  name:     cname,
                  value:    cval,
                  domain:   ".instagram.com",
                  path:     "/",
                  secure:   true,
                  httpOnly: false,
                  sameSite: "no_restriction",
                };
              })
              .filter(Boolean);
          }

          // Valida: precisa ter pelo menos sessionid
          const hasSession = cookies.some(c => c.name === "sessionid");
          if (!hasSession) {
            sendResponse({ ok: false, msg: "Cookie inválido — não encontrei o campo 'sessionid'. Verifique se copiou o cookie do Instagram." });
            break;
          }

          profiles.push({ name, cookies, capturedAt: Date.now(), manual: true });
          await chrome.storage.local.set({ profiles });
          sendResponse({ ok: true, msg: `Perfil "${name}" importado com ${cookies.length} cookies.`, name, cookieCount: cookies.length });
        } catch (e) {
          sendResponse({ ok: false, msg: `Erro ao parsear cookie: ${e.message}` });
        }
        break;
      }

      case "GET_PROFILES": {
        const profiles = await getProfiles();
        sendResponse({ ok: true, profiles: profiles.map((p, i) => ({ i, name: p.name, capturedAt: p.capturedAt })) });
        break;
      }

      case "DELETE_PROFILE": {
        const profiles = await getProfiles();
        profiles.splice(msg.index, 1);
        await chrome.storage.local.set({ profiles });
        sendResponse({ ok: true, count: profiles.length });
        break;
      }

      case "SAVE_CONFIG": {
        await chrome.storage.local.set({ config: msg.config });
        sendResponse({ ok: true });
        break;
      }

      case "GET_STATUS": {
        sendResponse({
          ok:        true,
          running:   state.running,
          paused:    state.paused,
          extracted: state.followers.length,
          username:  state.username,
          page:      state.page,
        });
        break;
      }

      case "GET_HISTORY": {
        const s = await chrome.storage.local.get("history");
        sendResponse({ ok: true, history: s.history || [] });
        break;
      }

      case "DELETE_HISTORY": {
        const s = await chrome.storage.local.get("history");
        const history = (s.history || []).filter(h => h.id !== msg.id);
        await chrome.storage.local.set({ history });
        sendResponse({ ok: true });
        break;
      }

      case "CLEAR_DATA": {
        state.followers = [];
        state.cursor    = null;
        state.page      = 0;
        await chrome.storage.local.remove(["partialFollowers", "currentExtraction"]);
        sendResponse({ ok: true });
        break;
      }

      case "SCRAPE_PROFILE_COMMENTS": {
        if (profileCommentsState.running) { sendResponse({ ok: false, msg: "Extração de comentários já em curso." }); return; }
        if (state.running || profileState.running) { sendResponse({ ok: false, msg: "Outra extração em curso — aguarde." }); return; }
        profileCommentsState.running        = true;
        profileCommentsState.targetUsername = (msg.username || "").replace(/^@/, "").trim();
        profileCommentsState.maxPosts       = parseInt(msg.maxPosts)   || 0;
        profileCommentsState.maxPerPost     = parseInt(msg.maxPerPost) || 0;
        profileCommentsState.rows           = [];
        profileCommentsState.scannedPosts   = 0;
        profileCommentsState.totalPosts     = 0;
        profileCommentsState.totalComments  = 0;
        runProfileCommentsExtraction();
        sendResponse({ ok: true });
        break;
      }

      case "STOP_PROFILE_COMMENTS": {
        profileCommentsState.running = false;
        sendResponse({ ok: true });
        break;
      }

      case "DOWNLOAD_PROFILE_COMMENTS": {
        const pcRows = profileCommentsState.rows;
        if (!pcRows.length) { sendResponse({ ok: false, msg: "Nenhum comentário para baixar." }); return; }

        // Agrupa por Post Shortcode → um arquivo CSV por post
        const byPost = new Map();
        for (const row of pcRows) {
          const key = row["Post Shortcode"] || "unknown";
          if (!byPost.has(key)) byPost.set(key, []);
          byPost.get(key).push(row);
        }

        let filesCreated = 0;
        for (const [shortcode, rows] of byPost) {
          const csv    = toCSV(rows);
          const bytes  = new TextEncoder().encode("﻿" + csv);
          let binary   = "";
          bytes.forEach(b => { binary += String.fromCharCode(b); });
          const b64    = btoa(binary);
          const name   = `IGComments_${profileCommentsState.targetUsername}_${shortcode}_${rows.length}.csv`;
          await chrome.downloads.download({
            url:      `data:text/csv;charset=utf-8;base64,${b64}`,
            filename: name,
            saveAs:   false,
          });
          filesCreated++;
          await sleep(80); // pausa mínima entre downloads para não sobrecarregar o browser
        }

        sendResponse({ ok: true, files: filesCreated, count: pcRows.length });
        break;
      }

      case "SCRAPE_PROFILE": {
        if (profileState.running) { sendResponse({ ok: false, msg: "Extração de perfil já em curso." }); return; }
        if (state.running)        { sendResponse({ ok: false, msg: "Outra extração em curso — aguarde terminar." }); return; }
        profileState.running        = true;
        profileState.targetUsername = (msg.username || "").replace(/^@/, "").trim();
        profileState.maxPosts       = parseInt(msg.maxPosts) || 0;
        profileState.data           = null;
        runProfileScrape();
        sendResponse({ ok: true });
        break;
      }

      case "STOP_PROFILE": {
        profileState.running = false;
        sendResponse({ ok: true });
        break;
      }

      case "DOWNLOAD_PROFILE": {
        const pdata = profileState.data;
        if (!pdata) { sendResponse({ ok: false, msg: "Nenhum perfil extraído ainda." }); return; }
        const jsonStr = JSON.stringify([pdata], null, 2);
        const bytes   = new TextEncoder().encode(jsonStr);
        let binary = "";
        bytes.forEach(b => { binary += String.fromCharCode(b); });
        const b64  = btoa(binary);
        const name = `IGProfile_${pdata.username}_${new Date().toISOString().slice(0, 10)}.json`;
        await chrome.downloads.download({
          url:      `data:application/json;charset=utf-8;base64,${b64}`,
          filename: name,
          saveAs:   false,
        });
        sendResponse({ ok: true, filename: name });
        break;
      }

      default:
        sendResponse({ ok: false, msg: "Comando desconhecido" });
    }
  })();
  return true;
});
