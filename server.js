const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ── RATE LIMITING (item 10) ──
// Simple in-memory rate limiter (swap for redis-based in prod)
const rateLimitMap = new Map();

function rateLimit({ windowMs = 60_000, max = 20, message = "Too many requests" } = {}) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, start: now };

    if (now - entry.start > windowMs) {
      entry.count = 1;
      entry.start = now;
    } else {
      entry.count++;
    }

    rateLimitMap.set(key, entry);

    if (entry.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// ── ERROR LOGGER (item 9) ──
function logError(context, err, extra = {}) {
  const entry = {
    time: new Date().toISOString(),
    context,
    message: err?.message || String(err),
    stack: err?.stack,
    ...extra,
  };
  console.error("❌ ERROR:", JSON.stringify(entry, null, 2));

  // Persist error to Supabase error_logs table (non-blocking)
  supabase.from("error_logs").insert(entry).then(() => {}).catch(() => {});
}

// ── SUPABASE CLIENT ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CLICKPESA CONFIG ──
const CLICKPESA = {
  clientId: process.env.CLICKPESA_CLIENT_ID,
  apiKey: process.env.CLICKPESA_API_KEY,
  baseUrl: process.env.CLICKPESA_BASE_URL || "https://api.clickpesa.com",
  webhookSecret: process.env.CLICKPESA_WEBHOOK_SECRET || "",
};

// ── AUTH MIDDLEWARE (item 1) ──
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }
  const token = authHeader.split(" ")[1];

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  req.user = data.user;
  next();
}

// Admin-only middleware
async function verifyAdmin(req, res, next) {
  await verifyToken(req, res, async () => {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", req.user.id)
      .single();

    if (profile?.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  });
}

// ── CLICKPESA HEADERS HELPER ──
const cpHeaders = () => ({
  "api-key": CLICKPESA.apiKey,
  "client-id": CLICKPESA.clientId,
  "Content-Type": "application/json",
});

// ── EXPIRY HELPER ──
function getExpiryDate(type) {
  const d = new Date();
  const days = { daily: 1, weekly: 7, monthly: 30 };
  d.setDate(d.getDate() + (days[type] || 1));
  return d.toISOString();
}

// ════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    status: "FinXhubra Backend Running ✅",
    time: new Date(),
    payments: "ClickPesa Connected 💳",
    database: "Supabase Connected 🗄️",
  });
});

// ════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════
app.post("/auth/signup", rateLimit({ max: 5, windowMs: 60_000, message: "Too many signup attempts" }), async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: "Email, password and name required" });

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, role: role || "trader" },
    });

    if (authError) return res.status(400).json({ error: authError.message });

    res.json({ success: true, user: { id: authData.user.id, email, name } });
  } catch (err) {
    logError("/auth/signup", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/login", rateLimit({ max: 10, windowMs: 60_000, message: "Too many login attempts" }), async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: "Invalid email or password" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

    res.json({ success: true, token: data.session.access_token, user: profile });
  } catch (err) {
    logError("/auth/login", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// USER PROFILE ROUTES (item 6)
// ════════════════════════════════════════════

// Get own profile
app.get("/profile", verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .single();

    if (error) return res.status(404).json({ error: "Profile not found" });
    res.json({ success: true, profile: data });
  } catch (err) {
    logError("/profile GET", err);
    res.status(500).json({ error: err.message });
  }
});

// Update own profile
app.patch("/profile", verifyToken, async (req, res) => {
  try {
    const allowed = ["name", "phone", "avatar_url", "bio", "country"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: "No valid fields to update" });

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", req.user.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, profile: data });
  } catch (err) {
    logError("/profile PATCH", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// PROVIDERS
// ════════════════════════════════════════════

// List active providers (public)
app.get("/providers", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("providers")
      .select("id, name, description, avatar_url, asset_focus, win_rate, total_signals, daily_price, weekly_price, monthly_price, created_at")
      .eq("status", "active");

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, providers: data });
  } catch (err) {
    logError("/providers GET", err);
    res.status(500).json({ error: err.message });
  }
});

