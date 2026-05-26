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

app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const url = await c.env.LINKS.get(slug);
  
  if(!url) {
    return c.notFound();
  }

  const event: ClickEvent = {
    slug,
    country: c.req.header("CF-IPCountry") ?? "unknown",
    city: c.req.header("CF-IPCity") ?? "unknown",
    timestamp: Date.now(),
  };

  await c.env.CLICK_EVENTS.send(event);

  return c.redirect(url, 302);
});

app.post("/shorten", async (c) => {
  const { slug, url } = await c.req.json();

  if(!url){
    return c.json({ error: "URL is required" }, 400);
  }

  const finalSlug = slug || crypto.randomUUID().slice(0, 8);

  const existingUrl = await c.env.LINKS.get(finalSlug);
  if(existingUrl) {
    return c.json({ error: "Slug already exists" }, 409);
  }

  await c.env.LINKS.put(finalSlug, url);

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
