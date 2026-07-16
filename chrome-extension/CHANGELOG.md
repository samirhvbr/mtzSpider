# Spider Mobiliza — Changelog

## v3.5.3 — 2026-07-16
### Fix: vazamento de listener, CSV injection e portabilidade do script de análise

Três correções de robustez/segurança levantadas em revisão de código.

**1. Vazamento de listener em `waitForTabComplete` (background.js)**
No caminho de timeout, o `chrome.tabs.onUpdated` nunca era removido — o `removeListener` só rodava quando a aba chegava a `complete`. Cada espera que estourava o timeout deixava um listener órfão disparando em *todo* update de aba dali pra frente; e como cada rotação de conta recarrega a aba (chamando a função), numa extração longa acumulavam dezenas. Agora o `removeListener` roda **sempre**, centralizado no `finish()` (+ `clearTimeout` no caminho de sucesso).

**2. CSV injection / fórmula (`toCSV`, background.js)**
O escape tratava aspas (evita quebrar a estrutura do CSV) mas **não** neutralizava fórmula: valores começando com `=` `+` `-` `@` (ou TAB/CR) são executados como fórmula pelo Excel/Sheets ao abrir o arquivo. Campos como `Bio`, `Comment`, `Fullname` e `Username` são 100% controlados pelo perfil extraído — bastava o alvo pôr `=HYPERLINK(...)` na bio para atingir quem **abre** o CSV. Fix: prefixa aspa simples nos valores com caractere-gatilho (mitigação OWASP).

**3. Caminhos absolutos no `analyze_fake_followers.py`**
`CSV_PATH`/`OUTPUT_DIR` eram absolutos de macOS (`/Users/jeanmortaza/Downloads/…`) fixos no código — não rodava em nenhuma outra máquina, e o `mkdir` executava só de importar o módulo. Agora entrada/saída vêm da linha de comando via `argparse`: `python analyze_fake_followers.py <csv> [-o pasta]`. O corpo do relatório segue especializado para @majucotrim (conteúdo/branding + dados do Social Blade) — generalizar isso é um trabalho à parte, fora do escopo deste fix.

---

## v3.5.2 — 2026-05-30
### Fix: paginação de comentários parava prematuramente

Instagram retorna `has_more_comments: false` mesmo quando há mais páginas disponíveis via `next_min_id`. Nosso `??` respeitava esse `false` e descartava o cursor, parando depois da 1ª página. Fix: `next_min_id` presente = há mais páginas, ponto final — `has_more_comments` é ignorado. Mesmo fix aplicado ao `fetchChildCommentsPage` para replies.

---

## v3.5.1 — 2026-05-30
### Fix: extração de comentários inclui respostas (replies)

O `comment_count` do Instagram inclui **top-level + respostas**. Antes, só os comentários de nível 1 eram extraídos (ex: 15 de 94).

#### Como funciona agora
- **Fase 1** (existente): extrai todos os comentários top-level via paginação `min_id`
  - `preview_child_comments` (até ~3 respostas por comentário) já vêm na resposta → adicionados de graça, sem request extra
  - Comentários com `child_comment_count > preview.length` são enfileirados para a Fase 2
- **Fase 2** (nova): para cada comentário com replies pendentes, pagina `/child_comments/?max_id={cursor}` até esgotar
  - Deduplicação via `seenIds` — as respostas do preview não são duplicadas
  - Rate limit individual com cooldown 60s + retry
  - Erros pontuais pulam o comentário pai sem interromper a extração
- **Nova coluna no CSV**: `"Parent Id"` — vazio para top-level, ID do comentário pai para respostas

---

## v3.5.0 — 2026-05-29
### UI redesign: entrada inteligente unificada

Reescrita completa da interface. Saiu a proliferação de abas por tipo de extração; entrou uma entrada única que detecta o tipo e mostra ações contextuais.

#### O que mudou

**Aba "🕷 Extrair" — smart input**
- Campo único aceita qualquer coisa: URL do Instagram/Facebook, `@usuario` ou shortcode puro
- Detecção automática do tipo ao digitar/colar (sem botão de confirmar):
  - Perfil IG → [👥 Seguidores] [📊 Dados do perfil + Posts] [💬 Comentários dos posts]
  - Post/Reel IG → [❤️ Curtidas] [💬 Comentários]
  - Post do Facebook → [💬 Comentários]
