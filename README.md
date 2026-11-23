# QR Menu Pro - Backend API Server

High-performance, multi-tenant backend server for QR Menu Pro restaurant operating system.

## Features
- **Multi-Tenant Architecture**: Complete tenant isolation for restaurants, menus, orders, and KOT.
- **SaaS Subscription Catalog**: 4 Tiers (Starter, Growth, Ultra, Master Flagship) with granular feature gates.
- **Real-Time Order & Table Engine**: Socket.io live orders, status tracking, waiter calls, and instant notifications.
- **Inventory & Stock Management** (Ultra & Master): Real-time stock levels, low-stock alerts, auto-depletion on orders, auto-PO generator.
- **Voice Assistant "Bolna"** (Master): Audio announcement synthesis in Hindi & English for kitchen & order counters.
- **CRM & Loyalty Club** (Master): Customer profiling, LTV, visit history, loyalty wallet, 1-click WhatsApp campaign links.
- **Offline OCR Engine**: Python-based menu image digitizer (no external cloud API dependencies).

## Setup & Running

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start server
npm start
```

## Running Tests
```bash
node --test test/advanced.test.js
node --test test/flow.test.js
```

---
*Designed & Developed by Piyush Assudani · Founder, Assudani Developers*
