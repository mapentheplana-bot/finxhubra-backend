const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── HEALTH CHECK ──
app.get("/", (req, res) => {
  res.json({ status: "FinXhubra Backend Running ✅", time: new Date() });
});

// ── AUTH ROUTES ──
app.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: "Email, password and name required" });
    }
    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (authError) return res.status(400).json({ error: authError.message });

    // Create profile
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: authData.user.id,
        name,
        email,
        role: role || "trader",
        is_admin: email.toLowerCase().includes("admin"),
      })
      .select()
      .single();

    if (profileError) return res.status(400).json({ error: profileError.message });

    res.json({ success: true, user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: "Invalid email or password" });

    // Get profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

    res.json({
      success: true,
      token: data.session.access_token,
      user: profile,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROVIDERS ROUTES ──
app.get("/providers", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("providers")
      .select("*")
      .eq("status", "active")
      .order("id", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, providers: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/providers/register", async (req, res) => {
  try {
    const {
      user_id, name, bio, strategy, risk_level,
      assets, price_per_day
    } = req.body;

    // Generate provider credentials
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const secret = Array.from({ length: 12 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
    const providerId = Math.floor(10000 + Math.random() * 90000).toString();
    const webhookUrl = `https://finxhubra-backend.up.railway.app/webhook/${providerId}`;

    const { data, error } = await supabase
      .from("providers")
      .insert({
        user_id, name, bio, strategy, risk_level,
        assets, price_per_day,
        provider_id: providerId,
        secret_key: secret,
        webhook_url: webhookUrl,
        status: "pending",
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, provider: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SIGNALS ROUTES ──
app.get("/signals/:providerId", async (req, res) => {
  try {
    const { providerId } = req.params;
    const { data, error } = await supabase
      .from("signals")
      .select("*")
      .eq("provider_id", providerId)
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
    const { providerId } = req.params;
    const { asset, action, entry, stop_loss, take_profit, timestamp, secret } = req.body;

    // Validate provider and secret
    const { data: provider, error: pError } = await supabase
      .from("providers")
      .select("*")
      .eq("provider_id", providerId)
      .single();

    if (pError || !provider) {
      return res.status(404).json({ error: "Provider not found" });
    }

    if (provider.secret_key !== secret) {
      return res.status(401).json({ error: "Invalid secret key — unauthorized" });
    }

    // Save signal
    const { data: signal, error: sError } = await supabase
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

    if (sError) return res.status(400).json({ error: sError.message });

    console.log(`✅ Signal received: ${action} ${asset} from provider ${providerId}`);
    res.json({ success: true, signal, message: "Signal received and saved" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PAYMENTS ROUTES ──
app.post("/payments/verify", async (req, res) => {
  try {
    const { user_id, provider_id, payment_type, amount, transaction_id } = req.body;

    // Calculate expiry
    const durations = { daily: 1, weekly: 7, monthly: 30 };
    const days = durations[payment_type] || 1;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    const { data, error } = await supabase
      .from("payments")
      .insert({
        user_id, provider_id, payment_type, amount,
        transaction_id, status: "active",
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, payment: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/payments/check/:userId/:providerId", async (req, res) => {
  try {
    const { userId, providerId } = req.params;
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("user_id", userId)
      .eq("provider_id", providerId)
      .eq("status", "active")
      .gt("expires_at", now);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, hasAccess: data.length > 0, payment: data[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ANNOUNCEMENTS ──
app.get("/announcements", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("announcements")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, announcements: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WALLET ──
app.post("/wallet/deposit", async (req, res) => {
  try {
    const { user_id, amount } = req.body;
    const { data: profile } = await supabase
      .from("profiles")
      .select("wallet_balance")
      .eq("id", user_id)
      .single();

    const newBalance = (profile?.wallet_balance || 0) + amount;

    const { data, error } = await supabase
      .from("profiles")
      .update({ wallet_balance: newBalance })
      .eq("id", user_id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, new_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ──
app.get("/admin/stats", async (req, res) => {
  try {
    const [users, providers, payments, signals] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact" }),
      supabase.from("providers").select("id", { count: "exact" }),
      supabase.from("payments").select("amount"),
      supabase.from("signals").select("id", { count: "exact" }),
    ]);

    const totalRevenue = payments.data?.reduce((s, p) => s + (p.amount || 0), 0) || 0;

    res.json({
      success: true,
      stats: {
        total_users: users.count || 0,
        total_providers: providers.count || 0,
        total_revenue: totalRevenue,
        total_signals: signals.count || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/admin/providers/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const { data, error } = await supabase
      .from("providers")
      .update({ status })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, provider: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START SERVER ──
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 FinXhubra Backend running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: /webhook/:providerId`);
  console.log(`🔐 Auth endpoints: /auth/signup, /auth/login`);
});