- Chip de confirmação (`"👤 Perfil @eduardogomestocantins"`) aparece abaixo do input
- Botão ativo fica destacado com cor sólida correspondente à ação
- Painel de extração (opções + stats + progresso + log) aparece automaticamente após selecionar ação
- Cor da barra de progresso e cor do botão Iniciar seguem a ação escolhida
- Input e botão de limpar ficam bloqueados durante extração ativa
- Histórico: botão "↻ Reextrair" preenche o smart input e dispara detecção automaticamente

**Redução de abas: 7 → 4**
Removidas as abas separadas de Seguidores, Curtidas, Comentários, Perfil, Comentários de Perfil — tudo consolidado em "🕷 Extrair". Permanecem: Extrair · Perfis · Histórico · Config.

**Novo CSS (tab.css)**
- `.smart-card`, `.smart-header`, `.smart-title` — card principal com destaque
- `.smart-input-row`, `.smart-input` — campo grande e proeminente
- `.smart-detect`, `.smart-chip-row`, `.smart-chip` — área de detecção
- `.smart-actions`, `.smart-action-btn`, `.sa-green/.sa-blue/.sa-red/.sa-indigo` — botões de ação com variantes de cor + estado `.active`
- `.sm-fields`, `.sm-field` — campos de opção dinâmicos
- `.btn-action-green/.blue/.red/.indigo` — variantes de cor para o botão Iniciar
- `.scrape-avatar-placeholder` — avatar por inicial (CSP bloqueia CDN do Instagram)
- `.prog-bar-wrap`, `.prog-bar` — barra genérica de progresso (card de comentários de perfil)

---

## v3.4.2 — 2026-05-28
### Fix: download de comentários em arquivos separados por post

- **`DOWNLOAD_PROFILE_COMMENTS`:** agora agrupa as linhas por `Post Shortcode` e dispara um `chrome.downloads.download` por post — cada arquivo contém apenas os comentários daquele post
- **Nomenclatura:** `IGComments_<username>_<shortcode>_<N>.csv` (ex: `IGComments_eduardogomestocantins_ABC123_45.csv`)
- Pausa de 80ms entre downloads para evitar throttling do browser
- UI atualizada: mensagem de confirmação mostra "X arquivo(s) baixados — Y comentários no total"

---

## v3.4.1 — 2026-05-28
### Nova feature: 💬 Comentários de todos os posts do perfil

Dentro da aba **🔍 Perfil**, nova seção para extrair **todos os comentários de todos os posts** de um perfil. Ideal para identificar seguidores mais engajados.

#### Backend
- **`fetchCommentsForPost(mediaId, shortcode, cursor)`** — versão standalone de `fetchCommentsPage` independente de `state.username`/`state.urlType`
- **`profileCommentsState`** — estado isolado: `running`, `targetUsername`, `maxPosts`, `maxPerPost`, `rows[]`, contadores de progresso
- **`runProfileCommentsExtraction()`** — motor em dois passos:
  1. **Fase 1 (posts):** pagina todo o feed do perfil via `fetchUserFeed()`, coleta shortcodes + `commentCount`
  2. **Fase 2 (comentários):** para cada post com `commentCount > 0`, pagina todos os comentários via `fetchCommentsForPost()` com `min_id`. Posts sem comentários são pulados silenciosamente. Rate-limit tratado com cooldown de 60s + retentativa
- **Mensagens:** `SCRAPE_PROFILE_COMMENTS`, `STOP_PROFILE_COMMENTS`, `DOWNLOAD_PROFILE_COMMENTS`

#### CSV de saída — colunas
`Post URL`, `Post Shortcode`, `Post Caption`, `Comment Id`, `Username`, `User Id`, `Comment`, `Date`, `Profile URL`, `Avatar URL`

#### UI
- Cards "💬 Comentários de todos os posts" (controles) e "Download comentários" no painel esquerdo da aba Perfil
- Campos configuráveis: `@username`, **máx. posts** (0 = todos), **máx. comentários/post** (0 = todos)
- Card de progresso animado no painel direito: barra azul, contadores "Posts N/M" e "Total comentários"
- Log compartilhado com o scraper de perfil (fluxo sequencial natural)
- Arquivo: `IGProfileComments_<username>_<N>.csv`

---

## v3.4.0 — 2026-05-28
### Nova aba: 🔍 Perfil — scraping de perfil rico com posts

Nova aba dedicada a extrair dados completos de um perfil Instagram, em formato compatível com Apify `instagram-scraper`.