// Register as a provider (item 2)
app.post("/providers/register", verifyToken, async (req, res) => {
  try {
    const { name, description, asset_focus, daily_price, weekly_price, monthly_price } = req.body;

    if (!name || !asset_focus)
      return res.status(400).json({ error: "name and asset_focus are required" });

    // Check if this user already has a provider profile
    const { data: existing } = await supabase
      .from("providers")
      .select("id")
      .eq("user_id", req.user.id)
      .single();

    if (existing) return res.status(409).json({ error: "You already have a provider profile" });

    // Generate a unique provider_id and secret key
    const provider_id = `prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const secret_key = crypto.randomBytes(32).toString("hex");

    const { data, error } = await supabase
      .from("providers")
      .insert({
        user_id: req.user.id,
        provider_id,
        secret_key,
        name,
        description: description || null,
        asset_focus,
        daily_price: daily_price || 0,
        weekly_price: weekly_price || 0,
        monthly_price: monthly_price || 0,
        status: "pending", // Admin must approve
        win_rate: 0,
        total_signals: 0,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Also update the user's role in profiles table
    await supabase.from("profiles").update({ role: "provider" }).eq("id", req.user.id);

    res.json({
      success: true,
      message: "Provider application submitted. Pending admin approval.",
      provider: {
        ...data,
        // Return the secret key ONCE — never stored in plaintext again
        secret_key,
        webhook_url: `/webhook/${provider_id}`,
      },
    });
  } catch (err) {
    logError("/providers/register", err);
    res.status(500).json({ error: err.message });
  }
});

// Get own provider profile
app.get("/providers/me", verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("providers")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ error: "No provider profile found" });
    res.json({ success: true, provider: data });
  } catch (err) {
    logError("/providers/me", err);
    res.status(500).json({ error: err.message });
  }
});

// Update own provider profile
app.patch("/providers/me", verifyToken, async (req, res) => {
  try {
    const allowed = ["name", "description", "avatar_url", "asset_focus", "daily_price", "weekly_price", "monthly_price"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: "No valid fields to update" });

    const { data, error } = await supabase
      .from("providers")
      .update(updates)
      .eq("user_id", req.user.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, provider: data });
  } catch (err) {
    logError("/providers/me PATCH", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// SIGNALS
// ════════════════════════════════════════════
app.get("/signals/:providerId", verifyToken, async (req, res) => {
  try {
    // Check if user has active access to this provider
    const now = new Date().toISOString();
    const { data: access } = await supabase
      .from("payments")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("provider_id", req.params.providerId)
      .eq("status", "active")
      .gt("expires_at", now);

    // Allow provider themselves to see their own signals
    const { data: provider } = await supabase
      .from("providers")
      .select("user_id")
      .eq("id", req.params.providerId)
      .single();

    const isOwner = provider?.user_id === req.user.id;
    const hasAccess = (access && access.length > 0) || isOwner;

    if (!hasAccess)
      return res.status(403).json({ error: "No active subscription for this provider" });

    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .eq("provider_id", req.params.providerId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, signals: data });
  } catch (err) {
    logError("/signals/:providerId", err);
    res.status(500).json({ error: err.message });
  }
});

// ── TRADINGVIEW WEBHOOK (public — verified by secret) ──
app.post("/webhook/:providerId", async (req, res) => {
  try {
    const { asset, action, entry, stop_loss, take_profit, secret } = req.body;
    const { providerId } = req.params;

    const { data: provider } = await supabase
      .from("providers")
      .select("*")
      .eq("provider_id", providerId)
      .single();

    if (!provider) return res.status(404).json({ error: "Provider not found" });
    if (provider.secret_key !== secret)
      return res.status(401).json({ error: "Invalid secret — unauthorized" });

    const { data: signal, error } = await supabase
      .from("signals")
      .insert({
        provider_id: provider.id,
        asset,
        direction: action,
        entry_price: entry,
        stop_loss,
        take_profit,
        status: "ACTIVE",
        source: "tradingview",
        executed: false,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Increment total_signals count for provider
    await supabase
      .from("providers")
      .update({ total_signals: (provider.total_signals || 0) + 1 })
      .eq("id", provider.id);

    console.log(`✅ Signal: ${action} ${asset} from ${providerId}`);
    res.json({ success: true, signal });
  } catch (err) {
    logError("/webhook", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// PAYMENTS — ClickPesa Mobile Money
// ════════════════════════════════════════════

// 1. Initiate mobile money payment
app.post("/payments/mobile", verifyToken, rateLimit({ max: 10, windowMs: 60_000 }), async (req, res) => {
  try {
    const { phone, amount, currency, providerId, paymentType, orderId } = req.body;

    const response = await axios.post(
      `${CLICKPESA.baseUrl}/v3/vendor/initiate-push-payment`,
      {
        amount: amount.toString(),
        currency: currency || "TZS",
        phoneNumber: phone,
        orderId: orderId || `FXH-${Date.now()}`,
        paymentReason: `FinXhubra Signal Access - ${paymentType}`,
      },
      { headers: cpHeaders() }
    );

    const { data } = response;

    await supabase.from("payments").insert({
      user_id: req.user.id,
      provider_id: providerId || null,
      payment_type: paymentType,
      amount,
      transaction_id: data.referenceId || orderId,
      status: "pending",
    });

    res.json({
      success: true,
      message: "Payment initiated — check your phone for prompt",
      referenceId: data.referenceId,
      status: data.status,
    });
  } catch (err) {
    logError("/payments/mobile", err, { response: err.response?.data });
    res.status(500).json({
      error: "Payment initiation failed",
      details: err.response?.data?.message || err.message,
    });
  }
});

// 2. Check payment status
app.get("/payments/status/:referenceId", verifyToken, async (req, res) => {
  try {
    const { referenceId } = req.params;

    const response = await axios.get(
      `${CLICKPESA.baseUrl}/v3/vendor/get-payment-status/${referenceId}`,
      { headers: cpHeaders() }
    );

    const { data } = response;
    const isSuccess = data.status === "SUCCESSFUL" || data.status === "SUCCESS";

    if (isSuccess) {
      // Fetch pending payment to get type info
      const { data: payment } = await supabase
        .from("payments")
        .select("payment_type")
        .eq("transaction_id", referenceId)
        .single();

      await supabase
        .from("payments")
        .update({ status: "active", expires_at: getExpiryDate(payment?.payment_type || "daily") })
        .eq("transaction_id", referenceId);
    }

    res.json({ success: true, status: data.status, isSuccess });
  } catch (err) {
    logError("/payments/status", err);
    res.status(500).json({ error: err.message });
  }
});

// 3. ClickPesa webhook — HMAC verified (item 2 / security)
app.post("/payments/clickpesa-webhook", async (req, res) => {
  try {
    // Verify ClickPesa signature if webhook secret is configured
    if (CLICKPESA.webhookSecret) {
      const signature = req.headers["x-clickpesa-signature"] || req.headers["x-signature"] || "";
      const expectedSig = crypto
        .createHmac("sha256", CLICKPESA.webhookSecret)
        .update(JSON.stringify(req.body))
        .digest("hex");

      if (signature !== expectedSig) {
        console.warn("⚠️  ClickPesa webhook signature mismatch — rejected");
        return res.status(401).json({ error: "Invalid webhook signature" });
      }
    }

    const { referenceId, status, amount, phoneNumber } = req.body;
    console.log(`💳 ClickPesa webhook: ${status} - ${referenceId}`);

    if (status === "SUCCESSFUL" || status === "SUCCESS") {
      const { data: payment } = await supabase
        .from("payments")
        .select("payment_type")
        .eq("transaction_id", referenceId)
        .single();

      await supabase
        .from("payments")
        .update({ status: "active", expires_at: getExpiryDate(payment?.payment_type || "daily") })
        .eq("transaction_id", referenceId);

      console.log(`✅ Payment confirmed: ${referenceId}`);
    }

    res.json({ received: true });
  } catch (err) {
    logError("/payments/clickpesa-webhook", err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Manual verify (fallback / admin)
app.post("/payments/verify", verifyToken, async (req, res) => {
  try {
    const { providerId, paymentType, amount, transactionId } = req.body;
    const expiresAt = getExpiryDate(paymentType);

    const { data, error } = await supabase
      .from("payments")
      .insert({
        user_id: req.user.id,
        provider_id: providerId,
        payment_type: paymentType,
        amount,
        transaction_id: transactionId || `FXH-${Date.now()}`,
        status: "active",
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, payment: data });
  } catch (err) {
    logError("/payments/verify", err);
    res.status(500).json({ error: err.message });
  }
});

// 5. Check access
app.get("/payments/check/:providerId", verifyToken, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const { data } = await supabase
      .from("payments")
      .select("*")
      .eq("user_id", req.user.id)
      .eq("provider_id", req.params.providerId)
      .eq("status", "active")
      .gt("expires_at", now);

    res.json({ success: true, hasAccess: data?.length > 0, payment: data?.[0] || null });
  } catch (err) {
    logError("/payments/check", err);
    res.status(500).json({ error: err.message });
  }
});

// 6. List own payment history
app.get("/payments/history", verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("*, providers(name, avatar_url)")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, payments: data });
  } catch (err) {
    logError("/payments/history", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// WALLET (item 5 — pay with wallet balance)
// ════════════════════════════════════════════

// Deposit to wallet
app.post("/wallet/deposit", verifyToken, async (req, res) => {
  try {
    const { amount, phone, currency } = req.body;
    if (!amount || !phone) return res.status(400).json({ error: "amount and phone required" });

    // Initiate mobile money to load wallet
    const orderId = `WALLET-${Date.now()}`;
    const response = await axios.post(
      `${CLICKPESA.baseUrl}/v3/vendor/initiate-push-payment`,
      {
        amount: amount.toString(),
        currency: currency || "TZS",
        phoneNumber: phone,
        orderId,
        paymentReason: "FinXhubra Wallet Top-up",
      },
      { headers: cpHeaders() }
    );

    // Log pending wallet deposit
    await supabase.from("wallet_transactions").insert({
      user_id: req.user.id,
      type: "deposit",
      amount,
      reference_id: response.data.referenceId || orderId,
      status: "pending",
    });

    res.json({
      success: true,
      message: "Check your phone for payment prompt",
      referenceId: response.data.referenceId,
    });
  } catch (err) {
    logError("/wallet/deposit", err, { response: err.response?.data });
    res.status(500).json({ error: "Wallet deposit failed", details: err.response?.data?.message || err.message });
  }
});

// Get wallet balance
app.get("/wallet/balance", verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("wallet_balance")
      .eq("id", req.user.id)
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, balance: data.wallet_balance || 0 });
  } catch (err) {
    logError("/wallet/balance", err);
    res.status(500).json({ error: err.message });
  }
});

// Pay for signal access using wallet balance (item 5)
app.post("/wallet/pay", verifyToken, async (req, res) => {
  try {
    const { providerId, paymentType } = req.body;
    if (!providerId || !paymentType)
      return res.status(400).json({ error: "providerId and paymentType required" });

    // Fetch provider pricing
    const { data: provider, error: pErr } = await supabase
      .from("providers")
      .select("id, name, daily_price, weekly_price, monthly_price, status")
      .eq("id", providerId)
      .single();

    if (pErr || !provider) return res.status(404).json({ error: "Provider not found" });
    if (provider.status !== "active") return res.status(400).json({ error: "Provider is not active" });

    const priceMap = { daily: provider.daily_price, weekly: provider.weekly_price, monthly: provider.monthly_price };
    const price = priceMap[paymentType];
    if (price === undefined) return res.status(400).json({ error: "Invalid paymentType" });

    // Fetch user wallet balance
    const { data: profile } = await supabase
      .from("profiles")
      .select("wallet_balance")
      .eq("id", req.user.id)
      .single();

    const balance = profile?.wallet_balance || 0;
    if (balance < price) {
      return res.status(402).json({
        error: "Insufficient wallet balance",
        required: price,
        available: balance,
      });
    }

    // Deduct balance and create payment — use a DB transaction-style approach
    const newBalance = balance - price;

    const [updateResult, paymentResult] = await Promise.all([
      supabase.from("profiles").update({ wallet_balance: newBalance }).eq("id", req.user.id),
      supabase.from("payments").insert({
        user_id: req.user.id,
        provider_id: providerId,
        payment_type: paymentType,
        amount: price,
        transaction_id: `WALLET-${Date.now()}`,
        status: "active",
        expires_at: getExpiryDate(paymentType),
      }).select().single(),
    ]);

    if (updateResult.error || paymentResult.error) {
      // Attempt to roll back balance change
      await supabase.from("profiles").update({ wallet_balance: balance }).eq("id", req.user.id);
      return res.status(500).json({ error: "Payment failed — balance restored" });
    }

    // Log wallet deduction
    await supabase.from("wallet_transactions").insert({
      user_id: req.user.id,
      type: "payment",
      amount: -price,
      reference_id: paymentResult.data.transaction_id,
      status: "completed",
      description: `${paymentType} access to ${provider.name}`,
    });

    res.json({
      success: true,
      message: `${paymentType} access to ${provider.name} activated`,
      newBalance,
      payment: paymentResult.data,
    });
  } catch (err) {
    logError("/wallet/pay", err);
    res.status(500).json({ error: err.message });
  }
});

// Wallet transaction history
app.get("/wallet/transactions", verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("wallet_transactions")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, transactions: data });
  } catch (err) {
    logError("/wallet/transactions", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// ANNOUNCEMENTS
// ════════════════════════════════════════════
app.get("/announcements", async (req, res) => {
  try {
    const { data } = await supabase
      .from("announcements")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: false });

    res.json({ success: true, announcements: data || [] });
  } catch (err) {
    logError("/announcements", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════
// ADMIN ROUTES (item 7)
// ════════════════════════════════════════════

// Stats dashboard
app.get("/admin/stats", verifyAdmin, async (req, res) => {
  try {
    const [users, providers, payments, pendingProviders] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact" }),
      supabase.from("providers").select("id", { count: "exact" }).eq("status", "active"),
      supabase.from("payments").select("amount, status, created_at"),
      supabase.from("providers").select("id", { count: "exact" }).eq("status", "pending"),
    ]);

    const totalRevenue = payments.data?.reduce((s, p) => s + (p.amount || 0), 0) || 0;
    const activeSubscriptions = payments.data?.filter(p => p.status === "active").length || 0;

    res.json({
      success: true,
      stats: {
        totalUsers: users.count || 0,
        totalProviders: providers.count || 0,
        pendingProviders: pendingProviders.count || 0,
        totalRevenue,
        activeSubscriptions,
      },
    });
  } catch (err) {
    logError("/admin/stats", err);
    res.status(500).json({ error: err.message });
  }
});

// List all users
app.get("/admin/users", verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("profiles")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (search) query = query.ilike("name", `%${search}%`);

    const { data, error, count } = await query;
    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, users: data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    logError("/admin/users", err);
    res.status(500).json({ error: err.message });
  }
});

// Suspend or reactivate a user
app.patch("/admin/users/:id/status", verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body; // "active" | "suspended"
    if (!["active", "suspended"].includes(status))
      return res.status(400).json({ error: "status must be 'active' or 'suspended'" });

    const { data, error } = await supabase
      .from("profiles")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, user: data });
  } catch (err) {
    logError("/admin/users/:id/status", err);
    res.status(500).json({ error: err.message });
  }
});

// List all payments
app.get("/admin/payments", verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("payments")
      .select("*, profiles(name, email), providers(name)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (status) query = query.eq("status", status);

    const { data, error, count } = await query;
    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, payments: data, total: count });
  } catch (err) {
    logError("/admin/payments", err);
    res.status(500).json({ error: err.message });
  }
});

// Approve or reject a provider
app.patch("/admin/providers/:id/status", verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body; // "active" | "suspended" | "rejected"
    const { data, error } = await supabase
      .from("providers")
      .update({ status })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, provider: data });
  } catch (err) {
    logError("/admin/providers/:id/status", err);
    res.status(500).json({ error: err.message });
  }
});

// List all providers (including pending)
app.get("/admin/providers", verifyAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase
      .from("providers")
      .select("*, profiles(name, email)")
      .order("created_at", { ascending: false });

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, providers: data });
  } catch (err) {
    logError("/admin/providers", err);
    res.status(500).json({ error: err.message });
  }
});

// Create announcement
app.post("/admin/announcements", verifyAdmin, async (req, res) => {
  try {
    const { title, body, type } = req.body;
    if (!title || !body) return res.status(400).json({ error: "title and body required" });

    const { data, error } = await supabase
      .from("announcements")
      .insert({ title, body, type: type || "info", active: true })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, announcement: data });
  } catch (err) {
    logError("/admin/announcements", err);
    res.status(500).json({ error: err.message });
  }
});

// View error logs
app.get("/admin/error-logs", verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("error_logs")
      .select("*")
      .order("time", { ascending: false })
      .limit(100);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, logs: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 FinXhubra Backend on port ${PORT}`);
  console.log(`💳 ClickPesa: ${CLICKPESA.baseUrl}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL}`);
});
