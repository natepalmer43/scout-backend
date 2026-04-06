const axios = require('axios');

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

async function searchProduct(productName, token) {
  try {
    const res = await axios.get(`${CJ_BASE}/product/list`, {
      headers: { 'CJ-Access-Token': token },
      params: { productName: productName, pageNum: 1, pageSize: 5 },
      timeout: 15000,
    });

    if (!res.data || !res.data.result || !res.data.data || !res.data.data.list || !res.data.data.list.length) {
      console.log('  CJ: no results for "' + productName + '"');
      return null;
    }

    const items = res.data.data.list;
    const best = items[0];

    return {
      cjProductId: best.pid,
      cjProductName: best.productName,
      cjPrice: best.sellPrice,
      cjShippingTime: best.deliveryTime || null,
      cjImageUrl: best.productImage || null,
      cjProductUrl: 'https://cjdropshipping.com/product/' + best.pid + '.html',
      cjMatchScore: calcMatchScore(productName, best.productName),
      allMatches: items.slice(0, 3).map(function(item) {
        return {
          id: item.pid,
          name: item.productName,
          price: item.sellPrice,
          image: item.productImage,
          url: 'https://cjdropshipping.com/product/' + item.pid + '.html',
        };
      }),
    };
  } catch (err) {
    console.error('CJ search error for "' + productName + '":', (err.response && err.response.data && err.response.data.message) || err.message);
    return null;
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
    var cj = await searchProduct(p.searchQuery || p.name, token);

    if (cj) {
      console.log('  CJ match: "' + p.name + '" -> "' + cj.cjProductName + '" (' + cj.cjMatchScore + '% match) @ $' + cj.cjPrice);
      results.push(Object.assign({}, p, {
        cj: {
          found: true,
          matchScore: cj.cjMatchScore,
          productId: cj.cjProductId,
          productName: cj.cjProductName,
          price: cj.cjPrice,
          shippingTime: cj.cjShippingTime,
          imageUrl: cj.cjImageUrl,
          productUrl: cj.cjProductUrl,
          allMatches: cj.allMatches,
        },
        wholesaleEstimate: cj.cjPrice ? '$' + cj.cjPrice + ' (CJ live)' : p.wholesaleEstimate,
        imageUrl: p.imageUrl || cj.cjImageUrl || null,
      }));
    } else {
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