#### Background (`background.js`)
- **`fetchUserInfo(userId)`:** chama `/api/v1/users/{userId}/info/` para obter biografia, email/telefone público, categoria de negócio, `profile_pic_url_hd`, `fbid`, `bio_links`, etc.
- **`fetchUserFeed(userId, cursor, count)`:** chama `/api/v1/feed/user/{userId}/` para buscar posts paginados
- **`toPostObject(item)`:** converte cada item do feed para objeto rico — extrai `shortCode`, `url`, `type` (Image/Video/Sidecar), `caption`, `hashtags`, `mentions`, `likesCount`, `commentsCount`, `videoViewCount`, `timestamp`, `imageUrl`, `childPosts` (carrosséis)
- **`profileState`:** estado separado do `state` principal — `running`, `targetUsername`, `maxPosts`, `data`
- **`runProfileScrape()`:** warm-up visitando o perfil alvo → `resolveUserId` → `fetchUserInfo` → loop paginado de posts → `PROFILE_DONE`
- **Mensagens novas:** `SCRAPE_PROFILE`, `STOP_PROFILE`, `DOWNLOAD_PROFILE` (salva `.json` com BOM UTF-8)

#### Output JSON — campos por perfil
`id`, `username`, `fullName`, `biography`, `externalUrls[]`, `followersCount`, `followsCount`, `postsCount`, `isBusinessAccount`, `isVerified`, `isPrivate`, `profilePicUrl`, `fbid`, `businessCategoryName`, `contactEmail`, `contactPhone`, `latestPosts[]`, `scrapedAt`

#### Output JSON — campos por post
`id`, `shortCode`, `url`, `type`, `caption`, `hashtags[]`, `mentions[]`, `likesCount`, `commentsCount`, `videoViewCount`, `timestamp`, `imageUrl`, `childPosts[]` (quando carrossel)

#### UI (`tab.html` / `tab.js` / `tab.css`)
- Nova aba **🔍 Perfil** entre Comentários e Perfis
- Input aceita: `@username`, URL completa (`https://www.instagram.com/usuario/`) ou username puro
- Campo "Posts recentes" (padrão: 12 — aceita 0 para extrair só dados do perfil sem posts)
- Card de preview após extração: avatar com placeholder (inicial do nome), nome, handle, bio, stats (seguidores/seguindo/posts), tags (verificado, comercial, privado, categoria), links externos
- Lista scrollável de posts: thumbnail placeholder, caption truncada, ❤ curtidas, 💬 comentários, 👁 views, data, tipo, link do post, hashtags (5 primeiras)
- Download como `.json` compatível com Apify (array com 1 objeto)
- Log em tempo real idêntico às outras abas

---

## v3.3.1 — 2026-05-28
### Detecção de cycling + diagnóstico de followship

- **`checkFollowship(userId)`:** chama `/api/v1/friendships/show/{userId}/` antes de iniciar extração. Verifica se a conta extratora segue o alvo e emite aviso claro antes de começar — inclui diagnóstico de conta privada, solicitação pendente, etc.
- **Detecção de "infinite cycling":** quando `should_limit_list_of_followers=true` e a extração recebe 0 novos seguidores por 5 páginas consecutivas, para automaticamente com mensagem clara explicando o motivo (loop de duplicatas). Antes ficava rodando 200+ páginas coletando 0 dados úteis
- **Log mostra `⚠` nas páginas limitadas:** o sufixo `⚠` no logLine indica quando `should_limit_list_of_followers=true` em tempo real
- **`resolveUserId` retorna `followedByViewer` e `isPrivate`:** campos adicionais do `friendship_status` para diagnóstico futuro

---

## v3.3.0 — 2026-05-28
### Anti-detecção + rotação multi-conta nos módulos de curtidas e comentários

#### Anti-detecção
- **`x-ig-device-id` no `_igFetch`:** lê `ig_did` do `localStorage` da aba do Instagram e envia como header `x-ig-device-id` em todas as requisições. Ausência deste header é sinal forte de automação
- **`wwwClaim` por conta:** cada perfil no pool agora salva seu próprio `x-ig-www-claim`. Ao rotacionar de volta para uma conta já usada, o claim anterior é restaurado (não enviamos "0" desnecessariamente)
- **`applyCookies` limpa ambos os domínios:** agora remove cookies de `.instagram.com` (com ponto) E `instagram.com` (sem ponto) ao trocar de conta — antes alguns cookies ficavam órfãos no domínio sem ponto

