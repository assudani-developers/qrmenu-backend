const express = require('express');
const router = express.Router();
const {
  restaurantsDb,
  restaurantData,
  ordersDb,
  feedbacksDb,
  adminConfig,
  paymentsDb,
  broadcastsDb,
  activitiesDb,
  recordActivity,
  persistDb,
  findRestaurantById,
  findRestaurantByShortId,
  findRestaurantBySlug,
} = require('../db');

/**
 * GET /api/health
 * Production health and uptime diagnostics
 */
router.get('/health', (req, res) => {
  const memoryUsage = process.memoryUsage();
  res.status(200).json({
    status: 'ok',
    message: 'Backend server is running healthy and responsive',
    system: 'Assudani QR Dining Operating System',
    developer: {
      architect: 'Piyush Assudani',
      founder: 'Assudani Developers',
    },
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMb: {
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/sync
 * Complete live state sync for Flutter App & Admin Panel
 */
router.get('/sync', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  return res.status(200).json({
    success: true,
    restaurant: restaurantData,
    categories: restaurantData.categories,
    tables: restaurantData.tables,
    items: restaurantData.items,
    orders: ordersDb,
    feedbacks: feedbacksDb,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/menu/:slug
 * Multi-tenant resolution with ETag and CDN caching headers to minimize cloud bandwidth
 */
router.get('/menu/:slug', (req, res) => {
  const { slug } = req.params;

  let rest = null;
  if (slug === 'default') {
    rest = restaurantData;
  } else {
    rest = findRestaurantBySlug(slug) || findRestaurantByShortId(slug) || (slug === restaurantData.slug ? restaurantData : null);
  }

  if (!rest) {
    return res.status(404).json({
      status: 404,
      error: 'Not Found',
      message: `Restaurant with slug "${slug}" not found.`,
    });
  }

  // Fast ETag generation for CDN / browser caching
  const etag = `W/"${rest.id}-${rest.items.length}-${rest.isActive}-${rest.currentPlan}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120, stale-while-revalidate=300');

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  return res.status(200).json({
    success: true,
    restaurant: {
      id: rest.id,
      name: rest.name,
      tagline: rest.tagline,
      slug: rest.slug,
      shortId: rest.shortId,
      phone: rest.phone,
      upiId: rest.upiId,
      googleReviewUrl: rest.googleReviewUrl,
      isActive: rest.isActive,
      brandColorHex: rest.brandColorHex,
      tables: rest.tables,
    },
    categories: rest.categories,
    items: rest.items,
  });
});

/**
 * POST /api/menu/items
 * Add a new dish to the digital menu
 */
router.post('/menu/items', (req, res) => {
  const { name, category, price, description, isVeg, spiceLevel, imageUrl, variants, modifiers } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ status: 400, error: 'Bad Request', message: 'Valid dish name is required.' });
  }

  const numPrice = Number(price);
  if (isNaN(numPrice) || numPrice < 0) {
    return res.status(400).json({ status: 400, error: 'Bad Request', message: 'Valid positive price is required.' });
  }

  const newItem = {
    id: `dish-${Date.now()}`,
    name: name.trim(),
    category: category && typeof category === 'string' ? category.trim() : 'Chef Specials',
    price: numPrice,
    description: description ? String(description).trim() : '',
    isVeg: Boolean(isVeg),
    spiceLevel: spiceLevel || 'medium',
    isAvailable: true,
    imageUrl: imageUrl || 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=500',
    variants: Array.isArray(variants) ? variants : [],
    modifiers: Array.isArray(modifiers) ? modifiers : [],
  };

  restaurantData.items.push(newItem);
  persistDb();

  // Broadcast to all connected clients (Admin & Customer Menu)
  const io = req.app.get('io');
  if (io) {
    io.emit('menu:item_added', newItem);
  }

  return res.status(201).json({
    success: true,
    message: 'Dish added to digital menu successfully.',
    item: newItem,
  });
});

/**
 * PATCH /api/menu/items/:id/availability
 * Live Kill Switch - toggle in-stock / out-of-stock
 */
router.patch('/menu/items/:id/availability', (req, res) => {
  const { id } = req.params;
  const { isAvailable } = req.body;

  const dish = restaurantData.items.find((d) => d.id === id);
  if (!dish) {
    return res.status(404).json({ status: 404, error: 'Not Found', message: `Dish "${id}" not found.` });
  }

  dish.isAvailable = typeof isAvailable === 'boolean' ? isAvailable : !dish.isAvailable;
  persistDb();

  const io = req.app.get('io');
  if (io) {
    io.emit('menu:availability_changed', { id: dish.id, isAvailable: dish.isAvailable });
  }

  return res.status(200).json({
    success: true,
    message: `Dish availability updated to ${dish.isAvailable}`,
    item: dish,
  });
});

/**
 * DELETE /api/menu/items/:id
 * Remove a dish from the menu
 */
router.delete('/menu/items/:id', (req, res) => {
  const { id } = req.params;
  const index = restaurantData.items.findIndex((d) => d.id === id);
  if (index === -1) {
    return res.status(404).json({ status: 404, error: 'Not Found', message: `Dish "${id}" not found.` });
  }

  const [deleted] = restaurantData.items.splice(index, 1);
  persistDb();

  const io = req.app.get('io');
  if (io) {
    io.emit('menu:item_deleted', { id });
  }

  return res.status(200).json({
    success: true,
    message: `Dish "${deleted.name}" removed from menu.`,
  });
});

/**
 * PATCH /api/restaurant/settings
 * Update restaurant profile, review link, tables
 */
router.patch('/restaurant/settings', (req, res) => {
  const { name, tagline, phone, upiId, googleReviewUrl, brandColorHex, tables, currentPlan } = req.body;

  if (name) restaurantData.name = String(name).trim();
  if (tagline) restaurantData.tagline = String(tagline).trim();
  if (phone) restaurantData.phone = String(phone).trim();
  if (upiId) restaurantData.upiId = String(upiId).trim();
  if (googleReviewUrl) restaurantData.googleReviewUrl = String(googleReviewUrl).trim();
  if (brandColorHex) restaurantData.brandColorHex = String(brandColorHex).trim();
  if (Array.isArray(tables)) restaurantData.tables = tables;
  if (currentPlan) restaurantData.currentPlan = currentPlan;
  persistDb();

  return res.status(200).json({
    success: true,
    message: 'Restaurant settings updated successfully.',
    restaurant: restaurantData,
  });
});

/**
 * GET /api/qr/:shortId
 * Multi-tenant Dynamic QR Router permanent resolver with sub-millisecond O(1) hash lookup
 */
router.get('/qr/:shortId', (req, res) => {
  const { shortId } = req.params;

  const rest = findRestaurantByShortId(shortId) || (shortId === restaurantData.shortId ? restaurantData : null);

  if (rest) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return res.status(200).json({
      success: true,
      shortId,
      slug: rest.slug,
      redirectUrl: `/menu/${rest.slug}`,
      isActive: rest.isActive,
    });
  }

  return res.status(404).json({
    status: 404,
    error: 'Not Found',
    message: `Dynamic QR shortId "${shortId}" does not exist.`,
  });
});

/**
 * POST /api/feedback
 * Google Review Interceptor feedback handler
 */
router.post('/feedback', (req, res) => {
  const { customerName, phone, tableNumber, rating, message, restaurantId } = req.body;
  const fbRest = (restaurantId && findRestaurantById(String(restaurantId))) || restaurantData;

  const numRating = Number(rating);
  if (!numRating || numRating < 1 || numRating > 5) {
    return res.status(400).json({
      status: 400,
      error: 'Bad Request',
      message: 'Rating must be an integer between 1 and 5.',
    });
  }

  const feedbackRecord = {
    id: `fb_${Date.now()}`,
    customerName: customerName ? String(customerName).trim() : 'Guest',
    phone: phone ? String(phone).trim() : 'Not Provided',
    tableNumber: tableNumber ? String(tableNumber).trim() : 'General',
    restaurantId: fbRest.id,
    rating: numRating,
    message: message ? String(message).trim() : '',
    timestamp: 'Just now',
    isIntercepted: numRating <= 3,
    isResolved: false,
    createdAt: new Date().toISOString(),
  };

  feedbacksDb.unshift(feedbackRecord);
  persistDb();

  const io = req.app.get('io');
  if (io && feedbackRecord.isIntercepted) {
    io.emit('feedback:new', feedbackRecord);
  }

  return res.status(201).json({
    success: true,
    message: numRating >= 4 ? 'Thank you! Redirecting to Google Maps.' : 'Feedback recorded privately.',
    isIntercepted: numRating <= 3,
    googleReviewUrl: numRating >= 4 ? fbRest.googleReviewUrl : null,
    feedback: feedbackRecord,
  });
});

/**
 * GET /api/feedback
 * Owner retrieves private intercepted feedbacks
 */
router.get('/feedback', (req, res) => {
  return res.status(200).json({
    success: true,
    count: feedbacksDb.length,
    feedbacks: feedbacksDb,
  });
});

/**
 * PATCH /api/feedback/:id/resolve
 */
router.patch('/feedback/:id/resolve', (req, res) => {
  const { id } = req.params;
  const fb = feedbacksDb.find((f) => f.id === id);
  if (!fb) {
    return res.status(404).json({ status: 404, error: 'Not Found', message: `Feedback ${id} not found.` });
  }

  fb.isResolved = true;
  persistDb();
  return res.status(200).json({ success: true, message: 'Feedback marked resolved.', feedback: fb });
});

// ==========================================
// SUPER ADMIN PAYMENT & BROADCAST CRM ROUTES
// ==========================================

/**
 * GET /api/payments/config
 * Provides the active Super Admin receiving UPI ID and plan price catalogue
 */
router.get('/payments/config', (req, res) => {
  return res.status(200).json({
    success: true,
    adminUpiId: adminConfig.adminUpiId,
    adminPhone: adminConfig.adminPhone,
    plans: adminConfig.plans,
  });
});

/**
 * POST /api/payments/intent
 * Generates direct UPI intent URI and Razorpay checkout metadata
 */
router.post('/payments/intent', (req, res) => {
  const { planId, restaurantName, phone } = req.body;
  const targetPlan = adminConfig.plans[planId] || adminConfig.plans.growth;
  const amount = targetPlan.price;

  // Standard UPI URI protocol specification
  // upi://pay?pa=<VPA>&pn=<NAME>&am=<AMOUNT>&cu=INR&tn=<NOTE>
  const upiIntentUri = `upi://pay?pa=${adminConfig.adminUpiId}&pn=QRMenuPro&am=${amount.toFixed(2)}&cu=INR&tn=Plan_${planId.toUpperCase()}_Upgrade`;

  return res.status(200).json({
    success: true,
    planId,
    amount,
    adminUpiId: adminConfig.adminUpiId,
    upiIntentUri,
    razorpayOrderId: `order_${Date.now().toString().slice(-8)}`,
    currency: 'INR',
    qrPayload: upiIntentUri,
  });
});

/**
 * POST /api/payments/verify-upi
 * Shop owner submits their 12-digit UPI UTR reference or Razorpay payment ID
 */
router.post('/payments/verify-upi', (req, res) => {
  const { planId, utrRef, method, restaurantName, phone } = req.body;

  if (!planId || !utrRef) {
    return res.status(400).json({
      status: 400,
      error: 'Bad Request',
      message: 'Plan ID and valid UPI UTR reference / Payment ID are required.',
    });
  }

  const targetPlan = adminConfig.plans[planId] || adminConfig.plans.growth;

  const newTx = {
    id: `TXN-${Date.now().toString().slice(-5)}`,
    restaurantId: restaurantData.id,
    restaurantName: restaurantName || restaurantData.name,
    ownerName: 'Restaurant Manager',
    phone: phone || restaurantData.phone,
    planId,
    amount: targetPlan.price,
    method: method || 'UPI_INTENT',
    utrRef: String(utrRef).trim(),
    payeeUpi: adminConfig.adminUpiId,
    status: 'verified', // Auto-activated on UTR submission
    date: new Date().toISOString(),
  };

  paymentsDb.unshift(newTx);

  // Update current restaurant plan immediately in memory & mark active
  restaurantData.currentPlan = planId;
  restaurantData.isActive = true;
  persistDb();

  return res.status(200).json({
    success: true,
    message: `Payment verified. Upgraded to ${targetPlan.name} for 30 days!`,
    transaction: newTx,
    currentPlan: restaurantData.currentPlan,
    isActive: restaurantData.isActive,
  });
});

/**
 * GET /api/admin/payments
 * Super Admin CRM: view all transaction receipts
 */
router.get('/admin/payments', (req, res) => {
  return res.status(200).json({
    success: true,
    adminUpiId: adminConfig.adminUpiId,
    count: paymentsDb.length,
    payments: paymentsDb,
  });
});

/**
 * GET /api/broadcasts
 * Flutter mobile app: fetch active announcements from Super Admin
 */
router.get('/broadcasts', (req, res) => {
  return res.status(200).json({
    success: true,
    count: broadcastsDb.length,
    broadcasts: broadcastsDb,
  });
});

/**
 * POST /api/admin/broadcasts
 * Super Admin: dispatch new announcement to all mobile clients
 */
router.post('/admin/broadcasts', (req, res) => {
  const { title, message, target, type } = req.body;

  if (!title || !message) {
    return res.status(400).json({ status: 400, error: 'Bad Request', message: 'Title and message are required.' });
  }

  const newBroadcast = {
    id: `BC-${Date.now().toString().slice(-4)}`,
    title: title.trim(),
    message: message.trim(),
    target: target || 'all',
    type: type || 'announcement',
    date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  };

  broadcastsDb.unshift(newBroadcast);
  recordActivity('broadcast', 'New Broadcast Dispatched', `Broadcast: "${newBroadcast.title}" pushed to mobile apps.`);
  persistDb();

  return res.status(201).json({
    success: true,
    message: 'Broadcast published to mobile application notification network.',
    broadcast: newBroadcast,
  });
});

/**
 * GET /api/admin/overview
 * Master SaaS CRM Dashboard Metrics (Computed strictly from Database)
 */
router.get('/admin/overview', (req, res) => {
  const activeTenants = restaurantsDb.filter((r) => r.isActive);
  const suspendedTenants = restaurantsDb.filter((r) => !r.isActive);
  const totalMRR = activeTenants.reduce((sum, r) => sum + (r.mrr || (adminConfig.plans[r.plan]?.price || 0)), 0);
  const totalScans = restaurantsDb.reduce((sum, r) => sum + (r.totalScans || 0), 0);
  const verifiedPayments = paymentsDb.filter((p) => p.status === 'verified');
  const totalRevenue = verifiedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const pendingAudits = paymentsDb.filter((p) => p.status === 'pending');

  const planDistribution = {
    starter: restaurantsDb.filter((r) => r.plan === 'starter' || r.currentPlan === 'starter').length,
    growth: restaurantsDb.filter((r) => r.plan === 'growth' || r.currentPlan === 'growth').length,
    elite: restaurantsDb.filter((r) => r.plan === 'elite' || r.currentPlan === 'elite').length,
  };

  return res.status(200).json({
    success: true,
    metrics: {
      totalClients: restaurantsDb.length,
      activeClients: activeTenants.length,
      suspendedClients: suspendedTenants.length,
      totalMRR,
      totalScans,
      totalOrders: ordersDb.length,
      totalRevenue,
      pendingAuditsCount: pendingAudits.length,
      adminUpiId: adminConfig.adminUpiId,
      planDistribution,
    },
    recentTenants: restaurantsDb.slice(0, 5),
    recentPayments: paymentsDb.slice(0, 5),
    recentActivities: activitiesDb.slice(0, 8),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/admin/restaurants
 * Full CRM Directory of all onboarded restaurant tenants
 */
router.get('/admin/restaurants', (req, res) => {
  return res.status(200).json({
    success: true,
    count: restaurantsDb.length,
    restaurants: restaurantsDb,
  });
});

/**
 * POST /api/admin/restaurants
 * App Owner onboards a new client restaurant
 */
router.post('/admin/restaurants', (req, res) => {
  const { name, ownerName, phone, city, plan, upiId } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ status: 400, error: 'Bad Request', message: 'Valid restaurant name is required.' });
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const shortId = Math.random().toString(36).substring(2, 7);
  const chosenPlan = plan && adminConfig.plans[plan] ? plan : 'growth';
  const planPrice = adminConfig.plans[chosenPlan].price;

  const newRestaurant = {
    id: `rest-${Date.now().toString().slice(-4)}`,
    name: name.trim(),
    ownerName: ownerName ? String(ownerName).trim() : 'Restaurant Partner',
    phone: phone ? String(phone).trim() : '+91 98000 00000',
    city: city ? String(city).trim() : 'India',
    tagline: 'Premium Dining & Culinary Experience',
    slug,
    shortId,
    upiId: upiId ? String(upiId).trim() : `${slug}@okaxis`,
    googleReviewUrl: `https://g.page/r/${slug}`,
    isActive: true,
    currentPlan: chosenPlan,
    plan: chosenPlan,
    mrr: planPrice,
    totalScans: 0,
    joinedDate: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    brandColorHex: '#D97706',
    tables: ['Table 1', 'Table 2', 'Table 3', 'Table 4'],
    categories: ['Chef Specials', 'Mains', 'Beverages'],
    items: [],
  };

  restaurantsDb.unshift(newRestaurant);
  recordActivity('restaurant', 'New Merchant Onboarded', `${newRestaurant.name} (${newRestaurant.city}) joined on ${chosenPlan.toUpperCase()} plan.`);
  persistDb();

  return res.status(201).json({
    success: true,
    message: 'Restaurant successfully registered on platform.',
    restaurant: newRestaurant,
  });
});

/**
 * PATCH /api/admin/restaurants/:id/toggle-status
 * Instant Kill Switch - Suspends or Activates client QR menu access
 */
router.patch('/admin/restaurants/:id/toggle-status', (req, res) => {
  const { id } = req.params;
  const restaurant = restaurantsDb.find((r) => r.id === id);

  if (!restaurant) {
    return res.status(404).json({ status: 404, error: 'Not Found', message: `Restaurant "${id}" not found.` });
  }

  restaurant.isActive = !restaurant.isActive;
  if (restaurant.id === restaurantData.id) {
    restaurantData.isActive = restaurant.isActive;
  }

  const actionText = restaurant.isActive ? 'ACTIVATED' : 'SUSPENDED';
  recordActivity('status', `Merchant ${actionText}`, `${restaurant.name} was ${actionText.toLowerCase()} by App Owner kill switch.`);
  persistDb();

  return res.status(200).json({
    success: true,
    message: `Restaurant "${restaurant.name}" is now ${actionText}.`,
    restaurant,
  });
});

/**
 * POST /api/admin/payments/:id/verify
 * 1-Click Verification of pending UPI UTR by App Owner
 */
router.post('/admin/payments/:id/verify', (req, res) => {
  const { id } = req.params;
  const payment = paymentsDb.find((p) => p.id === id);

  if (!payment) {
    return res.status(404).json({ status: 404, error: 'Not Found', message: `Transaction "${id}" not found.` });
  }

  payment.status = 'verified';
  payment.expiryExtendedTo = new Date(Date.now() + 30 * 24 * 3600 * 1000).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  // Activate restaurant if suspended
  const targetRest = restaurantsDb.find((r) => r.id === payment.restaurantId);
  if (targetRest) {
    targetRest.isActive = true;
    targetRest.plan = payment.planId;
    targetRest.currentPlan = payment.planId;
  }

  recordActivity('payment', 'Payment Verified by Admin', `₹${payment.amount} for ${payment.restaurantName} approved & subscription extended +30 days.`);
  persistDb();

  return res.status(200).json({
    success: true,
    message: `Payment ${payment.id} verified. Subscription activated +30 days.`,
    payment,
  });
});

/**
 * GET /api/admin/activities
 * Real-time platform activity feed
 */
router.get('/admin/activities', (req, res) => {
  return res.status(200).json({
    success: true,
    count: activitiesDb.length,
    activities: activitiesDb,
  });
});

module.exports = router;
