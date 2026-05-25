import { Hono } from "hono";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/message", (c) => {
  return c.text(`Welcome to the URL Shortener API! Use POST /shorten to create a short URL. \r version: ${c.env.VERSION} `);
});

app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const url = await c.env.LINKS.get(slug);
  
  if(!url) {
    return c.notFound();
  }

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

export default app;