#### Rotação multi-conta nos módulos de curtidas e comentários
- **`runLikesExtraction` agora suporta rotação de pool:** copia exatamente o mesmo bloco de rotação do `runExtraction` (seguidores). Inclui: seleção round-robin, cooldown por conta, validação de autenticação pós-rotação, pausa para todos os bloqueios, `pagesWithCurrent` counter
- **`runCommentsExtraction` agora suporta rotação de pool:** idêntico ao de curtidas
- **`state.rotateAfter` adicionado aos dois módulos:** era lido da config mas nunca aplicado
- **`onRateLimit(currentAccount)` corrigido:** antes passava `null` em curtidas e comentários — cooldown nunca era marcado na conta responsável pelo rate-limit
- **AUTH_FAIL em curtidas/comentários agora rotaciona:** antes parava a extração ao primeiro `AUTH_FAIL`. Agora tenta a próxima conta disponível exatamente como o módulo de seguidores

#### UX / Histórico
- **Botão "↻ Reextrair" para todos os tipos:** curtidas e comentários agora também têm o botão no Histórico
- **Navegação correta ao reextrair:** `reRunHistory()` vai para a aba Curtidas, Comentários ou Seguidores conforme o tipo da entrada histórica — antes sempre ia para Seguidores
- **`originalUrl` salvo no histórico:** posts de Instagram e Facebook têm a URL original preservada; o botão Reextrair preenche a URL completa
- **Versão dinâmica:** `extVersion` no header é preenchido por `chrome.runtime.getManifest().version` — não precisa mais atualizar `v3.0.0` hardcoded no HTML

---

## v3.2.0 — 2026-05-28
### Extrator de comentários do Facebook
- **Suporte ao Facebook** na aba 💬 Comentários: grupos, páginas, perfis, permalink, story, vídeos — qualquer URL pública
- **`mbasic.facebook.com`:** versão HTML leve do Facebook, sem API privada nem doc_ids instáveis. Cookies do browser incluídos automaticamente (precisa estar logado no FB no Chrome)
- **`_fbExtractComments()`** com 3 estratégias de fallback:
  1. Links de "Curtir/Responder" com `comment_id` no href → sobe pelo DOM para encontrar o container do comentário
  2. `[id^="comment_id_"]` (versões mais antigas do mbasic)
  3. `<h3>` com link de perfil (mbasic clássico)
- **Detecção de login redirect:** se mbasic redirecionar para login/checkpoint, mostra mensagem clara ao usuário
- **Debug no log:** URL real carregada + estratégia de parse mostradas durante extração
- **`parsePostInput`** suporta: grupos (`/groups/SLUG/posts/ID`), páginas/perfis (`/NOME/posts/ID`, `/NOME/videos/ID`), permalink (`/permalink/ID`), story.php (`?story_fbid=ID`)
- **CSV:** `FBComments_<N>.csv` — campos idênticos ao Instagram (Comment Id, Username, Comment, Date, Profile URL, Avatar URL)
- **`manifest.json`:** host_permissions inclui `facebook.com/*` e `mbasic.facebook.com/*`, versão 3.2.0

---

## v3.1.0 — 2026-05-28
### Fix: limite de 500 comentários
- **`fetchCommentsPage` migrado de GraphQL para API privada** (`/api/v1/media/{id}/comments/`)
  - Endpoint anterior (`graphql/query/?query_hash=...`) parava em ~500 comentários independentemente do total real
  - Nova API não tem esse limite — pagina via `min_id` + `next_min_id` até `has_more_comments = false`
  - `shortcodeToMediaId()` (já existente) converte o shortcode para media_id antes do loop
  - Formato do CSV inalterado; campos mapeados de `comment.pk`, `comment.user.*`, `comment.created_at_utc`
- `toCommentRow` atualizado para o novo formato da API privada (`owner` → `user`, `id` → `pk`, `created_at` → `created_at_utc`)

---

