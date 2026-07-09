import { Hono } from "hono";
import type { AppBindings } from "../env";

const iconSvg = {
  "favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
<rect width="512" height="512" rx="96" fill="#2563eb"></rect>
<g stroke="#fff" stroke-width="38" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`,
  "icon-16.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 512 512" fill="none">
<rect width="512" height="512" rx="96" fill="#2563eb"></rect>
<g stroke="#fff" stroke-width="52" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`,
  "icon-32.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 512 512" fill="none">
<rect width="512" height="512" rx="96" fill="#2563eb"></rect>
<g stroke="#fff" stroke-width="38" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`,
  "icon-48.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 512 512" fill="none">
<rect width="512" height="512" rx="96" fill="#2563eb"></rect>
<g stroke="#fff" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`,
  "icon-192.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 512 512" fill="none">
<rect width="512" height="512" rx="96" fill="#2563eb"></rect>
<g stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`,
  "icon-512.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none">
<rect width="512" height="512" rx="96" fill="#2563eb"></rect>
<g stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`,
  "logo-mark.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 512 512" fill="none">
<rect width="512" height="512" rx="96" fill="#2563eb"></rect>
<g stroke="#fff" stroke-width="36" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`,
  "icon-mono-white.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
<g stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`,
  "icon-mono-dark.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
<g stroke="#1e293b" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M176 132h-20a24 24 0 00-24 24v200a24 24 0 0024 24h200a24 24 0 0024-24v-20"></path>
<path d="M256 256L380 132"></path>
<path d="M300 132h80v80"></path>
</g>
</svg>`
} as const;

const webManifest = JSON.stringify({
  name: "publicar",
  short_name: "publicar",
  start_url: "/",
  display: "standalone",
  background_color: "#0a0a0a",
  theme_color: "#2563eb",
  icons: [
    { src: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
    { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml" }
  ]
});

function assetResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": contentType
    }
  });
}

export const assetsRoute = new Hono<AppBindings>();

assetsRoute.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 302));
assetsRoute.get("/site.webmanifest", () => assetResponse(webManifest, "application/manifest+json; charset=utf-8"));

for (const [path, svg] of Object.entries(iconSvg)) {
  assetsRoute.get(`/${path}`, () => assetResponse(svg, "image/svg+xml; charset=utf-8"));
}
