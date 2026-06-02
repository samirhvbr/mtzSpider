# Spider Mobiliza — Chrome Extension

Extensão Chrome para extrair seguidores do Instagram usando cookies do navegador, com suporte a múltiplos perfis/contas e rotação automática.

## Instalação (modo desenvolvedor)

1. Abra o Chrome e acesse `chrome://extensions/`
2. Ative **"Modo do desenvolvedor"** (canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione esta pasta: `chrome-extension/`
5. A extensão aparecerá na barra do Chrome

## Como usar

### Extração simples (conta logada no Chrome)

1. Faça login no Instagram no Chrome normalmente
2. Clique no ícone da extensão
3. Digite o nome do usuário (ex: `majucotrim`)
4. Clique em **Iniciar**
5. Quando terminar, clique em **Baixar CSV**

### Múltiplas contas (rotação automática)

1. Faça login na **Conta 1** no Instagram
2. Abra a extensão → aba **Perfis**
3. Dê um nome (ex: `conta_01`) e clique em **Capturar perfil logado**
4. Faça login na **Conta 2**, repita o processo
5. Repita para todas as contas desejadas (suporta ~100)
6. Configure em **Config** → *"Trocar de perfil a cada N seguidores"* (ex: 200)
7. Inicie a extração normalmente — a extensão rotaciona automaticamente

### Configurações

| Opção | Padrão | Descrição |
|---|---|---|
| Intervalo entre requisições | 2000 ms | Delay entre chamadas à API. Mínimo recomendado: 1500ms |
| Trocar perfil a cada N | 200 | Troca de conta após N seguidores extraídos |
| Limite de seguidores | 0 (sem limite) | Para extração parcial |

## Formato do CSV exportado

```
User Id, Username, Fullname, Followed by you, Followers, Following, Posts,
Public Email, Contact Phone, City, Street Address,
Is private, Is verified, Is business, External URL, Bio, Profile URL, Avatar URL
```

Campos populados: `User Id`, `Username`, `Fullname`, `Followed by you`, `Is private`, `Is verified`, `Is business`, `Profile URL`, `Avatar URL`

## Notas técnicas

- Usa a API privada do Instagram (`/api/v1/friendships/{user_id}/followers/`)
- Headers obrigatórios: `X-CSRFToken`, `X-IG-App-ID: 936619743392459`
- Paginação via cursor `next_max_id`
- Em caso de rate limit (HTTP 429): aguarda 60s automaticamente
- Em caso de auth fail (HTTP 401): tenta o próximo perfil salvo
- Nenhum dado é enviado a servidores externos

## Estrutura

```
chrome-extension/
├── manifest.json       # Manifest V3
├── background.js       # Service Worker — toda a lógica de extração
├── popup.html          # Interface da extensão
├── popup.css           # Estilos (Mobiliza.me colors)
├── popup.js            # Lógica do popup
├── icons/              # Ícones 16/48/128px
└── README.md
```
