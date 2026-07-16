# mtzSpider — Spider Mobiliza

> Extensão Chrome para extração de dados do Instagram e Facebook.  
> Suporte a múltiplas contas com rotação automática, anti-detecção e download em CSV/JSON.

**Versão atual:** v3.5.3

---

## Funcionalidades

| O que extrai | Plataforma | Formato |
|---|---|---|
| Seguidores de um perfil | Instagram | CSV |
| Curtidas de um post/reel | Instagram | CSV |
| Comentários de um post/reel (top-level + respostas) | Instagram | CSV |
| Dados completos de um perfil (bio, stats, posts recentes) | Instagram | JSON |
| Todos os comentários de todos os posts de um perfil | Instagram | CSV por post |
| Comentários de uma publicação | Facebook | CSV |

---

## Instalação

A extensão é instalada no modo **Desenvolvedor** — não precisa da Chrome Web Store.

1. Faça o download ou clone este repositório
2. Abra o Chrome e acesse `chrome://extensions`
3. Ative o **Modo do desenvolvedor** (canto superior direito)
4. Clique em **Carregar sem compactação**
5. Selecione a pasta `chrome-extension/`
6. O ícone **M** aparece na barra de extensões — clique para abrir

---

## Como usar

### 1. Cadastrar contas Instagram

Antes de extrair, cadastre pelo menos uma conta na aba **👤 Perfis**.

