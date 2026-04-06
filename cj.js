const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

let accessToken = null;
let tokenExpiry = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getToken() {
  if (accessToken && tokenExpiry && new Date() < new Date(tokenExpiry)) {
    return accessToken;
  }
  const CJ_API_KEY = process.env.CJ_API_KEY;
  if (!CJ_API_KEY) { console.error('No CJ_API_KEY'); return null; }
  try {
    const res = await axios.post(
      `${CJ_BASE}/authentication/getAccessToken`,
      { apiKey: CJ_API_KEY },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    if (res.data && res.data.result && res.data.data && res.data.data.accessToken) {
      accessToken = res.data.data.accessToken;
      tokenExpiry = res.data.data.accessTokenExpiryDate;
      console.log('CJ authenticated');
      return accessToken;
    }
    console.error('CJ auth failed:', res.data && res.data.message);
    return null;
  } catch (err) {
    console.error('CJ auth error:', (err.response && err.response.data && err.response.data.message) || err.message);
    return null;
  }
}

async function verifyProduct(pid, token) {
  try {
    const res = await axios.get(`${CJ_BASE}/product/query`, {
      headers: { 'CJ-Access-Token': token },
      params: { pid: pid },
      timeout: 10000,
    });
    // Product exists and is active if we get a successful response with data
    return res.data && res.data.result && res.data.data && res.data.data.productName;
  } catch (err) {
    return false;
  }
}

async function verifyProductsBatch(products, token) {
  var verified = [];
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    var exists = await verifyProduct(p.cjProductId, token);
    if (exists) {
      verified.push(p);
    } else {
      console.log('  Removed from CJ: ' + p.name);
    }
    await sleep(1200);
  }
  console.log('Verified ' + verified.length + '/' + products.length + ' products still active on CJ');
  return verified;
}


// ─── Category IDs ─────────────────────────────────────────────────────────────
// CJ category IDs for our target categories

// Real category IDs from CJ API — using second-level category IDs
// which are broad enough to get good product variety
const TARGET_CATEGORIES = [
  // Pet Supplies subcategories
  { name: 'Pet Supplies',      id: '2410110335471602500' }, // Pet Toys
  { name: 'Pet Supplies',      id: '2410110338591602500' }, // Pet Furniture
  { name: 'Pet Supplies',      id: '2410110339121629200' }, // Pet Bedding
  { name: 'Pet Supplies',      id: '2410110337231611800' }, // Pet Outdoor Supplies
  { name: 'Pet Supplies',      id: '2410110338151629800' }, // Pet Apparels
  // Sports & Outdoors
  { name: 'Sports & Outdoors', id: '36492F79-E7EB-42F0-8DCC-6129BD9D2AE1' }, // Other Sports Equipment
  { name: 'Sports & Outdoors', id: '66C86053-159B-436E-B4A9-4A7CCB5CAC8A' }, // Sportswear
  // Home & Garden
  { name: 'Home & Garden',     id: '1AD00A3C-465A-430A-9820-F2D097FDA53A' }, // Home Textiles
  { name: 'Home & Garden',     id: 'ED8E61AA-2260-4E03-BA66-DEAE3DF02CDC' }, // Home Storage
  { name: 'Home & Garden',     id: 'D5D120D0-1262-461A-97C5-74AC732625B5' }, // Kitchen, Dining & Bar
  // Beauty & Health
  { name: 'Beauty & Health',   id: 'CE5FADBB-B432-40B9-8B20-200F6928762A' }, // Beauty Tools
  { name: 'Beauty & Health',   id: '6289460B-5660-468A-AE43-3D619A05AAC2' }, // Skin Care
  { name: 'Beauty & Health',   id: '7EAF3E36-620B-4D78-818F-EE80955462A4' }, // Makeup
  // Baby & Kids
  { name: 'Baby & Kids',       id: '8C946349-0DC4-4B1E-AC41-E4FE30288DEE' }, // Baby & Mother
  { name: 'Baby & Kids',       id: '04D68B68-1048-4971-BAFA-18FA0A6DB95C' }, // Toys & Hobbies
];

// ─── Pull products from CJ by category ───────────────────────────────────────