## v3.0.0 — 2026-05-28
### Extrator de comentários
- **Nova aba 💬 Comentários:** extrai todos os comentários públicos de um post
  - Aceita URL completa (`instagram.com/p/ABC123/`) ou apenas o shortcode (`ABC123`)
  - Usa a API GraphQL do Instagram (`query_hash=33ba35852cb50da46f5b5e889df7d159`) — mesmo endpoint usado pelo app web oficial
  - Campos no CSV: Comment Id, Username, User Id, Comment, Date, Profile URL, Avatar URL
  - Warm-up: visita o post antes de chamar a API (comportamento humano)
  - Pausas humanas a cada 10–16 páginas, jitter, rate-limit handling
  - Progresso em tempo real: extraídos, total, pág/min, páginas
  - Histórico integrado: entradas de comentários aparecem com ícone 💬 em azul
- **CSV com tipo correto no nome:** `IGComments_ABC123_123.csv` para comentários, `IGLikes_ABC123_50.csv` para curtidas, `IGFollow_usuario_500_follower.csv` para seguidores
- **`state.extractionType`:** campo no estado global que rastreia o tipo da extração ativa (`"followers"` | `"likes"` | `"comments"`)

---

## v2.9.0 — 2026-05-25
### Histórico persistente + extrator de curtidas
- **Histórico persistente:** `saveHistory` agora também é chamada quando o usuário clica em Parar (antes só salvava em conclusão normal). Entradas interrompidas aparecem com badge "interrompida" em vermelho no Histórico. Campo `type` adicionado: `"completed"`, `"stopped"` ou `"likes"`
- **`state.meta` rastreado:** metadata do perfil salvo em `state.meta` logo após `resolveUserId`, permitindo que a rota de STOP acesse o total de seguidores para o registro histórico
- **Aba ❤️ Curtidas:** nova aba completa para extrair quem curtiu uma publicação
  - Aceita URL completa (`instagram.com/p/ABC123/`) ou apenas o shortcode (`ABC123`)
  - Converte shortcode → media_id via algoritmo matemático (base-64 com alfabeto Instagram)
  - Endpoint: `GET /api/v1/media/{media_id}/likers/` com paginação por `next_max_id`
  - Warm-up: visita o post antes de chamar a API (comportamento humano)
  - Pausas humanas a cada 10–16 páginas, jitter, rate-limit handling
  - ⚠ Instagram limita curtidas visíveis a ~1000 por post independente do total real
  - Progresso em tempo real: extraídos, total, pág/min, páginas
  - Histórico integrado: entradas de curtidas aparecem com ícone ❤️ no Histórico
  - CSV no mesmo formato dos seguidores (Username, Fullname, etc.)

---

## v2.8.0 — 2026-05-25
### Anti-detecção completa — conta bloqueada nunca mais
- **`x-ig-www-claim` dinâmico:** Instagram envia `x-ig-set-www-claim` em cada resposta com token atualizado. Antes enviávamos sempre `"0"` (sinal claro de bot). Agora o token é capturado de cada resposta e enviado de volta na próxima request. Resetado a cada troca de conta
- **Referer correto:** durante extração de seguidores, o header `Referer` agora é `https://www.instagram.com/{username}/followers/` (antes era sempre a homepage — sinal de automação)
- **Warm-up de sessão:** antes de qualquer chamada de API, a extensão navega ao perfil alvo e aguarda 1.5–4s aleatórios. Simula usuário que abre o perfil e lê a bio antes de clicar em Seguidores
- **Jitter ±40% + pausa extra:** delay varia de 60% a 140% do valor base. 8% de chance de pausa 1.5–3× mais longa (simula usuário distraído). Antes era ±25% sem pausas extras — timing robótico
- **Pausas humanas a cada 15–25 páginas:** para de 5–20s aleatórios. Usuário real não faz 10.000 requisições em sequência sem parar. Implementado via `sleepKeepAlive` (mantém SW vivo)
- **Floor adaptativo respeita preset:** o delay nunca cai abaixo de 70% do preset escolhido. Antes podia cair a 200ms fixo, anulando qualquer preset "Seguro"
- **Presets redesenhados:** Fantasma (5000ms/rot15), Seguro (2500ms/rot8), Balanceado (1200ms/rot4), Turbo (600ms/rot2). "Máximo" removido — era 200ms, causava bloqueio garantido. Mínimo manual: 500ms
- **Streak de sucesso aumentado:** requeria 3 sucessos para reduzir delay, agora requer 5 — menos agressivo no aumento de velocidade
- **Reset de `igWwwClaim = "0"` em toda troca de conta:** token anterior não é válido para nova sessão
- **Debug `[RAW]` removido:** broadcast de debug com corpo da primeira resposta foi removido do código de produção

---