**Método 1 — Conta logada no Chrome**
1. Faça login em [instagram.com](https://www.instagram.com) na conta desejada
2. Abra a extensão → aba **Perfis**
3. Digite um nome para a conta e clique em **📸 Capturar**

**Método 2 — Cookie de outra máquina**
1. Instale o [Cookie Editor](https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm) no Chrome da máquina com a conta
2. Abra o Instagram logado → clique no ícone → **Export → Export as JSON**
3. Cole o JSON na extensão → aba **Perfis** → **Importar cookie colado**

> Com 2+ contas cadastradas, o modo turbo fica disponível e a velocidade aumenta significativamente.

---

### 2. Extrair dados

Tudo acontece na aba **🕷 Extrair** com uma entrada inteligente única.

**Cole qualquer um destes formatos no campo:**
- `@usuario` ou `usuario` — perfil Instagram
- `https://www.instagram.com/usuario/` — perfil Instagram
- `https://www.instagram.com/p/ABC123/` — post Instagram
- `https://www.instagram.com/reel/ABC123/` — reel Instagram
- `https://www.facebook.com/grupo/posts/123` — publicação Facebook

O tipo é detectado automaticamente e os botões de ação aparecem.

---

### Extraindo seguidores

1. Cole o `@usuario` ou a URL do perfil
2. Clique em **👥 Seguidores**
3. Configure o limite (0 = extrair todos)
4. Clique em **▶ Iniciar**
5. Quando concluir, clique em **⬇ Baixar** → gera `IGFollowers_usuario_N.csv`

**Colunas do CSV:**
`Username`, `User Id`, `Full Name`, `Followers`, `Following`, `Posts`, `Verified`, `Private`, `Profile URL`, `Avatar URL`

---

### Extraindo curtidas de um post

1. Cole a URL do post ou reel
2. Clique em **❤️ Curtidas**
3. Clique em **▶ Iniciar**
4. Download → `IGLikers_shortcode_N.csv`

> Instagram limita a ~1.000 curtidas por post via API.

---

### Extraindo comentários de um post

1. Cole a URL do post ou reel
2. Clique em **💬 Comentários**
3. Clique em **▶ Iniciar**

A extração ocorre em **duas fases**:
- **Fase 1:** comentários top-level (paginação via `min_id`)
- **Fase 2:** respostas (replies) de cada comentário com `child_comment_count > 0`

Download → `IGComments_shortcode_N.csv`

**Colunas do CSV:**
`Comment Id`, `Parent Id`, `Username`, `User Id`, `Comment`, `Date`, `Profile URL`, `Avatar URL`

> `Parent Id` vazio = comentário top-level. Preenchido = resposta a outro comentário.

---

### Extraindo dados de um perfil + posts

1. Cole o `@usuario`
2. Clique em **📊 Dados do perfil + Posts**
3. Configure quantos posts recentes incluir (0 = só dados do perfil)
4. Clique em **▶ Iniciar**

Download → `IGProfile_usuario.json`

**Dados extraídos:** `username`, `fullName`, `biography`, `followersCount`, `followsCount`, `postsCount`, `isVerified`, `isBusinessAccount`, `isPrivate`, `businessCategoryName`, `contactEmail`, `contactPhone`, `externalUrls`, `profilePicUrl`, `fbid`, `latestPosts[]`

Cada post inclui: `shortCode`, `type`, `caption`, `hashtags`, `mentions`, `likesCount`, `commentsCount`, `videoViewCount`, `timestamp`, `url`

---

### Extraindo comentários de todos os posts de um perfil

1. Cole o `@usuario`
2. Clique em **💬 Comentários dos posts**
3. Configure:
   - **Máx. posts:** quantos posts escanear (0 = todos)
   - **Máx. comentários por post:** 0 = todos
4. Clique em **▶ Iniciar**

Gera **um arquivo CSV por post** com todos os comentários:
`IGComments_usuario_shortcode_N.csv`

**Colunas:** `Post URL`, `Post Shortcode`, `Post Caption`, `Comment Id`, `Username`, `User Id`, `Comment`, `Date`, `Profile URL`, `Avatar URL`

---

### Extraindo comentários do Facebook

1. Cole a URL da publicação do Facebook
2. Clique em **💬 Comentários**
3. Clique em **▶ Iniciar**

> Usa a sessão logada do Facebook no Chrome — não requer cookies separados.

---

## Rotação de contas

Com múltiplas contas cadastradas, a extensão alterna automaticamente entre elas a cada N páginas (configurável). Enquanto uma descansa, as outras trabalham.

**Benefícios:**
- Reduz drasticamente o risco de bloqueio
- Aumenta a velocidade de extração
- Cada conta tem cooldown individual em caso de rate-limit

**Exemplo:** 10 contas com delay 1.2s → ~4 min para 128k seguidores

---

## Configurações de velocidade

Acesse a aba **⚙ Config** para ajustar.

| Preset | Delay | Rotação | Risco |
|---|---|---|---|
| 🛡️ Fantasma | 5000ms | 15 páginas | Mínimo |
| 🐢 Seguro | 2500ms | 8 páginas | Baixo |
| ⚖ Balanceado *(padrão)* | 1200ms | 4 páginas | Médio |
| 🚀 Turbo | 600ms | 2 páginas | Alto |

---

## Anti-detecção

- **Warm-up:** visita o perfil/post antes de iniciar a extração
- **Jitter ±40%:** delay variável — nunca requisições em intervalos fixos
- **Pausas humanas:** pausa de 5–17s a cada 10–16 páginas
- **x-ig-www-claim:** token de sessão atualizado a cada resposta
- **x-ig-device-id:** lido do localStorage da aba do Instagram
- **Referer correto:** cada request indica a origem correta
- **wwwClaim por conta:** preservado entre rotações de pool

---

## API utilizada

A extensão usa a **API privada do Instagram** (mesma que o app mobile):

| Endpoint | Uso |
|---|---|
| `/api/v1/users/{userId}/info/` | Dados completos do perfil |
| `/api/v1/feed/user/{userId}/` | Posts do perfil (paginado) |
| `/api/v1/friendships/{userId}/followers/` | Lista de seguidores |
| `/api/v1/media/{mediaId}/likers/` | Curtidas de um post |
| `/api/v1/media/{mediaId}/comments/` | Comentários (paginado via `min_id`) |
| `/api/v1/media/{mediaId}/comments/{id}/child_comments/` | Respostas de um comentário |

---

## Histórico

As últimas 50 extrações ficam salvas na aba **📋 Histórico**. Clique em **↻ Reextrair** para repetir qualquer extração anterior com um clique.

---

## Estrutura do projeto

```
chrome-extension/
├── manifest.json       # Manifest MV3
├── background.js       # Service Worker — toda a lógica de extração
├── tab.html            # Interface da extensão
├── tab.js              # Lógica da UI (detecção, progresso, histórico)
├── tab.css             # Estilos
├── icons/              # Ícones da extensão
└── CHANGELOG.md        # Histórico de versões
```

---

## Aviso legal

Esta extensão é para uso pessoal e de pesquisa. O scraping de dados do Instagram e Facebook pode violar os Termos de Serviço dessas plataformas. Use com responsabilidade.
