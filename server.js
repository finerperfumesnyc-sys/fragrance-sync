/**
 * Bloom Fragrances USA - Shopify OAuth + Sync Server
 * Handles OAuth, then syncs ALL products from Cosmopolitan to Shopify
 * Uses batching so it never loses progress
 */

const https = require("https");
const http = require("http");
const url = require("url");
const fs = require("fs");

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const COSMO_TOKEN = process.env.COSMO_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT = process.env.PORT || 3000;
const MARKUP = 20;
const PROGRESS_FILE = "/tmp/sync_progress.json";

let SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN || null;
let syncRunning = false;

// ─── HELPERS ────────────────────────────────────────────────────────────────
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    }
  } catch(e) {}
  return { processedItems: [], lastPage: 1, totalProducts: 0 };
}

function saveProgress(progress) {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress)); } catch(e) {}
}

function clearProgress() {
  try { if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE); } catch(e) {}
}

// ─── OAUTH ──────────────────────────────────────────────────────────────────
function getInstallUrl(host) {
  const scopes = "read_products,write_products,read_orders,write_orders,read_inventory,write_inventory,read_fulfillments,write_fulfillments,read_customers,write_customers";
  const redirectUri = `${host}/auth/callback`;
  return `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

async function exchangeCodeForToken(code, host) {
  const body = `client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}&code=${code}`;
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SHOPIFY_STORE,
      path: "/admin/oauth/access_token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return res.body.access_token;
}

// ─── COSMOPOLITAN API ────────────────────────────────────────────────────────
async function fetchAllCosmoItems() {
  let allItems = [];
  let page = 1;
  while (true) {
    console.log(`🔍 Fetching Cosmo page ${page}...`);
    const res = await request({
      hostname: "api.cosmopolitanusa.com",
      path: `/v1/products?page=${page}`,
      method: "GET",
      headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" }
    });
    if (res.status !== 200 || !res.body || !res.body.Results || res.body.Results.length === 0) break;
    allItems = allItems.concat(res.body.Results);
    console.log(`📦 Page ${page}: ${res.body.Results.length} items, total: ${allItems.length}`);
    if (!res.body.NextUrl) break;
    page++;
    await sleep(200);
  }
  console.log(`✅ Total items from Cosmopolitan: ${allItems.length}`);
  return allItems;
}

async function fetchCosmoDetail(itemCode) {
  const res = await request({
    hostname: "api.cosmopolitanusa.com",
    path: `/v1/products/${encodeURIComponent(itemCode)}`,
    method: "GET",
    headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" }
  });
  return res.status === 200 ? res.body : null;
}

// ─── SHOPIFY API ─────────────────────────────────────────────────────────────
async function getAllShopifySkus() {
  let skuMap = {};
  let path = "/admin/api/2024-01/products.json?limit=250&fields=id,variants";
  while (true) {
    const res = await request({
      hostname: SHOPIFY_STORE, path, method: "GET",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
    });
    const products = res.body.products || [];
    for (const p of products) for (const v of p.variants || []) if (v.sku) skuMap[v.sku] = { productId: p.id, variantId: v.id };
    const link = res.headers && res.headers.link;
    if (link && link.includes('rel="next"')) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) { path = match[1].replace(`https://${SHOPIFY_STORE}`, ""); await sleep(500); }
      else break;
    } else break;
  }
  console.log(`🛍️ Existing Shopify SKUs: ${Object.keys(skuMap).length}`);
  return skuMap;
}

