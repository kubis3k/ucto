// =====================================================================
// download.js — stažení desktop instalátoru (Windows/Mac) z nejnovějšího
// GitHub Release. Repo (kubis3k/ucto) je PRIVÁTNÍ, takže se assety nedají
// linkovat přímo (browser_download_url vyžaduje auth) — server je stáhne
// pomocí vlastního read-only PAT (GITHUB_RELEASES_TOKEN, Contents:Read,
// stejný token jako pro desktop-config.json electron-updater) a přeposílá
// (proxy stream), aby přihlášený uživatel dostal soubor bez vlastního tokenu.
//
// Chráněno stejným requireAuth middlewarem jako zbytek /api/* (viz index.js)
// — stažení appky je dostupné jen po přihlášení, ne veřejně přes hádatelnou URL.
// =====================================================================
const express = require("express");
const router = express.Router();

const GITHUB_REPO = "kubis3k/ucto";
const PLATFORM_MATCHERS = {
  win: (name) => name.endsWith(".exe"),
  mac: (name) => name.endsWith(".dmg"), // dmg přednostně před .zip
};

async function githubFetch(url, accept) {
  const token = process.env.GITHUB_RELEASES_TOKEN;
  if (!token) throw Object.assign(new Error("Stahování desktop appky není nakonfigurováno (chybí GITHUB_RELEASES_TOKEN)."), { status: 503 });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept, "User-Agent": "globaal-elevate-ucetnictvi" },
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub API ${res.status} pro ${url}`), { status: res.status === 404 ? 404 : 502 });
  return res;
}

// GET /api/download/desktop?platform=win|mac
router.get("/desktop", async (req, res) => {
  const platform = req.query.platform;
  const matcher = PLATFORM_MATCHERS[platform];
  if (!matcher) return res.status(400).json({ error: "platform musí být 'win' nebo 'mac'." });

  try {
    const releaseRes = await githubFetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, "application/vnd.github+json");
    const release = await releaseRes.json();
    const asset = (release.assets || []).find((a) => matcher(a.name));
    if (!asset) return res.status(404).json({ error: `Poslední release neobsahuje instalátor pro ${platform === "win" ? "Windows" : "Mac"}.` });

    const assetRes = await githubFetch(asset.url, "application/octet-stream");
    res.setHeader("Content-Type", asset.content_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${asset.name}"`);
    if (asset.size) res.setHeader("Content-Length", String(asset.size));
    // Node fetch Response.body je web ReadableStream — Response.body.pipeTo by
    // šlo taky, ale přímá iterace funguje spolehlivě napříč verzemi Node/Express.
    for await (const chunk of assetRes.body) res.write(chunk);
    res.end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/download/desktop/info — jen metadata (verze, velikosti), pro zobrazení
// na stránce ke stažení bez stahování celého souboru.
router.get("/desktop/info", async (req, res) => {
  try {
    const releaseRes = await githubFetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, "application/vnd.github+json");
    const release = await releaseRes.json();
    const pick = (matcher) => {
      const a = (release.assets || []).find((x) => matcher(x.name));
      return a ? { name: a.name, size: a.size } : null;
    };
    res.json({
      version: release.tag_name,
      published_at: release.published_at,
      win: pick(PLATFORM_MATCHERS.win),
      mac: pick(PLATFORM_MATCHERS.mac),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