async function fetchCategoryProducts(token, categoryId, categoryName, pageSize) {
  try {
    const res = await axios.get(`${CJ_BASE}/product/list`, {
      headers: { 'CJ-Access-Token': token },
      params: {
        categoryId: categoryId,
        pageNum: 1,
        pageSize: pageSize,
        sortField: 'orderCount',
        sortType: 'DESC',
        listingStatus: 1,       // 1 = listed/active only
        countryCode: 'US',      // US warehouse products
      },
      timeout: 20000,
    });

    if (!res.data || !res.data.result || !res.data.data || !res.data.data.list) {
      console.log('  No results for category: ' + categoryName);
      return [];
    }

    const items = res.data.data.list;
    console.log('  ' + categoryName + ': ' + items.length + ' products fetched');

    var mapped = items
      .filter(function(item) {
        // Skip products with Chinese characters in name
        var name = item.productName || '';
        if (/[一-鿿]/.test(name)) return false;
        // Skip if no price
        if (!item.sellPrice || parseFloat(item.sellPrice) <= 0) return false;
        // Skip very cheap items (likely junk)
        if (parseFloat(item.sellPrice) < 2) return false;
        return true;
      })
      .map(function(item) {
        return {
          cjProductId: item.pid,
          name: item.productName,
          category: categoryName,
          price: parseFloat(item.sellPrice),
          imageUrl: item.productImage || null,
          productUrl: 'https://cjdropshipping.com/product/' + item.pid + '.html',
          shippingTime: item.deliveryTime || null,
        };
      });
    console.log('  ' + categoryName + ': ' + items.length + ' fetched, ' + mapped.length + ' after filtering');
    return mapped;
  } catch (err) {
    console.error('CJ category fetch error (' + categoryName + '):', (err.response && err.response.data && err.response.data.message) || err.message);
    return [];
  }
}

// ─── Pull all target categories ───────────────────────────────────────────────

async function fetchAllCJProducts(minPrice) {
  const token = await getToken();
  if (!token) return [];

  // Distribute pages across categories — aim for as many as possible
  // CJ QPS limit is 1/sec so we pace calls
  const perCategory = 10; // 10 per category x 15 categories = ~150 products
  const allProducts = [];

  for (var i = 0; i < TARGET_CATEGORIES.length; i++) {
    var cat = TARGET_CATEGORIES[i];
    console.log('Fetching CJ category: ' + cat.name);
    var products = await fetchCategoryProducts(token, cat.id, cat.name, perCategory);

    // Apply price filter if set
    if (minPrice > 0) {
      products = products.filter(function(p) {
        var price = parseFloat(p.price) || 0;
        return price >= minPrice;
      });
    }

    allProducts.push.apply(allProducts, products);
    await sleep(1200); // respect QPS limit
  }

  console.log('Total CJ products fetched: ' + allProducts.length);

  // Verify products still exist on CJ before scoring
  // This eliminates removed/delisted products
  console.log('Verifying products are still active on CJ...');
  var verified = await verifyProductsBatch(allProducts, token);
  return verified;
}

// ─── Claude scores CJ products for trend potential ────────────────────────────

async function scoreBatch(products, attempt) {
  attempt = attempt || 1;
  if (attempt > 4) { console.error('Max retries hit for batch'); return []; }

  var productList = products.map(function(p, i) {
    return (i + 1) + '. "' + p.name + '" - CJ wholesale: $' + p.price + ' (' + p.category + ')';
  }).join('\n');

  // No web search — Claude scores from training knowledge
  // This is fast, cheap, and never hits rate limits
  var prompt = 'You are a dropshipping expert. Score these ' + products.length + ' products for dropshipping potential based on your knowledge of consumer trends, social media popularity, and market demand.\n\nProducts (with CJ wholesale cost):\n' + productList + '\n\nFor each product estimate:\n- tiktok: TikTok/social media trend score (0-100)\n- amazon: Amazon demand score (0-100)\n- reddit: Organic community buzz (0-100)\n- margin: Profit margin potential (0-100, based on typical retail price vs wholesale cost shown)\n- retailPrice: What this typically sells for retail (e.g. "$29.99")\n- whyTrending: 1 sentence on why consumers want this\n- whyDropship: 1 sentence on dropship viability\n- amazonUrl: Amazon search URL for this product\n\nReturn ONLY a JSON array, no other text:\n[{"index":1,"tiktok":75,"amazon":68,"reddit":45,"margin":72,"retailPrice":"$34.99","whyTrending":"reason","whyDropship":"reason","amazonUrl":"https://amazon.com/s?k=product+name","tiktokUrl":null,"redditUrl":null}]\n\nAll ' + products.length + ' products required.';

  try {
    var response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    var finalText = response.content
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('');

    var parsed = extractJSON(finalText);
    if (parsed) { return parsed; }

    // Retry once asking for clean JSON
    var retry = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: finalText },
        { role: 'user', content: 'Return ONLY the JSON array starting with [ and ending with ]. No other text.' }
      ],
    });
    var retryText = retry.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
    return extractJSON(retryText) || [];

  } catch (err) {
    var msg = err.message || '';
    var isRateLimit = msg.indexOf('429') !== -1 || msg.indexOf('rate_limit') !== -1;
    if (isRateLimit) {
      var waitMs = attempt * 10000;
      console.log('Rate limit hit, waiting ' + (waitMs/1000) + 's (attempt ' + attempt + ')...');
      await sleep(waitMs);
      return scoreBatch(products, attempt + 1);
    }
    console.error('Claude scoring error:', msg);
    return [];
  }
}



