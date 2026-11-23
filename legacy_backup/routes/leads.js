const express = require('express');
const router = express.Router();
const { db, persistDb } = require('../db');
const { toUtcIso } = require('../utils/resilientClient');

/**
 * POST /api/leads
 * Capture prospective restaurant client inquiries from website
 */
router.post('/', async (req, res) => {
  try {
    const {
      restaurantName,
      ownerName,
      phone,
      city,
      dailyTables,
      planPreference = 'growth',
      notes,
    } = req.body;

    if (!restaurantName || !phone) {
      return res.status(400).json({
        success: false,
        error: 'Restaurant name and WhatsApp phone number are required',
      });
    }

    if (!db.leads) {
      db.leads = [];
    }

    const newLead = {
      id: `lead_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      restaurantName: String(restaurantName).trim(),
      ownerName: ownerName ? String(ownerName).trim() : 'Restaurant Partner',
      phone: String(phone).trim(),
      city: city ? String(city).trim() : 'India',
      dailyTables: dailyTables ? Number(dailyTables) : 10,
      planPreference,
      notes: notes ? String(notes).trim() : '',
      status: 'new',
      createdAt: toUtcIso(new Date()),
      assignedTo: 'Piyush Assudani (Founder)',
    };

    db.leads.unshift(newLead);
    persistDb();

    // Broadcast live event to Super Admin Dashboard
    const io = req.app.get('io');
    if (io) {
      io.emit('lead:new', newLead);
    }

    return res.status(201).json({
      success: true,
      message: 'Demo inquiry received! Piyush Assudani and the Assudani Developers team will connect via WhatsApp.',
      leadId: newLead.id,
      developer: {
        founder: 'Piyush Assudani',
        organization: 'Assudani Developers',
      },
    });
  } catch (err) {
    console.error('[Leads API] Error creating lead:', err);
    return res.status(500).json({ success: false, error: 'Failed to submit demo request' });
  }
});

/**
 * GET /api/leads
 * Retrieve all incoming restaurant leads (for Super Admin CRM)
 */
router.get('/', (req, res) => {
  const leads = db.leads || [];
  return res.status(200).json({
    success: true,
    total: leads.length,
    leads,
  });
});

/**
 * PATCH /api/leads/:id
 * Update status, notes, or assigned agent
 */
router.patch('/:id', (req, res) => {
  if (!db.leads) db.leads = [];
  const leadIndex = db.leads.findIndex((l) => l.id === req.params.id);
  if (leadIndex === -1) {
    return res.status(404).json({ success: false, error: 'Lead not found' });
  }

  const { status, notes, trialExpiresAt } = req.body;
  if (status) db.leads[leadIndex].status = status;
  if (notes !== undefined) db.leads[leadIndex].notes = notes;
  if (trialExpiresAt !== undefined) db.leads[leadIndex].trialExpiresAt = trialExpiresAt;

  db.leads[leadIndex].updatedAt = toUtcIso(new Date());
  persistDb();

  return res.status(200).json({
    success: true,
    message: 'Lead updated successfully',
    lead: db.leads[leadIndex],
  });
});

/**
 * POST /api/leads/:id/convert
 * Onboard lead as an active tenant with 7-Day Free Trial
 */
router.post('/:id/convert', (req, res) => {
  if (!db.leads) db.leads = [];
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) {
    return res.status(404).json({ success: false, error: 'Lead not found' });
  }

  const slug = lead.restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const existingRestaurant = db.restaurants.find((r) => r.slug === slug || r.phone === lead.phone);
  
  if (existingRestaurant) {
    lead.status = 'converted';
    lead.restaurantId = existingRestaurant.id;
    persistDb();
    return res.status(200).json({
      success: true,
      message: 'Lead linked to existing restaurant tenant',
      restaurant: existingRestaurant,
    });
  }

  const trialEnds = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const newRestaurant = {
    id: `rest_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: lead.restaurantName,
    slug: slug || `resto-${Date.now()}`,
    owner: lead.ownerName,
    phone: lead.phone,
    city: lead.city,
    tables: Array.from({ length: Math.min(lead.dailyTables || 10, 50) }, (_, i) => ({
      tableNumber: `Table ${i + 1}`,
      seats: 4,
      isOccupied: false,
    })),
    subscription: {
      planId: lead.planPreference || 'growth',
      status: 'trial_active',
      isTrial: true,
      trialDaysRemaining: 7,
      trialExpiresAt: trialEnds,
      expiresAt: trialEnds,
      autoPay: false,
    },
    menu: [
      { id: 'item_1', name: 'Chef Special Paneer Tikka', price: 290, category: 'Starters', isAvailable: true },
      { id: 'item_2', name: 'Dum Biryani Pot', price: 380, category: 'Main Course', isAvailable: true },
      { id: 'item_3', name: 'Cold Pressed Lime Soda', price: 120, category: 'Beverages', isAvailable: true }
    ],
    isActive: true,
    createdAt: toUtcIso(new Date()),
  };

  db.restaurants.push(newRestaurant);
  lead.status = 'converted';
  lead.convertedAt = toUtcIso(new Date());
  lead.restaurantId = newRestaurant.id;
  persistDb();

  return res.status(201).json({
    success: true,
    message: 'Lead converted into active tenant with 7-Day Free Trial!',
    restaurant: newRestaurant,
  });
});

/**
 * DELETE /api/leads/:id
 * Remove lead inquiry
 */
router.delete('/:id', (req, res) => {
  if (!db.leads) db.leads = [];
  const initialLen = db.leads.length;
  db.leads = db.leads.filter((l) => l.id !== req.params.id);
  if (db.leads.length === initialLen) {
    return res.status(404).json({ success: false, error: 'Lead not found' });
  }

  persistDb();
  return res.status(200).json({ success: true, message: 'Lead deleted successfully' });
});

module.exports = router;
