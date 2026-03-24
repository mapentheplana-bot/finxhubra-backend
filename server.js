const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ── JWT MIDDLEWARE ──
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }
    const token = authHeader.split(" ")[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid or expired token" });
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: "Authentication failed" });
  }
};

const requireAdmin = async (req, res, next) => {
  const { data: profile } = await supabase
    .from("profiles").select("role").eq("id", req.user.id).single();
  if (profile?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};
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

// ── HEALTH CHECK ──
app.get("/", (req, res) => {
  res.json({ 
    status: "FinXhubra Backend Running ✅", 
    time: new Date(),
    payments: "ClickPesa Connected 💳",
    database: "Supabase Connected 🗄️"
  });
});

// ── AUTH ROUTES ──
app.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: "Email, password and name required" });

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { name, role: role || "trader" }
    });
    if (authError) return res.status(400).json({ error: authError.message });

    res.json({ success: true, user: { id: authData.user.id, email, name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: "Invalid email or password" });

    const { data: profile } = await supabase
      .from("profiles").select("*").eq("id", data.user.id).single();

    res.json({ success: true, token: data.session.access_token, user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROVIDERS ──
app.get("/providers", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("providers").select("*").eq("status", "active");
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
      .from("signals").select("*").eq("provider_id", req.params.providerId)
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

    const { data: provider } = await supabase
      .from("providers").select("*").eq("provider_id", providerId).single();

    if (!provider) return res.status(404).json({ error: "Provider not found" });
    if (provider.secret_key !== secret)
      return res.status(401).json({ error: "Invalid secret — unauthorized" });

    const { data: signal, error } = await supabase.from("signals").insert({
      provider_id: provider.id, asset, direction: action,
      entry_price: entry, stop_loss, take_profit,
      status: "ACTIVE", source: "tradingview", executed: false,
    }).select().single();

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

// Helper — ClickPesa headers
const cpHeaders = () => ({
  "api-key": CLICKPESA.apiKey,
  "client-id": CLICKPESA.clientId,
  "Content-Type": "application/json",
});

// 1. Initiate M-Pesa / Airtel / Mobile Money payment
app.post("/payments/mobile", async (req, res) => {
  try {
    const { phone, amount, currency, userId, providerId, paymentType, orderId } = req.body;

    // Create payment request to ClickPesa
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

    // Save pending payment to database
    await supabase.from("payments").insert({
      user_id: userId,
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
    console.error("ClickPesa error:", err.response?.data || err.message);
    res.status(500).json({ 
      error: "Payment initiation failed",
      details: err.response?.data?.message || err.message 
    });
  }
});

// 2. Check payment status
app.get("/payments/status/:referenceId", async (req, res) => {
  try {
    const { referenceId } = req.params;

    const response = await axios.get(
      `${CLICKPESA.baseUrl}/v3/vendor/get-payment-status/${referenceId}`,
      { headers: cpHeaders() }
    );

    const { data } = response;
    const isSuccess = data.status === "SUCCESSFUL" || data.status === "SUCCESS";

    // Update payment in database if successful
    if (isSuccess) {
      await supabase.from("payments")
        .update({ status: "active", expires_at: getExpiryDate("daily") })
        .eq("transaction_id", referenceId);
    }

    res.json({ success: true, status: data.status, isSuccess });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. ClickPesa webhook — receives payment confirmation
app.post("/payments/clickpesa-webhook", async (req, res) => {
  try {
    const { referenceId, status, amount, phoneNumber } = req.body;
    console.log(`💳 ClickPesa webhook: ${status} - ${referenceId}`);

    if (status === "SUCCESSFUL" || status === "SUCCESS") {
      // Update payment status in database
      await supabase.from("payments")
        .update({ status: "active", expires_at: getExpiryDate("daily") })
        .eq("transaction_id", referenceId);

      console.log(`✅ Payment confirmed: ${referenceId}`);
    }

    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Verify payment manually (fallback)
app.post("/payments/verify", async (req, res) => {
  try {
    const { userId, providerId, paymentType, amount, transactionId } = req.body;
    const expiresAt = getExpiryDate(paymentType);

    const { data, error } = await supabase.from("payments").insert({
      user_id: userId, provider_id: providerId,
      payment_type: paymentType, amount,
      transaction_id: transactionId || `FXH-${Date.now()}`,
      status: "active", expires_at: expiresAt,
    }).select().single();

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

    const { data } = await supabase.from("payments").select("*")
      .eq("user_id", userId).eq("provider_id", providerId)
      .eq("status", "active").gt("expires_at", now);

    res.json({ success: true, hasAccess: data?.length > 0, payment: data?.[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WALLET ──
app.post("/wallet/deposit", async (req, res) => {
  try {
    const { userId, amount } = req.body;
    const { data: profile } = await supabase
      .from("profiles").select("wallet_balance").eq("id", userId).single();

    const newBalance = (profile?.wallet_balance || 0) + amount;
    await supabase.from("profiles").update({ wallet_balance: newBalance }).eq("id", userId);

    res.json({ success: true, newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ANNOUNCEMENTS ──
app.get("/announcements", async (req, res) => {
  try {
    const { data } = await supabase.from("announcements")
      .select("*").eq("active", true).order("created_at", { ascending: false });
    res.json({ success: true, announcements: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ──
app.get("/admin/stats", authenticate, requireAdmin, async (req, res) => {
  try {
    const [users, providers, payments] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact" }),
      supabase.from("providers").select("id", { count: "exact" }),
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

app.patch("/admin/providers/:id/status", authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from("providers")
      .update({ status: req.body.status }).eq("id", req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, provider: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HELPER ──
function getExpiryDate(type) {
  const d = new Date();
  const days = { daily: 1, weekly: 7, monthly: 30 };
  d.setDate(d.getDate() + (days[type] || 1));
  return d.toISOString();
}

// ── START ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 FinXhubra Backend on port ${PORT}`);
  console.log(`💳 ClickPesa: ${CLICKPESA.baseUrl}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL}`);
});
