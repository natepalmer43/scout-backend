const express = require('express');
const cron = require('node-cron');
const cors = require('cors');
const { fetchAndScoreCJProducts } = require('./cj');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let products = [];
let lastScan = null;
let scanLog = [];
let scanning = false;
let currentMinPrice = 0;

// ─── Main scan ────────────────────────────────────────────────────────────────

async function runScan(minPrice) {
  minPrice = minPrice || 0;
  console.log('\n[' + new Date().toISOString() + '] Starting scan (minPrice: $' + minPrice + ')...');
  currentMinPrice = minPrice;

  var scored = await fetchAndScoreCJProducts(minPrice);

  if (scored.length > 0) {
    products = scored.slice(0, 30);
  } else {
    console.log('No products returned — keeping previous results');
  }

  lastScan = new Date().toISOString();
  scanLog.unshift({ scannedAt: lastScan, count: products.length, minPrice: minPrice });
  if (scanLog.length > 20) scanLog = scanLog.slice(0, 20);
  console.log('Scan complete. ' + products.length + ' products.');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', function(req, res) {
  res.json({ status: 'ok', lastScan: lastScan, productCount: products.length, currentMinPrice: currentMinPrice });
});

app.get('/products', function(req, res) {
  res.json({
    products: products,
    lastScan: lastScan,
    currentMinPrice: currentMinPrice,
    nextScan: lastScan ? new Date(new Date(lastScan).getTime() + 3*60*60*1000).toISOString() : null,
    scanLog: scanLog,
  });
});

app.post('/scan', function(req, res) {
  var minPrice = parseInt(req.body && req.body.minPrice) || 0;
  res.json({ status: scanning ? 'already_scanning' : 'started', minPrice: minPrice });
  if (!scanning) {
    scanning = true;
    runScan(minPrice).then(function() { scanning = false; });
  }
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

cron.schedule('0 */3 * * *', function() {
  if (!scanning) {
    scanning = true;
    runScan(currentMinPrice).then(function() { scanning = false; });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, function() {
  console.log('Scout backend running on port ' + PORT);
  console.log('CJ enabled: ' + (!!process.env.CJ_API_KEY));
  scanning = true;
  runScan(0).then(function() { scanning = false; });
});
