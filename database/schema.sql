-- ====================================================================
-- QR Menu App: Production PostgreSQL / Supabase Schema Blueprint
-- Includes: Multi-Tenancy RLS, RBAC, Idempotency, Order Billing, and Indexing
-- ====================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ====================================================================
-- 2. RBAC (ROLE-BASED ACCESS CONTROL)
-- Dedicated tables: Users, Roles, Permissions, Role_Permissions
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON public.users(is_active);

CREATE TABLE IF NOT EXISTS public.roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) UNIQUE NOT NULL, -- 'owner', 'manager', 'clerk', 'teacher', 'kitchen', 'waiter'
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) UNIQUE NOT NULL, -- 'create_order', 'view_billing', 'delete_user', etc.
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    restaurant_id UUID, -- NULL for platform super admin
    role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- Initial RBAC Seed Inserts
INSERT INTO public.roles (name, description) VALUES
    ('Owner', 'Full access to financial billing, user management, and restaurant configuration'),
    ('Manager', 'Operational control over menu editing, order management, and shift reports'),
    ('Clerk', 'Front-desk point of sale and order punch access with billing view'),
    ('Teacher', 'Educational menu demo and table ordering punch privileges'),
    ('Kitchen', 'Live KDS order queue viewing and cooking status transition updates'),
    ('Waiter', 'Table order creation and guest menu viewing')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.permissions (code, description) VALUES
    ('create_order', 'Punch new KOT orders for tables'),
    ('view_billing', 'Access financial receipts and settlement metrics'),
    ('delete_user', 'Deactivate or remove staff and user accounts'),
    ('manage_menu', 'Create, update, and 86 menu items'),
    ('manage_staff', 'Invite and assign roles to personnel'),
    ('view_menu', 'Read-only access to food and beverage items')
ON CONFLICT (code) DO NOTHING;

-- ====================================================================
-- 3. RESTAURANTS TENANTS TABLE
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.restaurants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL CHECK (length(trim(name)) > 0),
    slug VARCHAR(100) UNIQUE NOT NULL CHECK (slug ~* '^[a-z0-9-]+$'),
    qr_short_id VARCHAR(20) UNIQUE NOT NULL, -- Dynamic QR Router (e.g. /q/8f7d6)
    phone VARCHAR(20) CHECK (length(trim(phone)) >= 10),
    upi_id VARCHAR(100) CHECK (upi_id LIKE '%@%'), -- UPI payment integration
    google_review_url TEXT,
    tagline VARCHAR(255),
    opening_hours VARCHAR(100) DEFAULT '11:00 AM - 11:00 PM',
    plan_id VARCHAR(20) DEFAULT 'growth' CHECK (plan_id IN ('starter', 'growth', 'elite')),
    is_active BOOLEAN DEFAULT true, -- App Owner kill switch
    theme_json JSONB DEFAULT '{
        "preset": "luxury",
        "primaryColor": "#D97706",
        "accentColor": "#B45309",
        "backgroundColor": "#0F172A",
        "textColor": "#F8FAFC",
        "fontFamily": "Playfair Display",
        "layoutStyle": "cards"
    }'::jsonb,
    logo_url TEXT,
    banner_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Essential Performance Indexes
CREATE INDEX IF NOT EXISTS idx_restaurants_slug ON public.restaurants(slug);
CREATE INDEX IF NOT EXISTS idx_restaurants_qr_short_id ON public.restaurants(qr_short_id);
CREATE INDEX IF NOT EXISTS idx_restaurants_user_id ON public.restaurants(user_id);
CREATE INDEX IF NOT EXISTS idx_restaurants_is_active ON public.restaurants(is_active);