async function getLocationId() {
  const res = await request({
    hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/locations.json", method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  return res.body?.locations?.[0]?.id;
}

async function createShopifyProduct(detail) {
  const price = (parseFloat(detail.Net || 0) + MARKUP).toFixed(2);
  const comparePrice = detail.Retail ? parseFloat(detail.Retail).toFixed(2) : null;
  const res = await request(
    { hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/products.json", method: "POST",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { product: {
        title: detail.Desc || detail.Item,
        body_html: [detail.Desc2, detail.Desc3].filter(Boolean).join("<br>"),
        vendor: detail.Designer || "Cosmopolitan Cosmetics",
        product_type: "Fragrance",
        tags: ["fragrance", detail.ProductLine, detail.ProductClass].filter(Boolean).join(", "),
        images: detail.ImageURL ? [{ src: detail.ImageURL }] : [],
        variants: [{ sku: detail.Item, price, compare_at_price: comparePrice,
          inventory_management: "shopify", inventory_quantity: detail.Available || 0,
          weight: detail.Weight || 0, weight_unit: "oz", fulfillment_service: "manual",
          requires_shipping: true, taxable: true }]
    }}
  );
  return res.status === 201 ? res.body.product : null;
}

async function updateInventory(variantId, available, locationId) {
  const varRes = await request({
    hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/variants/${variantId}.json`, method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  const inventoryItemId = varRes.body?.variant?.inventory_item_id;
  if (!inventoryItemId || !locationId) return;
  await request(
    { hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/inventory_levels/set.json", method: "POST",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { location_id: locationId, inventory_item_id: inventoryItemId, available }
  );
}

// ─── ORDER PROCESSING ────────────────────────────────────────────────────────
async function processOrders() {
  const res = await request({
    hostname: SHOPIFY_STORE,
    path: "/admin/api/2024-01/orders.json?fulfillment_status=unfulfilled&status=open&limit=50",
    method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  const orders = res.body.orders || [];
  let submitted = 0;
  for (const order of orders) {
    if ((order.tags || "").includes("cosmo-submitted")) continue;
    const shipping = order.shipping_address;
    if (!shipping) continue;
    const suborder = {
      Suborder: `BLOOM-${order.order_number}`,
      ShipTo: { Name: `${shipping.first_name} ${shipping.last_name}`.trim(), Line1: shipping.address1,
        Line2: shipping.address2 || undefined, City: shipping.city, State: shipping.province_code,
        Zip: shipping.zip, Country: shipping.country_code, Phone: shipping.phone || undefined,
        Email: order.email || undefined, Residence: true },
      Lines: order.line_items.map(item => ({
        SKU: item.sku, QTY: item.quantity,
        NET: Math.max(parseFloat(item.price) - MARKUP, 1).toFixed(2),
        EndPrice: shipping.country_code !== "US" ? parseFloat(item.price).toFixed(2) : undefined
      }))
    };
    const subRes = await request(
      { hostname: "api.cosmopolitanusa.com", path: "/v1/suborders", method: "POST",
        headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } },
      suborder
    );
    if (subRes.status === 201 || subRes.status === 200) {
      submitted++;
      console.log(`✅ Submitted order BLOOM-${order.order_number}`);
      await request(
        { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}.json`, method: "PUT",
          headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
        { order: { id: order.id, tags: ((order.tags || "") + ",cosmo-submitted").replace(/^,/, "") } }
      );
    }
    await sleep(300);
  }
  if (submitted > 0) {
    const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
    await request(
      { hostname: "api.cosmopolitanusa.com", path: "/v1/dropship", method: "POST",
        headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" } },
      { PO: `BLOOM-PO-${today}`, Comment: "Bloom Fragrances USA daily order" }
    );
    console.log(`✅ Dropship PO submitted`);
  }
}

async function syncTracking() {
  const res = await request({
    hostname: SHOPIFY_STORE,
    path: "/admin/api/2024-01/orders.json?fulfillment_status=unfulfilled&status=open&limit=50",
    method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  const orders = (res.body.orders || []).filter(o => (o.tags || "").includes("cosmo-submitted") && !(o.tags || "").includes("cosmo-tracked"));
  for (const order of orders) {
    const orderNum = `BLOOM-${order.order_number}`;
    const trackRes = await request({
      hostname: "api.cosmopolitanusa.com", path: `/v1/dropship/suborder/${encodeURIComponent(orderNum)}`,
      method: "GET", headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" }
    });
    const shipments = trackRes.body?.Shipments || [];
    const tracking = shipments[0]?.TrackingNumber;
    const carrier = shipments[0]?.Carrier || "other";
    if (!tracking) continue;
    const foRes = await request({
      hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}/fulfillment_orders.json`,
      method: "GET", headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
    });
    const fulfillmentOrderId = foRes.body?.fulfillment_orders?.[0]?.id;
    if (!fulfillmentOrderId) continue;
    const carrierMap = { FEDEX: "FedEx", UPS: "UPS", USPS: "USPS", FEDGND: "FedEx", UPSGND: "UPS", USPSP: "USPS" };
    const fulfillRes = await request(
      { hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/fulfillments.json", method: "POST",
        headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
      { fulfillment: { line_items_by_fulfillment_order: [{ fulfillment_order_id: fulfillmentOrderId }],
          tracking_info: { number: tracking, company: carrierMap[carrier.toUpperCase()] || carrier },
          notify_customer: true } }
    );
    if (fulfillRes.status === 201) {
      console.log(`✅ Tracked order ${orderNum}`);
      await request(
        { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/orders/${order.id}.json`, method: "PUT",
          headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
        { order: { id: order.id, tags: ((order.tags || "") + ",cosmo-tracked").replace(/^,/, "") } }
      );
    }
    await sleep(500);
  }
}

// ─── MAIN SYNC ───────────────────────────────────────────────────────────────
async function runSync(fullReset = false) {
  if (!SHOPIFY_TOKEN) { console.log("⚠️ No token — visit /install"); return; }
  if (syncRunning) { console.log("⚠️ Sync already running"); return; }
  syncRunning = true;
  console.log("🌸 Bloom Fragrances USA - Sync starting...", new Date().toISOString());

  try {
    if (fullReset) clearProgress();
    const progress = loadProgress();

    // Step 1: Get all items from Cosmopolitan
    const allItems = await fetchAllCosmoItems();
    if (allItems.length === 0) { console.log("❌ No items from Cosmopolitan"); syncRunning = false; return; }

    // Step 2: Get all existing Shopify SKUs
    const existingSkus = await getAllShopifySkus();
    const locationId = await getLocationId();

    let created = 0, updated = 0, skipped = 0;
    const processedSet = new Set(progress.processedItems || []);

    // Step 3: Process each item
    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];

      // Skip already processed
      if (processedSet.has(item.Item)) {
        // Still update inventory for existing products
        if (existingSkus[item.Item]) {
          await updateInventory(existingSkus[item.Item].variantId, item.Available || 0, locationId);
          updated++;
        }
        continue;
      }

      // Get full product detail
      const detail = await fetchCosmoDetail(item.Item);
      if (!detail) { skipped++; continue; }

      // Only fragrances
      if (detail.ProductLine !== "FRAG") { skipped++; processedSet.add(item.Item); continue; }

      if (existingSkus[item.Item]) {
        // Update inventory
        await updateInventory(existingSkus[item.Item].variantId, detail.Available || 0, locationId);
        updated++;
      } else {
        // Create new product
        const created_product = await createShopifyProduct(detail);
        if (created_product) {
          created++;
          console.log(`✅ Created (${i+1}/${allItems.length}): ${detail.Desc}`);
        } else {
          console.log(`⚠️ Failed to create: ${detail.Desc}`);
        }
      }

      processedSet.add(item.Item);

      // Save progress every 50 items
      if (i % 50 === 0) {
        saveProgress({ processedItems: Array.from(processedSet), lastPage: 1, totalProducts: allItems.length });
        console.log(`💾 Progress saved: ${i+1}/${allItems.length} processed`);
      }

      await sleep(400);
    }

    // Clear progress when fully done
    clearProgress();

    console.log(`\n📊 Sync complete! Created: ${created}, Updated: ${updated}, Skipped: ${skipped}`);

    // Process orders and tracking
    await processOrders();
    await syncTracking();

    console.log("🌸 All done!");
  } catch (err) {
    console.error("❌ Sync error:", err.message);
    console.error(err.stack);
  }
  syncRunning = false;
}

