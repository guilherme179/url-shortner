import { Hono } from "hono";

const app = new Hono<{ Bindings: CloudflareBindings }>();

type ClickEvent = {
  slug: string;
  country: string;
  city: string;
  timestamp: number;
};

app.get("/message", (c) => {
  return c.text(`Welcome to the URL Shortener API! Use POST /shorten to create a short URL. \r version: ${c.env.VERSION} `);
});

app.get("/stats", async (c) => {
  const query = `
    SELECT
      blob1 AS slug,
      blob2 AS country,
      count() AS total_clicks
    FROM click_analytics
    GROUP BY slug, country
    ORDER BY total_clicks DESC
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${c.env.ANALYTICS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: query,
    }
  );

  const analytics = await response.json() as { data: { slug: string; country: string; total_clicks: string }[] };

  // Agrupa cliques por slug
  const slugStats = analytics.data.reduce((acc, row) => {
    if (!acc[row.slug]) {
      acc[row.slug] = { total_clicks: 0, countries: {} };
    }
    acc[row.slug].total_clicks += Number(row.total_clicks);
    acc[row.slug].countries[row.country] = Number(row.total_clicks);
    return acc;
  }, {} as Record<string, { total_clicks: number; countries: Record<string, number> }>);

  return c.json({
    version: c.env.VERSION,
    total_slugs: Object.keys(slugStats).length,
    total_clicks: Object.values(slugStats).reduce((sum, s) => sum + s.total_clicks, 0),
    slugs: slugStats,
  });
});

app.get("/links", async (c) => {
  const { results } = await c.env.url_shortener_db
    .prepare("SELECT slug, url, created_at FROM links ORDER BY created_at DESC")
    .all();

  return c.json({ total: results.length, links: results });
});

app.post("/shorten", async (c) => {
  const { slug, url } = await c.req.json();

  if(!url){
    return c.json({ error: "URL is required" }, 400);
  }

  const finalSlug = slug || crypto.randomUUID().slice(0, 8);

  const existing = await c.env.url_shortener_db
    .prepare("SELECT slug FROM links WHERE slug = ?")
    .bind(finalSlug)
    .first();

  if (existing) {
    return c.json({ error: "Slug already exists" }, 409);
  }

  await c.env.url_shortener_db
    .prepare("INSERT INTO links (slug, url) VALUES (?, ?)")
    .bind(finalSlug, url)
    .run();

  return c.json({ slug: finalSlug, url, short: `${ new URL(c.req.url).origin }/${ finalSlug }` }, 201);
});

app.get("/analytics/:slug", async (c) => {
  const slug = c.req.param("slug");

  const query = `
    SELECT
      blob1 AS slug,
      blob2 AS country,
      count() AS total_clicks
    FROM click_analytics
    WHERE blob1 = '${slug}'
    GROUP BY slug, country
    ORDER BY total_clicks DESC
  `;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${c.env.ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${c.env.ANALYTICS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: query,
    }
  );

  const data = await response.json();
  return c.json(data);
});

app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const link = await c.env.url_shortener_db
    .prepare("SELECT url FROM links WHERE slug = ?")
    .bind(slug)
    .first<{ url: string }>();

  
  if(!link) {
    return c.notFound();
  }

  const event: ClickEvent = {
    slug,
    country: c.req.header("CF-IPCountry") ?? "unknown",
    city: c.req.header("CF-IPCity") ?? "unknown",
    timestamp: Date.now(),
  };

  await c.env.CLICK_EVENTS.send(event);

  return c.redirect(link.url, 302);
});

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<ClickEvent>, env: CloudflareBindings) {
    for (const message of batch.messages) {
      const { slug, country, city, timestamp } = message.body;

      // Escreve no Analytics Engine
      env.ANALYTICS.writeDataPoint({
        blobs: [slug, country, city],
        doubles: [1],
        indexes: [slug],
      });

      message.ack();
    }
  },
};