## v2.7.0 — 2026-05-25
### Renomeação + diagnóstico de AUTH_FAIL
- **Renomeado para "Spider Mobiliza":** nome atualizado em `manifest.json` (name, default_title), `tab.html` (title, header) e todos os cabeçalhos de arquivo
- **Diagnóstico de AUTH_FAIL:** quando a autenticação falha, o log agora informa se o `sessionid` está ausente/expirado (→ reimporte os cookies) ou presente (→ Instagram bloqueou temporariamente por detecção de scraping — aguardar cooldown). Usa `chrome.cookies.get` do service worker (pode ler cookies httpOnly; `document.cookie` em JS não consegue)
- **Versão:** `2.6.0 → 2.7.0`

---

## v2.6.0 — 2026-05-25
### Auditoria completa — polish e correções menores
- **CSV com Unicode correto:** `btoa(unescape(encodeURIComponent()))` substituído por `TextEncoder → btoa`. Suporta qualquer Unicode — árabe, coreano, emoji compostos, flags. `unescape` estava deprecated e falhava com chars acima de U+00FF. BOM (﻿) mantido para Excel
- **`checkTabAuth` detecta soft-login:** além de checar a URL (`/accounts/login/`), agora injeta script na aba para verificar se `sessionid` está presente em `document.cookie`. O Instagram frequentemente exibe modal de login sem mudar a URL — essa verificação detecta esse caso antes de desperdiçar uma chamada de API
- **`spm` corrigido:** multiplicador era 200 (errado), agora é 50 (correto — Instagram retorna até 50 seguidores por página). O campo `spm` do PROGRESS nunca era usado pelo tab.js (que recalculava com 50), mas o valor errado ficava no storage
- **Preset ativo restaurado ao abrir Config:** ao reabrir a aba Config, o botão de preset correspondente à configuração salva fica highlighted. Antes, "Balanceado" ficava sempre marcado independente do que foi salvo
- **`poolStatus` atualizado em STATUS messages:** durante cooldowns longos (que emitem STATUS, não PROGRESS), o card de pool status agora atualiza também. Antes ficava estático mostrando número desatualizado de contas disponíveis
- **`apifyDownload` guard para dataset vazio:** em vez de crash silencioso gerando CSV de 0 bytes, mostra mensagem explicativa e reabilita o botão
- **`reRunHistory` removido de `window`:** era resquício do período com `onclick` inline (pré-CSP fix v2.3.0). Convertido para função local
- **Arquivos popup.html/js/css removidos:** código morto da v1.x (popup legado). Não referenciados no manifest desde v2.0.0

---

## v2.5.0 — 2026-05-25
### Correção crítica — service worker MV3 sobrevive ao cooldown
- **`sleepKeepAlive(ms)`:** substitui todos os `sleep()` longos (cooldown de auth/rate-limit). Dorme em chunks de 20s e faz um ping ao `chrome.storage` a cada chunk — isso reseta o timer de 30s do service worker MV3, impedindo que o Chrome mate o processo durante a espera. Antes, um `sleep(300000)` de 5min morria silenciosamente após ~30s e a retomada nunca acontecia
- **Contagem regressiva no log:** durante cada espera, o log exibe "⏸ Aguardando desbloqueio… ~Xs restantes" a cada 20s, mostrando progresso mesmo parado

---

