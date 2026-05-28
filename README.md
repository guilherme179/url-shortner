# url-shortener

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4-E36002?logo=hono&logoColor=white)](https://hono.dev/)

Encurtador de URLs com analytics de cliques, rodando em Cloudflare Workers em **encurtador.guilhermedev.com**.

Este é um projeto pessoal de aprendizado — não um produto. O objetivo foi ganhar experiência prática com o ecossistema de desenvolvimento da Cloudflare: Workers, KV, D1, Queues e Analytics Engine.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Cloudflare Workers |
| Framework | Hono |
| Linguagem | TypeScript |
| Armazenamento | Cloudflare D1 (SQLite na edge) |
| Eventos assíncronos | Cloudflare Queues |
| Analytics | Cloudflare Analytics Engine |
| CD | GitHub Actions |

---

## Arquitetura

```
Cliente
  │
  ▼
GET /:slug ──► D1 lookup ──► redirect 302
                    │
                    └──► Queue (CLICK_EVENTS) ──► Queue consumer ──► Analytics Engine
```

Quando um link encurtado é acessado, o Worker faz duas coisas de forma independente: redireciona o usuário imediatamente (302) e enfileira um evento de clique. Um consumer separado processa esses eventos em batch e os grava no Cloudflare Analytics Engine. Isso mantém o caminho do redirect rápido e não bloqueante.

---

## Evolução arquitetural

**v1 — Cloudflare KV**

O projeto começou com KV como camada de armazenamento. KV é um store chave-valor distribuído globalmente, o que o tornava uma escolha natural para o caso de uso principal: guardar um slug e recuperar uma URL. Simples e de baixa latência.

A limitação apareceu ao adicionar a listagem de links: KV não tem suporte nativo a queries. Listar todas as chaves exige uma chamada separada ao `list()`, não há ordenação por data de inserção, e agregações não são possíveis sem processamento no cliente.

**v2 — Cloudflare D1**

A migração para o D1 (SQLite na edge) foi motivada pela curiosidade de entender como SQL se comporta em um runtime de edge. O D1 permitiu listagem ordenada, garantia de unicidade do slug via constraint, e queries mais expressivas — coisas que exigiriam gambiarras no KV.

O binding do namespace KV ainda está presente no `wrangler.jsonc` (legado), mas todas as leituras e escritas passam pelo D1.

---

## Rotas da API

### `GET /message`

Health check. Retorna uma mensagem de boas-vindas em texto puro com a versão deployada.

```
GET /message

200 OK
Welcome to the URL Shortener API! Use POST /shorten to create a short URL.  version: v2.0.0
```

---

### `POST /shorten`

Cria um link encurtado. Se `slug` for omitido, um slug aleatório de 8 caracteres é gerado.

```
POST /shorten
Content-Type: application/json

{
  "url": "https://exemplo.com/caminho/longo",
  "slug": "meu-link"   // opcional
}
```

```json
// 201 Created
{
  "slug": "meu-link",
  "url": "https://exemplo.com/caminho/longo",
  "short": "https://encurtador.guilhermedev.com/meu-link"
}
```

Erros: `400` se `url` não for informada, `409` se o slug já existir.

---

### `GET /:slug`

Resolve um link encurtado e redireciona (302) para a URL original. Também enfileira um evento de clique com país e cidade (extraídos dos headers da requisição Cloudflare).

```
GET /meu-link

302 Found
Location: https://exemplo.com/caminho/longo
```

Retorna `404` se o slug não existir.

---

### `GET /links`

Retorna todos os links armazenados ordenados por data de criação (mais recentes primeiro).

```
GET /links
```

```json
{
  "total": 2,
  "links": [
    { "slug": "meu-link", "url": "https://exemplo.com", "created_at": "2026-05-28 12:00:00" },
    { "slug": "abc123", "url": "https://outro.com", "created_at": "2026-05-27 09:30:00" }
  ]
}
```

---

### `GET /stats`

Analytics agregado de cliques em todos os slugs, agrupado por slug e país.

```
GET /stats
```

```json
{
  "version": "v2.0.0",
  "total_slugs": 2,
  "total_clicks": 42,
  "slugs": {
    "meu-link": {
      "total_clicks": 35,
      "countries": { "BR": 30, "US": 5 }
    },
    "abc123": {
      "total_clicks": 7,
      "countries": { "DE": 7 }
    }
  }
}
```

---

### `GET /analytics/:slug`

Resposta bruta do Analytics Engine para um slug específico, detalhada por país.

```
GET /analytics/meu-link
```

```json
{
  "data": [
    { "slug": "meu-link", "country": "BR", "total_clicks": "30" },
    { "slug": "meu-link", "country": "US", "total_clicks": "5" }
  ]
}
```

---

## Rodando localmente

```bash
npm install
npm run dev
```

O Wrangler sobe um servidor de desenvolvimento local (normalmente em `http://localhost:8787`). D1, Queues e Analytics Engine são simulados localmente pelo Miniflare.

Para regenerar os bindings TypeScript após alterar o `wrangler.jsonc`:

```bash
npm run cf-typegen
```

---

## Deploy

Os deploys são disparados automaticamente por tags Git via GitHub Actions (`.github/workflows/deploy.yml`). O workflow executa em qualquer tag que corresponda ao padrão `v*` e injeta o nome da tag como variável de ambiente `VERSION`.

```bash
# incrementa a versão e cria a tag
npm version patch   # ou minor / major

# envia o commit e a tag
git push origin main --follow-tags
```

O GitHub Actions detecta a nova tag e executa `wrangler deploy --var VERSION:<tag>`.

O secret `CLOUDFLARE_API_TOKEN` precisa estar configurado nas settings do repositório.
