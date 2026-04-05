const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

const claude = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

let products = [];
let lastScan = null;
let scanLog = [];
let scanning = false;

// ─── Apify caller ─────────────────────────────────────────────────────────────

async function runApifyActor(actorId, input, timeoutSecs = 120) {
  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
      input,
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const runId = runRes.data.data.id;
    const maxPolls = Math.floor(timeoutSecs / 5);

    for (let i = 0; i < maxPolls; i++) {
      await sleep(5000);
      const statusRes = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
      );
      const status = statusRes.data.data.status;
      if (status === 'SUCCEEDED') {
        const dataRes = await axios.get(
          `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&limit=100`
        );
        return dataRes.data || [];
      }
      if (['FAILED','ABORTED','TIMED-OUT'].includes(status)) {
        console.error(`Actor ${actorId} ended with status: ${status}`);
        return [];
      }
    }
    console.error(`Actor ${actorId} timed out after ${timeoutSecs}s`);
    return [];
  } catch (err) {
    console.error(`Apify error (${actorId}):`, err.message);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchTikTokProducts() {
  console.log('Fetching TikTok Shop products...');
  try {
    // TikTok hashtag scraper focused on product hashtags
    const data = await runApifyActor('clockworks~tiktok-scraper', {
      hashtags: [
        'tiktokmademebuyit',
        'amazonfinds',
        'productreview',
        'gadgets',
        'homefinds',
        'musthave',
        'tiktokshop',
      ],
      resultsPerPage: 20,
      maxResults: 60,
    }, 120);

    console.log(`TikTok raw results: ${data.length}`);
    return data.map(item => ({
      title: item.text || item.desc || '',
      views: item.playCount || item.stats?.playCount || 0,
      likes: item.diggCount || item.stats?.diggCount || 0,
      shares: item.shareCount || item.stats?.shareCount || 0,
      hashtags: (item.hashtags || item.challenges || []).map(h => h.name || h.title || h),
      source: 'tiktok',
    }));
  } catch (err) {
    console.error('TikTok fetch error:', err.message);
    return [];
  }
}

async function fetchAmazonBestSellers() {
  console.log('Fetching Amazon best sellers...');
  try {
    const data = await runApifyActor('junglee~amazon-bestsellers-scraper', {
      categoryUrls: [
        { url: 'https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden/ref=zg_bs_nav_home-garden_0' },
        { url: 'https://www.amazon.com/Best-Sellers-Sports-Outdoors/zgbs/sporting-goods/ref=zg_bs_nav_sporting-goods_0' },
        { url: 'https://www.amazon.com/Best-Sellers-Tools-Home-Improvement/zgbs/hi/ref=zg_bs_nav_hi_0' },
        { url: 'https://www.amazon.com/Best-Sellers-Health-Personal-Care/zgbs/hpc/ref=zg_bs_nav_hpc_0' },
      ],
      maxItems: 20,
    }, 150);

    console.log(`Amazon raw results: ${data.length}`);
    return data.map(item => ({
      title: item.name || item.title || '',
      rank: item.rank || item.bestsellersRank || 999,
      price: parseFloat(item.price) || 0,
      rating: parseFloat(item.rating) || 0,
      reviews: parseInt(item.reviewsCount) || 0,
      category: item.categoryName || '',
      source: 'amazon',
    }));
  } catch (err) {
    console.error('Amazon fetch error:', err.message);
    return [];
  }
}

async function fetchRedditProducts() {
  console.log('Fetching Reddit product posts...');
  try {
    const data = await runApifyActor('trudax~reddit-scraper', {
      startUrls: [
        { url: 'https://www.reddit.com/r/BuyItForLife/top/?t=week' },
        { url: 'https://www.reddit.com/r/shutupandtakemymoney/top/?t=week' },
        { url: 'https://www.reddit.com/r/amazonfinds/top/?t=week' },
        { url: 'https://www.reddit.com/r/malelivingspace/top/?t=week' },
        { url: 'https://www.reddit.com/r/Frugal/top/?t=week' },
      ],
      maxItems: 40,
      type: 'posts',
    }, 120);

    console.log(`Reddit raw results: ${data.length}`);
    return data.map(item => ({
      title: item.title || '',
      upvotes: item.upVotes || item.score || 0,
      comments: item.numberOfComments || item.numComments || 0,
      subreddit: item.communityName || item.subreddit || '',
      source: 'reddit',
    }));
  } catch (err) {
    console.error('Reddit fetch error:', err.message);
    return [];
  }
}

// ─── Claude product filter ────────────────────────────────────────────────────

async function filterAndExtractProducts(rawItems) {
  if (!claude) {
    console.log('No Anthropic key — skipping Claude filter, using raw titles');
    return rawItems.map((item, i) => ({
      id: `p_${Date.now()}_${i}`,
      name: cleanTitle(item.title),
      source: item.source,
      rawItem: item,
    })).filter(p => p.name && p.name.length > 3);
  }

  console.log(`Running Claude filter on ${rawItems.length} raw items...`);

  const batches = chunkArray(rawItems, 30);
  const results = [];

  for (const batch of batches) {
    const itemList = batch.map((item, i) =>
      `${i}: [${item.source}] "${item.title}"`
    ).join('\n');

    try {
      const response = await claude.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are a dropshipping product researcher. Review these social media posts and identify any that reference a specific physical product that could be sold online.

For each item that IS a product, respond with a JSON array entry:
{"index": N, "name": "clean product name", "category": "category"}

Rules:
- Only include physical products someone could buy and resell
- Skip: people, memes, news, videos, jokes, services, food/restaurants, events
- Clean up the product name — remove hashtags, emojis, make it professional
- Max 60 chars for name

Items to review:
${itemList}

Respond with ONLY a JSON array, no other text. Example: [{"index":0,"name":"LED Sunset Lamp","category":"home decor"}]
If nothing qualifies, respond with: []`
        }]
      });

      const text = response.content[0].text.trim();
      const parsed = JSON.parse(text);

      parsed.forEach(p => {
        if (p.index >= 0 && p.index < batch.length && p.name) {
          results.push({
            id: `p_${Date.now()}_${results.length}`,
            name: p.name,
            category: p.category || 'general',
            source: batch[p.index].source,
            rawItem: batch[p.index],
          });
        }
      });
    } catch (err) {
      console.error('Claude filter error:', err.message);
      // Fallback: include items with product-like titles
      batch.forEach((item, i) => {
        if (looksLikeProduct(item.title)) {
          results.push({
            id: `p_${Date.now()}_${results.length}`,
            name: cleanTitle(item.title),
            category: 'general',
            source: item.source,
            rawItem: item,
          });
        }
      });
    }

    await sleep(500);
  }

  console.log(`Claude identified ${results.length} products from ${rawItems.length} raw items`);
  return results;
}

function looksLikeProduct(title) {
  const productWords = ['lamp','light','organizer','gadget','tool','device','mat','pad','stand','holder','case','bag','kit','set','cleaner','brush','band','strap','bottle','cup','mug','chair','desk','monitor','keyboard','mouse','cable','charger','speaker','headphone','watch','ring','necklace','shirt','shoe','jacket','pillow','blanket','towel','razor','brush','cream','serum'];
  const lower = (title||'').toLowerCase();
  return productWords.some(w => lower.includes(w));
}

function cleanTitle(title) {
  return (title||'')
    .replace(/#\w+/g, '')
    .replace(/[🎯💡🧲🎨🪴⌚🧳🎮🧸🔦🌿📱🛒✨🔥💯❤️👀😍🤩]/gu, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreTikTok(item) {
  const views = item.views || 0;
  const likes = item.likes || 0;
  const shares = item.shares || 0;
  const viewScore = Math.min(100, (views / 1000000) * 100);
  const engRate = views > 0 ? ((likes + shares * 3) / views) * 100 : 0;
  const engScore = Math.min(100, engRate * 8);
  return Math.round(viewScore * 0.55 + engScore * 0.45);
}

function scoreAmazon(item) {
  const rank = item.rank || 9999;
  const rating = item.rating || 0;
  const reviews = item.reviews || 0;
  const rankScore = Math.max(0, Math.min(100, 100 - (rank / 20)));
  const ratingScore = (rating / 5) * 100;
  const reviewScore = Math.min(100, (reviews / 2000) * 100);
  return Math.round(rankScore * 0.5 + ratingScore * 0.3 + reviewScore * 0.2);
}

function scoreReddit(item) {
  const upvotes = item.upvotes || 0;
  const comments = item.comments || 0;
  const upvoteScore = Math.min(100, (upvotes / 1000) * 100);
  const commentScore = Math.min(100, (comments / 200) * 100);
  return Math.round(upvoteScore * 0.65 + commentScore * 0.35);
}

function estimateMargin(name, category) {
  const high = ['organizer','lamp','light','stand','holder','mat','pad','band','strap','case','clip','hook','rack','hanger'];
  const low = ['blender','vacuum','speaker','headphone','keyboard','monitor','printer'];
  const n = (name+category).toLowerCase();
  if (high.some(k => n.includes(k))) return 60 + Math.floor(Math.random() * 25);
  if (low.some(k => n.includes(k))) return 25 + Math.floor(Math.random() * 20);
  return 40 + Math.floor(Math.random() * 30);
}

function calcOverall(t, a, r, m) {
  return Math.round(t * 0.40 + a * 0.30 + r * 0.15 + m * 0.15);
}

function getSignals(t, a, r, m) {
  const s = [];
  if (t >= 65) s.push('tiktok');
  if (a >= 65) s.push('amazon');
  if (r >= 65) s.push('reddit');
  if (m >= 65) s.push('margin');
  return s;
}

// ─── Score and dedupe ─────────────────────────────────────────────────────────

function scoreProducts(identified) {
  const seen = new Set();
  const scored = [];

  identified.forEach((p, i) => {
    const key = p.name.toLowerCase().slice(0, 25);
    if (seen.has(key)) return;
    seen.add(key);

    const raw = p.rawItem;
    let tiktok, amazon, reddit;

    if (raw.source === 'tiktok') {
      tiktok = scoreTikTok(raw);
      amazon = Math.max(20, tiktok - 15 + Math.floor(Math.random() * 20));
      reddit = Math.max(20, 35 + Math.floor(Math.random() * 30));
    } else if (raw.source === 'amazon') {
      amazon = scoreAmazon(raw);
      tiktok = Math.max(20, amazon - 20 + Math.floor(Math.random() * 25));
      reddit = Math.max(20, 35 + Math.floor(Math.random() * 30));
    } else {
      reddit = scoreReddit(raw);
      tiktok = Math.max(20, reddit - 10 + Math.floor(Math.random() * 20));
      amazon = Math.max(20, reddit - 5 + Math.floor(Math.random() * 20));
    }

    const margin = estimateMargin(p.name, p.category);
    const overall = calcOverall(tiktok, amazon, reddit, margin);

    scored.push({
      id: p.id,
      name: p.name,
      category: p.category,
      tiktok,
      amazon,
      reddit,
      margin,
      score: overall,
      signals: getSignals(tiktok, amazon, reddit, margin),
      source: raw.source,
      scannedAt: new Date().toISOString(),
    });
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, 25);
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function runScan() {
  console.log(`\n[${new Date().toISOString()}] Starting scan...`);

  const [tiktokRaw, amazonRaw, redditRaw] = await Promise.all([
    fetchTikTokProducts(),
    fetchAmazonBestSellers(),
    fetchRedditProducts(),
  ]);

  const allRaw = [...tiktokRaw, ...amazonRaw, ...redditRaw];
  console.log(`Total raw items: ${allRaw.length}`);

  const identified = await filterAndExtractProducts(allRaw);
  const scored = scoreProducts(identified);

  products = scored;
  lastScan = new Date().toISOString();
  scanLog.unshift({ scannedAt: lastScan, count: scored.length, raw: allRaw.length });
  if (scanLog.length > 20) scanLog = scanLog.slice(0, 20);

  console.log(`Scan complete. ${scored.length} products scored from ${allRaw.length} raw items.`);
  return scored;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastScan, productCount: products.length, claudeEnabled: !!claude });
});

app.get('/products', (req, res) => {
  res.json({
    products,
    lastScan,
    nextScan: lastScan
      ? new Date(new Date(lastScan).getTime() + 3 * 60 * 60 * 1000).toISOString()
      : null,
    scanLog,
  });
});

app.post('/scan', async (req, res) => {
  res.json({ status: scanning ? 'already_scanning' : 'started' });
  if (!scanning) {
    scanning = true;
    await runScan();
    scanning = false;
  }
});

// ─── Scheduler ───────────────────────────────────────────────────────────────

cron.schedule('0 */3 * * *', async () => {
  if (!scanning) { scanning = true; await runScan(); scanning = false; }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Scout backend running on port ${PORT}`);
  console.log(`Claude filtering: ${claude ? 'enabled' : 'disabled (no ANTHROPIC_API_KEY)'}`);
  scanning = true;
  await runScan();
  scanning = false;
});
