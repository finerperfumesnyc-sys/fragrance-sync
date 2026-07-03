/**
 * Bloom Fragrances USA - Shopify OAuth + Sync Server
 * Features: OAuth, product variant grouping, smart pricing, clean descriptions,
 * image normalization, order submission, tracking sync
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
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  } catch(e) {}
  return { processedGroups: [] };
}

function saveProgress(progress) {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress)); } catch(e) {}
}

function clearProgress() {
  try { if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE); } catch(e) {}
}

// ─── FEATURE 2: SMART PRICING ────────────────────────────────────────────────
function calculatePrice(wholesale, retail) {
  const net = parseFloat(wholesale || 0);
  const ret = parseFloat(retail || 0);
  const markupPrice = net + 20;
  const capPrice = ret > 0 ? ret - 5 : markupPrice;
  return Math.min(markupPrice, capPrice > 0 ? capPrice : markupPrice).toFixed(2);
}

// ─── FEATURE 3: CLEAN PRODUCT DESCRIPTIONS ──────────────────────────────────
function buildDescription(details) {
  // details is array of variants for one product group
  const first = details[0];
  const designer = first.Designer || "Designer";
  const fragName = extractFragranceName(first.Desc || first.Item);
  const productType = first.ProductClass || "Fragrance";
  const gender = extractGender(first.Desc || "");
  const sizes = details.map(d => extractSize(d.Desc || "")).filter(Boolean).join(", ");

  const genderWord = gender === "M" ? "men's" : gender === "W" ? "women's" : "unisex";

  return `<p>${fragName} ${productType} by ${designer}. A sophisticated ${genderWord} fragrance, available in ${sizes || "multiple sizes"}. An elegant addition to any collection.</p>`;
}

function extractFragranceName(title) {
  if (!title) return title;
  // Remove designer prefix (before /)
  let name = title.includes("/") ? title.split("/")[1] : title;
  // Remove size info like "3.4 OZ", "1.7 OZ (100 ML)"
  name = name.replace(/\d+\.?\d*\s*OZ[^(]*/gi, "").replace(/\(\d+\s*ML\)/gi, "").trim();
  // Remove gender markers
  name = name.replace(/\s*\([MWU]\)\s*/g, "").trim();
  // Remove product type words
  name = name.replace(/\b(EDP|EDT|EDC|EAU DE PARFUM|EAU DE TOILETTE|PARFUM|COLOGNE|SPRAY|TESTER|NO CAP|UNBOXED)\b/gi, "").trim();
  // Title case
  return name.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ").trim();
}

function extractSize(title) {
  if (!title) return null;
  const match = title.match(/(\d+\.?\d*)\s*OZ/i);
  return match ? `${match[1]} oz` : null;
}

function extractGender(title) {
  if (title.includes("(M)")) return "M";
  if (title.includes("(W)")) return "W";
  if (title.includes("(U)")) return "U";
  return "U";
}

function buildProductTitle(first) {
  const designer = first.Designer || "";
  const fragName = extractFragranceName(first.Desc || first.Item);
  const productType = extractProductType(first.Desc || "");
  const gender = extractGender(first.Desc || "");
  const genderLabel = gender === "M" ? "for Men" : gender === "W" ? "for Women" : "Unisex";
  return `${fragName} ${productType} by ${designer} ${genderLabel}`.trim();
}

function extractProductType(title) {
  if (/EDP|EAU DE PARFUM|PARFUM/i.test(title)) return "Eau de Parfum";
  if (/EDT|EAU DE TOILETTE/i.test(title)) return "Eau de Toilette";
  if (/EDC|EAU DE COLOGNE|COLOGNE/i.test(title)) return "Cologne";
  return "Fragrance";
}

// ─── FEATURE 1: GROUP PRODUCTS BY FRAGRANCE ──────────────────────────────────
function buildGroupKey(detail) {
  const designer = (detail.Designer || "UNKNOWN").toUpperCase().trim();
  const gender = extractGender(detail.Desc || "");
  const fragName = extractFragranceName(detail.Desc || detail.Item).toUpperCase();
  const productType = extractProductType(detail.Desc || "");
  return `${designer}||${fragName}||${productType}||${gender}`;
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
async function getAllShopifyProducts() {
  let productMap = {}; // groupKey -> shopify product id
  let skuMap = {};     // sku -> { productId, variantId }
  let path = "/admin/api/2024-01/products.json?limit=250&fields=id,title,variants,tags";
  while (true) {
    const res = await request({
      hostname: SHOPIFY_STORE, path, method: "GET",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
    });
    const products = res.body.products || [];
    for (const p of products) {
      for (const v of p.variants || []) {
        if (v.sku) {
          skuMap[v.sku] = { productId: p.id, variantId: v.id };
        }
      }
    }
    const link = res.headers && res.headers.link;
    if (link && link.includes('rel="next"')) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) { path = match[1].replace(`https://${SHOPIFY_STORE}`, ""); await sleep(500); }
      else break;
    } else break;
  }
  console.log(`🛍️ Existing Shopify SKUs: ${Object.keys(skuMap).length}`);
  return { skuMap };
}

