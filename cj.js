const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

let accessToken = null;
let tokenExpiry = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getToken() {
  if (accessToken && tokenExpiry && new Date() < new Date(tokenExpiry)) {
    return accessToken;
  }

  const CJ_API_KEY = process.env.CJ_API_KEY;
  if (!CJ_API_KEY) { console.error('No CJ_API_KEY set'); return null; }

  try {
    const res = await axios.post(
      `${CJ_BASE}/authentication/getAccessToken`,
      { apiKey: CJ_API_KEY },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    if (res.data && res.data.result && res.data.data && res.data.data.accessToken) {
      accessToken = res.data.data.accessToken;
      tokenExpiry = res.data.data.accessTokenExpiryDate;
      console.log('CJ authenticated successfully');
      return accessToken;
    }

    console.error('CJ auth failed:', res.data && res.data.message);
    return null;
  } catch (err) {
    console.error('CJ auth error:', (err.response && err.response.data && err.response.data.message) || err.message);
    return null;
  }
}

function buildSearchQuery(productName) {
  // Strip common filler words and use core keywords only
  var stopWords = ['portable','premium','smart','electric','automatic','professional','mini','ultra','pro','plus','max','new','best','top','high','quality','grade','heavy','duty','multi','super','digital','wireless','rechargeable','adjustable'];
  var words = productName.toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(' ')
    .filter(function(w) { return w.length > 2 && stopWords.indexOf(w) === -1; });
  // Use first 2-3 meaningful words for best CJ match
  return words.slice(0, 3).join(' ');
}

async function searchProduct(productName, token) {
  var searchQuery = buildSearchQuery(productName);
  console.log('  CJ searching: "' + searchQuery + '" (from "' + productName + '")');
  try {
    const res = await axios.get(`${CJ_BASE}/product/list`, {
      headers: { 'CJ-Access-Token': token },
      params: { productName: searchQuery, pageNum: 1, pageSize: 5 },
      timeout: 15000,
    });

    if (!res.data || !res.data.result || !res.data.data || !res.data.data.list || !res.data.data.list.length) {
      console.log('  CJ: no results for "' + searchQuery + '"');
      return null;
    }

    const items = res.data.data.list;
    // Return all candidates for Claude to evaluate
    return items.slice(0, 5).map(function(item) {
      return {
        id: item.pid,
        name: item.productName,
        price: item.sellPrice,
        image: item.productImage,
        url: 'https://cjdropshipping.com/product/' + item.pid + '.html',
        shippingTime: item.deliveryTime || null,
      };
    });
  } catch (err) {
    console.error('CJ search error for "' + productName + '":', (err.response && err.response.data && err.response.data.message) || err.message);
    return null;
  }
}


async function claudePickBestMatch(targetProduct, cjCandidates) {
  if (!cjCandidates || !cjCandidates.length) return null;
  if (cjCandidates.length === 1) return cjCandidates[0];

  try {
    var candidateList = cjCandidates.map(function(c, i) {
      return (i+1) + '. "' + c.name + '" @ $' + c.price;
    }).join('\n');

    var response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: 'I am looking for a dropshipping supplier match for: "' + targetProduct + '"\n\nCJ Dropshipping has these options:\n' + candidateList + '\n\nWhich number is the best match? If none are a reasonable match for the same type of product, say "none". Reply with just the number or "none".'
      }]
    });

    var answer = response.content[0].text.trim().toLowerCase();
    if (answer === 'none') return null;
    var num = parseInt(answer);
    if (!isNaN(num) && num >= 1 && num <= cjCandidates.length) {
      console.log('  Claude picked match #' + num + ': "' + cjCandidates[num-1].name + '"');
      return cjCandidates[num-1];
    }
    return cjCandidates[0];
  } catch(err) {
    console.error('Claude match error:', err.message);
    return cjCandidates[0];
  }
}

async function searchAllProducts(products) {
  const token = await getToken();
  if (!token) {
    console.log('CJ auth failed — skipping supplier matching');
    return products;
  }

  const results = [];

  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    // Try searchQuery first (AliExpress term Claude generated), then fall back to product name
    // Get CJ candidates
    var candidates = await searchProduct(p.searchQuery || p.name, token);
    await sleep(1200);

    // If no results with searchQuery, try product name
    if (!candidates || !candidates.length) {
      candidates = await searchProduct(p.name, token);
      await sleep(1200);
    }

    // Have Claude pick the best match from candidates
    var best = null;
    if (candidates && candidates.length) {
      best = await claudePickBestMatch(p.name, candidates);
      await sleep(500); // small delay after Claude call
    }

    if (best) {
      console.log('  Matched: "' + p.name + '" -> "' + best.name + '" @ $' + best.price);
      results.push(Object.assign({}, p, {
        cj: {
          found: true,
          productId: best.id,
          productName: best.name,
          price: best.price,
          shippingTime: best.shippingTime,
          imageUrl: best.image,
          productUrl: best.url,
          allMatches: candidates.slice(0, 3),
        },
        wholesaleEstimate: best.price ? '$' + best.price + ' (CJ live)' : p.wholesaleEstimate,
        imageUrl: p.imageUrl || best.image || null,
      }));
    } else {
      console.log('  No CJ match found for: "' + p.name + '"');
      results.push(Object.assign({}, p, { cj: { found: false } }));
    }

    await sleep(1200);
  }

  var matched = results.filter(function(p) { return p.cj && p.cj.found; }).length;
  console.log('CJ matching complete: ' + matched + '/' + products.length + ' matched');
  return results;
}

function calcMatchScore(query, result) {
  var q = (query || '').toLowerCase().split(' ').filter(function(w) { return w.length > 2; });
  var r = (result || '').toLowerCase();
  var matches = q.filter(function(w) { return r.includes(w); }).length;
  return Math.round((matches / Math.max(q.length, 1)) * 100);
}

module.exports = { searchAllProducts: searchAllProducts, getToken: getToken };