## v2.4.0 — 2026-05-25
### Correções críticas — rotação multi-conta
- **Cursor não portável corrigido:** `follow_ranking_token` codifica o `userId` da conta extratora e não pode ser reutilizado por outra conta. Na rotação, `state.cursor` e `rankToken` são zerados → paginação reinicia do zero com a nova conta
- **Deduplicação por User ID (`seenIds`):** quando a paginação reinicia após rotação, seguidores já extraídos são descartados automaticamente. Log exibe `+N seg (X dup)` quando há duplicatas detectadas
- **Validação de autenticação pós-rotação:** após `applyCookies` + reload da aba, verifica se a URL não é `/accounts/login/`. Se o cookie for inválido, conta é desativada por 5min e a extração tenta a próxima imediatamente — sem desperdiçar uma chamada de API
- **`pagesWithCurrent = 0` no AUTH_FAIL:** evitava que a rotação disparasse duas vezes seguidas (uma no handler + uma no início da próxima iteração) quando `rotateAfter=1`
- **Pausa automática quando todas as contas bloqueadas:** em vez de parar a extração com erro, aguarda o cooldown da primeira conta expirar e retoma automaticamente. Log exibe "⏸ retomando em Xs…". Usuário pode clicar Parar a qualquer momento durante a espera. Comportamento idêntico para rate-limit (429) e auth-fail (401/HTML)
- **Dados nunca perdidos após erro (MV3 service worker):** `partialFollowers` agora é salvo no storage a cada 30 páginas, ao STOP e ao final de qualquer extração. Clicar em Baixar CSV funciona mesmo depois que o SW foi morto pelo Chrome. `unlimitedStorage` adicionado ao manifest para suportar extrações de 100k+ sem quota error. Filename recupera username do storage se `state.username` estiver vazio após reinício do SW
- **Aba Apify — Input JSON editável + actor correto:** `apify/instagram-scraper` não suporta `resultsType="followers"`. Actor padrão atualizado para `apify/instagram-followers-count-scraper` com input `{ "usernames": ["USERNAME"], "maxItems": N }`. Textarea editável exibe exatamente o JSON enviado ao actor. Aviso vermelho quando `apify/instagram-scraper` está selecionado. Input logado antes do envio para diagnóstico

---

## v2.3.0 — 2026-05-25
### Correções críticas
- **Rotação de contas corrigida:** `poolIndex` agora começa em 1 (pool[0] já aplicado), a primeira rotação vai direto para pool[1]
- **Threshold de rotação por páginas** (era por seguidores × 50 — não disparava com listas limitadas)
- **`should_limit_list_of_followers`:** paginação aceita páginas com < 50 usuários; exibe warning claro ao usuário
- **HTML response detection:** quando Instagram retorna HTML (sessão inválida), mapeia para AUTH_FAIL com mensagem explicativa, em vez de crash no JSON.parse
- **`world: "MAIN"` removido:** no MAIN world o service worker do Instagram interceptava o fetch e devolvia HTML. Voltou para ISOLATED (fetch vai direto para a rede)
- **`waitForTabComplete()`:** aguarda a aba do Instagram terminar de carregar antes de injetar script, resolvendo o erro "Sem resposta do script"
- **Reload forçado pós-applyCookies:** navega a aba para instagram.com/ após aplicar cookies novos (evita executeScript em aba em navegação)
- **AUTH_FAIL → rotação imediata** para a próxima conta disponível (antes ficava preso tentando a mesma conta inválida)
- **CSP fix:** removido `onclick` inline do HTML de histórico (viola Content-Security-Policy de extensões MV3); substituído por event listener com `data-rerun`
- **`_igFetch` try/catch:** erros silenciosos agora são capturados e logados com `[FETCH-ERR]`

### Novidades
- **Aba 🔌 Apify:** extração em escala (100k–1M perfis) via Apify cloud. API Key + Actor ID configuráveis, polling automático, download do CSV no mesmo formato padrão. Suporte a cookies de perfis salvos para autenticação.
- **Import de cookie JSON:** aceita o formato JSON do Cookie Editor (array de objetos) além do Header String
- **Instruções de import atualizadas:** "Export as JSON" agora é o método recomendado

---

## v2.2.0 — 2026-05-25
### Novidades
- Aba Apify adicionada (integração cloud para extração em escala)
- Import de cookie via JSON (Cookie Editor export)

---

## v2.1.0 — 2026-05-24
### Novidades
- Import manual de cookies de outra máquina (Header String e JSON)
- ETA detalhado: tempo restante, horário estimado de conclusão, contagem de páginas
- Histórico das últimas 50 extrações com botão "Reextrair"

---

## v2.0.0 — 2026-05-23
### Reescrita completa
- Interface movida de popup para aba completa (tab.html)
- 4 abas: ⚡ Extrair, 👤 Perfis, 📋 Histórico, ⚙ Config
- Suporte a múltiplos perfis/cookies com rotação round-robin
- Delay adaptativo (reduz no sucesso, aumenta no rate-limit)
- Cooldown por conta individual (429 → 60s, 401 → 5min)
- Progresso em tempo real com barra e stats
- Config com presets de velocidade (Seguro / Balanceado / Turbo / Máximo)
- Paginação via `follow_ranking_token` (novo formato da API do Instagram)
- Fix: service worker não envia cookies de sessão → usa `executeScript` na aba do Instagram

---

## v1.x — Legado (popup)
- Extrator básico em popup
- Suporte a 1 conta
- CSV export