// ─── WEB SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  if (path === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>🌸 Bloom Fragrances USA Sync</h1>
      <p>Status: ${SHOPIFY_TOKEN ? "✅ Connected to Shopify" : "⚠️ Not connected"}</p>
      <p>Sync running: ${syncRunning ? "Yes ⏳" : "No"}</p>
      ${!SHOPIFY_TOKEN ? '<a href="/install"><button>Connect to Shopify</button></a>' : 
        '<a href="/sync"><button>Run Sync Now</button></a> <a href="/fullsync"><button>Full Reset Sync</button></a>'}`);
  }
  else if (path === "/install") {
    const host = `https://${req.headers.host}`;
    res.writeHead(302, { Location: getInstallUrl(host) });
    res.end();
  }
  else if (path === "/auth/callback") {
    const code = parsed.query.code;
    if (!code) { res.writeHead(400); res.end("Missing code"); return; }
    try {
      const host = `https://${req.headers.host}`;
      SHOPIFY_TOKEN = await exchangeCodeForToken(code, host);
      console.log("✅ Shopify OAuth complete!");
      console.log("🔑 SAVE THIS TOKEN TO RENDER ENV: " + SHOPIFY_TOKEN);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h1>✅ Connected!</h1><p>Your Shopify store is now connected. Sync starting now...</p><p><a href="/">Go back</a></p>`);
      runSync(true);
    } catch (err) {
      res.writeHead(500);
      res.end("OAuth failed: " + err.message);
    }
  }
  else if (path === "/sync") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Sync started! Check logs.");
    runSync();
  }
  else if (path === "/fullsync") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Full reset sync started! Check logs.");
    runSync(true);
  }
  else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`🌸 Bloom Fragrances USA server running on port ${PORT}`);
  setInterval(() => runSync(), 30 * 60 * 1000);
  if (SHOPIFY_TOKEN) setTimeout(() => runSync(), 5000);
});