async function getLocationId() {
  const res = await request({
    hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/locations.json", method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" }
  });
  return res.body?.locations?.[0]?.id;
}

// ─── FEATURE 4: IMAGE URL NORMALIZATION ──────────────────────────────────────
function normalizeImageUrl(imageUrl) {
  if (!imageUrl) return null;
  // Cosmopolitan images - ensure HTTPS and trim whitespace
  let normalized = imageUrl.trim();
  if (normalized.startsWith("http://")) normalized = normalized.replace("http://", "https://");
  return normalized || null;
}

// ─── CREATE/UPDATE SHOPIFY PRODUCT WITH VARIANTS ─────────────────────────────
async function createShopifyProductWithVariants(groupDetails) {
  const first = groupDetails[0];
  const title = buildProductTitle(first);
  const description = buildDescription(groupDetails);
  const imageUrl = normalizeImageUrl(first.ImageURL);

  // Build variants - one per size
  const variants = groupDetails.map(detail => {
    const size = extractSize(detail.Desc || "") || detail.Desc;
    const price = calculatePrice(detail.Net, detail.Retail);
    const comparePrice = detail.Retail ? parseFloat(detail.Retail).toFixed(2) : null;
    return {
      option1: size,
      sku: detail.Item,
      price,
      compare_at_price: comparePrice,
      inventory_management: "shopify",
      inventory_quantity: detail.Available || 0,
      weight: detail.Weight || 0,
      weight_unit: "oz",
      fulfillment_service: "manual",
      requires_shipping: true,
      taxable: true
    };
  });

  const product = {
    title,
    body_html: description,
    vendor: first.Designer || "Cosmopolitan Cosmetics",
    product_type: extractProductType(first.Desc || ""),
    tags: ["fragrance", first.ProductLine, first.ProductClass, extractGender(first.Desc || "")].filter(Boolean).join(", "),
    options: [{ name: "Size" }],
    variants,
    images: imageUrl ? [{ src: imageUrl }] : []
  };

  const res = await request(
    { hostname: SHOPIFY_STORE, path: "/admin/api/2024-01/products.json", method: "POST",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { product }
  );

  if (res.status === 201) {
    console.log(`✅ Created with ${variants.length} size(s): ${title}`);
    return res.body.product;
  } else {
    console.log(`⚠️ Failed to create: ${title}`, JSON.stringify(res.body).slice(0, 200));
    return null;
  }
}

async function addVariantToProduct(productId, detail) {
  const size = extractSize(detail.Desc || "") || detail.Desc;
  const price = calculatePrice(detail.Net, detail.Retail);
  const comparePrice = detail.Retail ? parseFloat(detail.Retail).toFixed(2) : null;

  const res = await request(
    { hostname: SHOPIFY_STORE, path: `/admin/api/2024-01/products/${productId}/variants.json`, method: "POST",
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" } },
    { variant: {
        option1: size,
        sku: detail.Item,
        price,
        compare_at_price: comparePrice,
        inventory_management: "shopify",
        inventory_quantity: detail.Available || 0,
        weight: detail.Weight || 0,
        weight_unit: "oz",
        fulfillment_service: "manual",
        requires_shipping: true,
        taxable: true
      }
    }
  );
  return res.status === 201 ? res.body.variant : null;
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

// ─── ORDER PROCESSING ─────────────────────────────────────────────────────────
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
      ShipTo: {
        Name: `${shipping.first_name} ${shipping.last_name}`.trim(),
        Line1: shipping.address1, Line2: shipping.address2 || undefined,
        City: shipping.city, State: shipping.province_code,
        Zip: shipping.zip, Country: shipping.country_code,
        Phone: shipping.phone || undefined, Email: order.email || undefined, Residence: true
      },
      Lines: order.line_items.map(item => ({
        SKU: item.sku, QTY: item.quantity,
        NET: Math.max(parseFloat(item.price) - 20, 1).toFixed(2),
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
  const orders = (res.body.orders || []).filter(o =>
    (o.tags || "").includes("cosmo-submitted") && !(o.tags || "").includes("cosmo-tracked")
  );
  for (const order of orders) {
    const orderNum = `BLOOM-${order.order_number}`;
    const trackRes = await request({
      hostname: "api.cosmopolitanusa.com",
      path: `/v1/dropship/suborder/${encodeURIComponent(orderNum)}`,
      method: "GET",
      headers: { Authorization: `CosmoToken ${COSMO_TOKEN}`, "Content-Type": "application/json" }
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
      { fulfillment: {
          line_items_by_fulfillment_order: [{ fulfillment_order_id: fulfillmentOrderId }],
          tracking_info: { number: tracking, company: carrierMap[carrier.toUpperCase()] || carrier },
          notify_customer: true
        }
      }
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
    const processedGroups = new Set(progress.processedGroups || []);

    // Step 1: Fetch all items from Cosmopolitan
    const allItems = await fetchAllCosmoItems();
    if (allItems.length === 0) { console.log("❌ No items from Cosmopolitan"); syncRunning = false; return; }

    // Step 2: Get existing Shopify SKUs
    const { skuMap } = await getAllShopifyProducts();
    const locationId = await getLocationId();

    // Step 3: Fetch details and group by fragrance
    console.log("📋 Fetching product details and grouping by fragrance...");
    const groups = {}; // groupKey -> array of details
    const productLines = new Set(); // track all product lines

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      const detail = await fetchCosmoDetail(item.Item);
      if (!detail) continue;
      
      // Log all product lines we see
      if (detail.ProductLine) productLines.add(detail.ProductLine);
      if (i === allItems.length - 1 || i % 500 === 0) {
        console.log("📋 Product lines found so far:", Array.from(productLines).join(", "));
      }
      
      // Pull FRAG and gift/set related product lines
      const allowedLines = ["FRAG", "GIFT", "GSET", "SET", "COFF", "GFTS"];
      if (!allowedLines.includes(detail.ProductLine)) continue;

      const key = buildGroupKey(detail);
      if (!groups[key]) groups[key] = [];
      groups[key].push(detail);

      if (i % 100 === 0) console.log(`📋 Processed ${i+1}/${allItems.length} items into groups...`);
      await sleep(300);
    }

    console.log(`📦 Grouped into ${Object.keys(groups).length} unique fragrances`);

    // Step 4: Create/update products
    let created = 0, updated = 0, skipped = 0;
    const groupKeys = Object.keys(groups);

    for (let g = 0; g < groupKeys.length; g++) {
      const key = groupKeys[g];
      const groupDetails = groups[key];

      // Check if any SKU in group already exists
      const existingVariant = groupDetails.find(d => skuMap[d.Item]);

      if (processedGroups.has(key)) {
        // Update inventory for all variants in group
        for (const detail of groupDetails) {
          if (skuMap[detail.Item]) {
            await updateInventory(skuMap[detail.Item].variantId, detail.Available || 0, locationId);
            updated++;
          }
        }
        continue;
      }

      if (existingVariant) {
        // Product exists — add any missing variants and update inventory
        const productId = skuMap[existingVariant.Item].productId;
        for (const detail of groupDetails) {
          if (skuMap[detail.Item]) {
            await updateInventory(skuMap[detail.Item].variantId, detail.Available || 0, locationId);
            updated++;
          } else {
            // Add new size variant to existing product
            await addVariantToProduct(productId, detail);
            updated++;
          }
          await sleep(300);
        }
      } else {
        // New product — create with all size variants
        await createShopifyProductWithVariants(groupDetails);
        created++;
        await sleep(500);
      }

      processedGroups.add(key);

      // Save progress every 25 groups
      if (g % 25 === 0) {
        saveProgress({ processedGroups: Array.from(processedGroups) });
        console.log(`💾 Progress saved: ${g+1}/${groupKeys.length} groups processed`);
      }
    }

    clearProgress();
    console.log(`\n📊 Sync complete! Created: ${created} products, Updated: ${updated} variants, Skipped: ${skipped}`);

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
      res.end(`<h1>✅ Connected!</h1><p>Sync starting now...</p><p><a href="/">Go back</a></p>`);
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
