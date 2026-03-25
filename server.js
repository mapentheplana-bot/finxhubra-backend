const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const rateLimit = require("express-rate-limit");

const app = express();

// ── FIX #9: Restrict CORS to your frontend domain only ──
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  methods: ["GET", "POST", "PATCH"],
}));

app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ClickPesa config
const CLICKPESA = {
  clientId: process.env.CLICKPESA_CLIENT_ID,
  apiKey: process.env.CLICKPESA_API_KEY,
  baseUrl: process.env.CLICKPESA_BASE_URL || "https://api.clickpesa.com",
};

// ── FIX #10: Rate limiting on auth and payment routes ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many requests, please try again later." },
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Too many payment requests, please try again later." },
});

// ── FIX #1: Authentication middleware ──
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = user;
  next();
};

// Helper — ClickPesa headers
const cpHeaders = () => ({
  "api-key": CLICKPESA.apiKey,
  "client-id": CLICKPESA.clientId,
  "Content-Type": "application/json",
});

// Helper — expiry date
function getExpiryDate(type) {
  const d = new Date();
  const days = { daily: 1, weekly: 7, monthly: 30 };
  d.setDate(d.getDate() + (days[type] || 1));
  return d.toISOString();
}

// ── HEALTH CHECK ──
app.get("/", (req, res) => {
  res.json({
    status: "FinXhubra Backend Running ✅",
    time: new Date(),
    payments: "ClickPesa Connected 💳",
    database: "Supabase Connected 🗄️",
  });
});

// ══════════════════════════════════════
// ── AUTH ROUTES ──
// ══════════════════════════════════════