-- ====================================================================
-- 4. CATEGORIES TABLE
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
    sequence_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_restaurant ON public.categories(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_categories_restaurant_order ON public.categories(restaurant_id, sequence_order);

-- ====================================================================
-- 5. MENU ITEMS TABLE
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.menu_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    base_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (base_price >= 0),
    is_veg BOOLEAN DEFAULT true,
    spice_level VARCHAR(20) DEFAULT 'medium' CHECK (spice_level IN ('none', 'mild', 'medium', 'spicy', 'extra_spicy')),
    image_url TEXT,
    video_url TEXT, -- 3-5 sec looping reel preview
    is_out_of_stock BOOLEAN DEFAULT false, -- 1-Tap Live Out-of-Stock Kill Switch
    sequence_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Composite Indexes for Lightning Fast SSR Reads & Low Cloud DB Costs
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_available ON public.menu_items(restaurant_id, is_out_of_stock);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON public.menu_items(category_id);

-- ====================================================================
-- 6. ITEM VARIANTS & MODIFIERS (SIZES & ADD-ONS)
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.item_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_item_variants_item_id ON public.item_variants(item_id);

CREATE TABLE IF NOT EXISTS public.modifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES public.menu_items(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL CHECK (length(trim(name)) > 0),
    price NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (price >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_modifiers_item_id ON public.modifiers(item_id);

-- ====================================================================
-- 7. ORDERS & KITCHEN DISPLAY (KOT) TABLE
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    table_number VARCHAR(50) NOT NULL,
    order_code VARCHAR(20) NOT NULL, -- e.g. KOT-104
    idempotency_key VARCHAR(128) UNIQUE, -- Protects against double-billing & spam clicks
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'cooking', 'served', 'cancelled')),
    items_subtotal NUMERIC(10, 2) NOT NULL CHECK (items_subtotal >= 0),
    tax_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (tax_amount >= 0),
    discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
    grand_total NUMERIC(10, 2) NOT NULL CHECK (grand_total >= 0),
    customer_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status ON public.orders(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_idempotency ON public.orders(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(restaurant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    item_id UUID REFERENCES public.menu_items(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items(order_id);

-- ====================================================================
-- 8. FEEDBACK & GOOGLE REVIEW INTERCEPTOR TABLE
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.feedback_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    customer_name VARCHAR(100),
    phone VARCHAR(20),
    table_number VARCHAR(50),
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    message TEXT,
    is_intercepted BOOLEAN DEFAULT false, -- true for 1, 2, or 3 star ratings
    is_resolved BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_restaurant ON public.feedback_reviews(restaurant_id, is_resolved);

-- ====================================================================
-- 9. SUBSCRIPTIONS & AUTOMATED BILLING TABLE
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
    gateway_sub_id VARCHAR(255),
    plan_tier VARCHAR(20) NOT NULL CHECK (plan_tier IN ('starter', 'growth', 'elite')),
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMPTZ DEFAULT NOW(),
    current_period_end TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_restaurant ON public.subscriptions(restaurant_id);

-- ====================================================================
-- 10. ROW LEVEL SECURITY (RLS) POLICIES
-- ====================================================================

ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Public customer view: Only active restaurants and their in-stock items
CREATE POLICY "Public can view active restaurants"
    ON public.restaurants FOR SELECT
    USING (is_active = true);

CREATE POLICY "Public can view active categories"
    ON public.categories FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = categories.restaurant_id AND r.is_active = true));

CREATE POLICY "Public can view active items"
    ON public.menu_items FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = menu_items.restaurant_id AND r.is_active = true));

CREATE POLICY "Public can create orders"
    ON public.orders FOR INSERT
    WITH CHECK (EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = orders.restaurant_id AND r.is_active = true));

CREATE POLICY "Public can submit reviews"
    ON public.feedback_reviews FOR INSERT
    WITH CHECK (EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = feedback_reviews.restaurant_id AND r.is_active = true));

-- Restaurant owners can view and manage only their own restaurant tenant
CREATE POLICY "Owners manage restaurants" ON public.restaurants FOR ALL TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners manage orders" ON public.orders FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = orders.restaurant_id AND r.user_id = auth.uid()));
CREATE POLICY "Owners manage reviews" ON public.feedback_reviews FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM public.restaurants r WHERE r.id = feedback_reviews.restaurant_id AND r.user_id = auth.uid()));