function extractJSON(text) {
  if (!text) return null;
  var clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  var start = clean.indexOf('[');
  var end = clean.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    var arr = JSON.parse(clean.slice(start, end + 1));
    if (Array.isArray(arr) && arr.length > 0) return arr;
  } catch(e) {
    try {
      var fixed = clean.slice(start, end + 1).replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      var arr2 = JSON.parse(fixed);
      if (Array.isArray(arr2) && arr2.length > 0) return arr2;
    } catch(e2) {}
  }
  return null;
}

function validUrl(u) {
  if (!u || u === 'null' || u === 'undefined') return null;
  try { new URL(u); return u; } catch(e) { return null; }
}

function clamp(v) { return Math.min(100, Math.max(0, Math.round(Number(v) || 0))); }

// ─── Main export — replaces old approach entirely ─────────────────────────────

async function fetchAndScoreCJProducts(minPrice) {
  // Step 1: Pull real products from CJ
  var cjProducts = await fetchAllCJProducts(minPrice || 0);
  if (!cjProducts.length) {
    console.log('No CJ products fetched');
    return [];
  }

  // Step 2: Score in batches of 10 to stay within rate limits
  var batchSize = 10;
  var allScored = [];

  for (var i = 0; i < cjProducts.length; i += batchSize) {
    var batch = cjProducts.slice(i, i + batchSize);
    console.log('Scoring batch ' + (Math.floor(i/batchSize)+1) + '/' + Math.ceil(cjProducts.length/batchSize) + ' (' + batch.length + ' products)...');

    var scores = await scoreBatch(batch);

    scores.forEach(function(s) {
      var idx = (s.index || 0) - 1;
      if (idx < 0 || idx >= batch.length) return;
      var cjProduct = batch[idx];

      var tiktok = clamp(s.tiktok);
      var amazon = clamp(s.amazon);
      var reddit = clamp(s.reddit);
      var margin = clamp(s.margin);
      var overall = Math.round(tiktok*0.40 + amazon*0.30 + reddit*0.15 + margin*0.15);

      var signals = [];
      if (tiktok >= 65) signals.push('tiktok');
      if (amazon >= 65) signals.push('amazon');
      if (reddit >= 65) signals.push('reddit');
      if (margin >= 65) signals.push('margin');

      // Calculate margin if we have both retail and wholesale prices
      var retailPrice = s.retailPrice || null;
      var wholesale = cjProduct.price || 0;
      var retailNum = retailPrice ? parseFloat(retailPrice.replace(/[^0-9.]/g, '')) : 0;
      var marginPct = (retailNum > 0 && wholesale > 0)
        ? Math.round(((retailNum - wholesale) / retailNum) * 100)
        : null;

      allScored.push({
        id: 'cj_' + cjProduct.cjProductId,
        name: cjProduct.name,
        category: cjProduct.category,
        tiktok: tiktok,
        amazon: amazon,
        reddit: reddit,
        margin: margin,
        score: overall,
        signals: signals,
        source: 'cj',
        retailPrice: retailPrice,
        wholesaleEstimate: cjProduct.price ? '$' + cjProduct.price + ' (CJ)' : null,
        marginPct: marginPct,
        whyTrending: s.whyTrending || '',
        whyDropship: s.whyDropship || '',
        tiktokUrl: validUrl(s.tiktokUrl),
        amazonUrl: validUrl(s.amazonUrl),
        redditUrl: validUrl(s.redditUrl),
        imageUrl: cjProduct.imageUrl || null,
        searchQuery: cjProduct.name,
        cj: {
          found: true,
          productId: cjProduct.cjProductId,
          productName: cjProduct.name,
          price: cjProduct.price,
          shippingTime: cjProduct.shippingTime,
          imageUrl: cjProduct.imageUrl,
          productUrl: cjProduct.productUrl,
          allMatches: [],
        },
        scannedAt: new Date().toISOString(),
      });
    });

    // Pause between batches
    if (i + batchSize < cjProducts.length) {
      await sleep(3000);
    }
  }

  console.log('Scored ' + allScored.length + ' products from CJ');
  return allScored.sort(function(a, b) { return b.score - a.score; });
}

module.exports = { fetchAndScoreCJProducts: fetchAndScoreCJProducts };