app.post("/auth/signup", authLimiter, async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name)
      return res.status(400).json({ error: "Email, password and name required" });

    // ── FIX #5: Validate role to prevent privilege escalation ──
    const allowedRoles = ["trader", "provider"];
    const safeRole = allowedRoles.includes(role) ? role : "trader";

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, role: safeRole },
    });

    if (authError) return res.status(400).json({ error: authError.message });

    res.json({ success: true, user: { id: authData.user.id, email, name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ error: "Invalid email or password" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

    res.json({ success: true, token: data.session.access_token, user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROVIDERS ──
app.get("/providers", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("providers")
      .select("*")
      .eq("status", "active");

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, providers: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SIGNALS ──
app.get("/signals/:providerId", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .eq("provider_id", req.params.providerId)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, signals: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TRADINGVIEW WEBHOOK ──
app.post("/webhook/:providerId", async (req, res) => {
  try {
    const { asset, action, entry, stop_loss, take_profit, secret } = req.body;
    const { providerId } = req.params;

    // ── FIX #8: Query by the correct slug/external column ──
    // "provider_id" is the external slug; change to "id" if yours is UUID-based
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

    console.log(`✅ Signal: ${action} ${asset} from ${providerId}`);
    res.json({ success: true, signal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
// ── CLICKPESA PAYMENTS ──
// ══════════════════════════════════════

// 1. Initiate Mobile Money payment
app.post("/payments/mobile", authenticate, paymentLimiter, async (req, res) => {
  try {
    const { phone, amount, currency, userId, providerId, paymentType, orderId } = req.body;

    if (!phone || !amount || !userId || !paymentType)
      return res.status(400).json({ error: "phone, amount, userId and paymentType are required" });

    // ── FIX #2: Validate amount ──
    if (typeof amount !== "number" || amount <= 0)
      return res.status(400).json({ error: "amount must be a positive number" });

    const generatedOrderId = orderId || `FXH-${Date.now()}`;

    const response = await axios.post(
      `${CLICKPESA.baseUrl}/v3/vendor/initiate-push-payment`,
      {
        amount: amount.toString(),
        currency: currency || "TZS",
        phoneNumber: phone,
        orderId: generatedOrderId,
        paymentReason: `FinXhubra Signal Access - ${paymentType}`,
      },
      { headers: cpHeaders() }
    );

    const { data } = response;

    // ── FIX #3: Save currency to DB ──
    await supabase.from("payments").insert({
      user_id: userId,
      provider_id: providerId || null,
      payment_type: paymentType,
      amount,
      currency: currency || "TZS",
      transaction_id: data.referenceId || generatedOrderId,
      status: "pending",
    });

    res.json({
      success: true,
      message: "Payment initiated — check your phone for prompt",
      referenceId: data.referenceId,
      status: data.status,
    });
  } catch (err) {
    console.error("ClickPesa error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Payment initiation failed",
      details: err.response?.data?.message || err.message,
    });
  }
});

// 2. Check payment status
app.get("/payments/status/:referenceId", authenticate, async (req, res) => {
  try {
    const { referenceId } = req.params;

    const response = await axios.get(
      `${CLICKPESA.baseUrl}/v3/vendor/get-payment-status/${referenceId}`,
      { headers: cpHeaders() }
    );

    const { data } = response;
    const isSuccess = data.status === "SUCCESSFUL" || data.status === "SUCCESS";

    if (isSuccess) {
      await supabase
        .from("payments")
        .update({ status: "active", expires_at: getExpiryDate("daily") })
        .eq("transaction_id", referenceId);
    }

    res.json({ success: true, status: data.status, isSuccess });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. ClickPesa webhook — receives payment confirmation
// ── FIX #4: Verify webhook secret to prevent fake confirmations ──
app.post("/payments/clickpesa-webhook", async (req, res) => {
  try {
    const incomingSecret = req.headers["x-clickpesa-secret"];
    if (
      process.env.CLICKPESA_WEBHOOK_SECRET &&
      incomingSecret !== process.env.CLICKPESA_WEBHOOK_SECRET
    ) {
      console.warn("⚠️ Webhook rejected — invalid secret");
      return res.status(401).json({ error: "Unauthorized webhook" });
    }

    const { referenceId, status } = req.body;
    console.log(`💳 ClickPesa webhook: ${status} - ${referenceId}`);

    if (status === "SUCCESSFUL" || status === "SUCCESS") {
      await supabase
        .from("payments")
        .update({ status: "active", expires_at: getExpiryDate("daily") })
        .eq("transaction_id", referenceId);

      console.log(`✅ Payment confirmed: ${referenceId}`);
    }

    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Verify payment manually — ADMIN ONLY
// ── FIX #6: Protect this endpoint so only admins can manually verify ──
app.post("/payments/verify", authenticate, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", req.user.id)
      .single();

    if (!profile || profile.role !== "admin")
      return res.status(403).json({ error: "Admin access required" });

    const { userId, providerId, paymentType, amount, transactionId } = req.body;

    if (!userId || !paymentType || !amount)
      return res.status(400).json({ error: "userId, paymentType and amount are required" });

    const expiresAt = getExpiryDate(paymentType);

    const { data, error } = await supabase
      .from("payments")
      .insert({
        user_id: userId,
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
    res.status(500).json({ error: err.message });
  }
});

// 5. Check access
app.get("/payments/check/:userId/:providerId", authenticate, async (req, res) => {
  try {
    const { userId, providerId } = req.params;
    const now = new Date().toISOString();

    const { data } = await supabase
      .from("payments")
      .select("*")
      .eq("user_id", userId)
      .eq("provider_id", providerId)
      .eq("status", "active")
      .gt("expires_at", now);

    res.json({ success: true, hasAccess: data?.length > 0, payment: data?.[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WALLET ──
app.post("/wallet/deposit", authenticate, async (req, res) => {
  try {
    const { userId, amount } = req.body;

    // ── FIX #2: Validate amount is a positive number ──
    if (!userId || typeof amount !== "number" || amount <= 0)
      return res.status(400).json({ error: "Valid userId and a positive amount are required" });

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("wallet_balance")
      .eq("id", userId)
      .single();

    if (profileError || !profile)
      return res.status(404).json({ error: "User profile not found" });

    const newBalance = (profile.wallet_balance || 0) + amount;

    await supabase.from("profiles").update({ wallet_balance: newBalance }).eq("id", userId);

    res.json({ success: true, newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ANNOUNCEMENTS ──
app.get("/announcements", async (req, res) => {
  try {
    const { data } = await supabase
      .from("announcements")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: false });

    res.json({ success: true, announcements: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ──
// ── FIX #7: Correct Supabase count query using head: true ──
app.get("/admin/stats", authenticate, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", req.user.id)
      .single();

    if (!profile || profile.role !== "admin")
      return res.status(403).json({ error: "Admin access required" });

    const [users, providers, payments] = await Promise.all([
      supabase.from("profiles").select("*", { count: "exact", head: true }),
      supabase.from("providers").select("*", { count: "exact", head: true }),
      supabase.from("payments").select("amount"),
    ]);

    const totalRevenue = payments.data?.reduce((s, p) => s + (p.amount || 0), 0) || 0;

    res.json({
      success: true,
      stats: {
        totalUsers: users.count || 0,
        totalProviders: providers.count || 0,
        totalRevenue,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/admin/providers/:id/status", authenticate, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", req.user.id)
      .single();

    if (!profile || profile.role !== "admin")
      return res.status(403).json({ error: "Admin access required" });

    const allowedStatuses = ["active", "inactive", "suspended"];
    if (!allowedStatuses.includes(req.body.status))
      return res.status(400).json({ error: "Invalid status value" });

    const { data, error } = await supabase
      .from("providers")
      .update({ status: req.body.status })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, provider: data });
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
