const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ── SUPABASE ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CLICKPESA ──
const CP = {
  clientId: process.env.CLICKPESA_CLIENT_ID,
  apiKey: process.env.CLICKPESA_API_KEY,
  baseUrl: process.env.CLICKPESA_BASE_URL || "https://api.clickpesa.com",
};
const cpHeaders = () => ({
  "api-key": CP.apiKey,
  "client-id": CP.clientId,
  "Content-Type": "application/json",
});

// ── COMMISSION ──
const PLATFORM_CUT = 0.30; // 30%
const PROVIDER_CUT = 0.70; // 70%

// ── FOREX PRICING (5 trading days/week, 21/month) ──
const EXPIRY_DAYS = { daily: 1, weekly: 5, monthly: 21 };

function getExpiryDate(type) {
  const d = new Date();
  d.setDate(d.getDate() + (EXPIRY_DAYS[type] || 1));
  return d.toISOString();
}

// ════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    status: "FinXhubra Backend Running ✅",
    time: new Date(),
    payments: "ClickPesa Connected 💳",
    database: "Supabase Connected 🗄️",
    version: "2.0.0"
  });
});

// ════════════════════════════════════════
// AUTH
// ════════════════════════════════════════
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

    // Create profile manually (backup in case trigger fails)
    await supabase.from("profiles").upsert({
      id: authData.user.id,
      name, email,
      role: role || "trader",
      is_admin: email.toLowerCase().includes("admin"),
      wallet_balance: 0,
    }, { onConflict: "id" });

    res.json({ success: true, user: { id: authData.user.id, email, name, role } });
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

// ════════════════════════════════════════
// PROVIDERS
// ════════════════════════════════════════
app.get("/providers", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("providers").select("*").eq("status", "active")
      .order("win_rate", { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, providers: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/providers/register", async (req, res) => {
  try {
    const { user_id, name, bio, strategy, risk_level, assets, price_per_day } = req.body;

    // Validate pricing
    if (price_per_day < 1) return res.status(400).json({ error: "Minimum price is $1/day" });

    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const secret = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const providerId = Math.floor(10000 + Math.random() * 90000).toString();
    const webhookUrl = `${process.env.BACKEND_URL || "https://finxhubra-backend-production.up.railway.app"}/webhook/${providerId}`;

    const { data, error } = await supabase.from("providers").insert({
      user_id, name, bio, strategy, risk_level, assets, price_per_day,
      provider_id: providerId, secret_key: secret, webhook_url: webhookUrl,
      status: "pending", win_rate: 0, total_trades: 0,
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, provider: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Provider analytics (real data)
app.get("/providers/:id/analytics", async (req, res) => {
  try {
    const { id } = req.params;

    const [signals, payments, provider] = await Promise.all([
      supabase.from("signals").select("*").eq("provider_id", id),
      supabase.from("payments").select("*").eq("provider_id", id).eq("status", "active"),
      supabase.from("providers").select("*").eq("id", id).single(),
    ]);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const allPayments = payments.data || [];
    const totalRevenue = allPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const providerEarnings = totalRevenue * PROVIDER_CUT;

    const todayPayments = allPayments.filter(p => p.created_at >= todayStart);
    const weekPayments = allPayments.filter(p => p.created_at >= weekStart);
    const monthPayments = allPayments.filter(p => p.created_at >= monthStart);

    // Win rate calculation
    const completed = (signals.data || []).filter(s => s.status === "WIN" || s.status === "LOSS");
    const wins = completed.filter(s => s.status === "WIN").length;
    const winRate = completed.length > 0 ? Math.round((wins / completed.length) * 100) : 0;

    res.json({
      success: true,
      analytics: {
        totalSignals: signals.data?.length || 0,
        signalsSold: allPayments.length,
        totalSubscribers: allPayments.length,
        weeklySubs: weekPayments.filter(p => p.payment_type === "weekly").length,
        monthlySubs: monthPayments.filter(p => p.payment_type === "monthly").length,
        winRate,
        totalTrades: completed.length,
        wins, losses: completed.length - wins,
        earnings: {
          today: todayPayments.reduce((s, p) => s + p.amount * PROVIDER_CUT, 0).toFixed(2),
          weekly: weekPayments.reduce((s, p) => s + p.amount * PROVIDER_CUT, 0).toFixed(2),
          monthly: monthPayments.reduce((s, p) => s + p.amount * PROVIDER_CUT, 0).toFixed(2),
          lifetime: providerEarnings.toFixed(2),
        },
        recentSubscribers: allPayments.slice(0, 10),
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// SIGNALS
// ════════════════════════════════════════
app.get("/signals/:providerId", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("signals").select("*").eq("provider_id", req.params.providerId)
      .order("created_at", { ascending: false }).limit(50);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, signals: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update signal outcome (WIN/LOSS)
app.patch("/signals/:id/outcome", async (req, res) => {
  try {
    const { status } = req.body; // "WIN" or "LOSS"
    const { data, error } = await supabase.from("signals")
      .update({ status, executed: true })
      .eq("id", req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });

    // Update provider win rate
    if (data.provider_id) {
      const { data: signals } = await supabase.from("signals")
        .select("status").eq("provider_id", data.provider_id)
        .in("status", ["WIN", "LOSS"]);

      if (signals && signals.length >= 10) {
        const wins = signals.filter(s => s.status === "WIN").length;
        const winRate = Math.round((wins / signals.length) * 100);
        await supabase.from("providers")
          .update({ win_rate: winRate, total_trades: signals.length })
          .eq("id", data.provider_id);
      }
    }

    res.json({ success: true, signal: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// TRADINGVIEW WEBHOOK
// ════════════════════════════════════════
app.post("/webhook/:providerId", async (req, res) => {
  try {
    const { asset, action, entry, stop_loss, take_profit, secret, comment } = req.body;
    const { providerId } = req.params;

    const { data: provider } = await supabase
      .from("providers").select("*").eq("provider_id", providerId).single();

    if (!provider) return res.status(404).json({ error: "Provider not found" });
    if (provider.secret_key !== secret)
      return res.status(401).json({ error: "Invalid secret — unauthorized" });

    const { data: signal, error } = await supabase.from("signals").insert({
      provider_id: provider.id, asset, direction: action,
      entry_price: entry, stop_loss, take_profit,
      comment: comment || null,
      status: "ACTIVE", source: "tradingview", executed: false,
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });

    // Notify subscribers
    await notifySubscribers(provider.id, {
      title: `📡 New Signal: ${action} ${asset}`,
      body: `Entry: ${entry} | SL: ${stop_loss} | TP: ${take_profit}`,
      type: "signal",
    });

    console.log(`✅ Signal: ${action} ${asset} from ${providerId}`);
    res.json({ success: true, signal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// PAYMENTS (CLICKPESA)
// ════════════════════════════════════════
app.post("/payments/mobile", async (req, res) => {
  try {
    const { phone, amount, currency, userId, providerId, paymentType, orderId } = req.body;

    const response = await axios.post(
      `${CP.baseUrl}/v3/vendor/initiate-push-payment`,
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
      user_id: userId, provider_id: providerId || null,
      payment_type: paymentType, amount,
      transaction_id: data.referenceId || orderId,
      status: "pending",
    });

    res.json({
      success: true,
      message: "Payment initiated — check your phone",
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

app.get("/payments/status/:referenceId", async (req, res) => {
  try {
    const { referenceId } = req.params;
    const response = await axios.get(
      `${CP.baseUrl}/v3/vendor/get-payment-status/${referenceId}`,
      { headers: cpHeaders() }
    );
    const { data } = response;
    const isSuccess = data.status === "SUCCESSFUL" || data.status === "SUCCESS";

    if (isSuccess) {
      const { data: payment } = await supabase.from("payments")
        .update({ status: "active", expires_at: getExpiryDate("daily") })
        .eq("transaction_id", referenceId).select().single();

      // Notify user
      if (payment?.user_id) {
        await createNotification(payment.user_id, {
          title: "✅ Payment Successful!",
          body: "Your signal access has been activated.",
          type: "payment",
        });
      }
    }

    res.json({ success: true, status: data.status, isSuccess });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/payments/clickpesa-webhook", async (req, res) => {
  try {
    const { referenceId, status } = req.body;
    console.log(`💳 ClickPesa webhook: ${status} - ${referenceId}`);

    if (status === "SUCCESSFUL" || status === "SUCCESS") {
      const { data: payment } = await supabase.from("payments")
        .update({ status: "active", expires_at: getExpiryDate("daily") })
        .eq("transaction_id", referenceId).select().single();

      if (payment) {
        // Notify user
        if (payment.user_id) {
          await createNotification(payment.user_id, {
            title: "✅ Payment Confirmed!",
            body: "Your signal access is now active.",
            type: "payment",
          });
        }
        // Commission: notify provider of earnings
        if (payment.provider_id) {
          const { data: prov } = await supabase.from("providers")
            .select("user_id").eq("id", payment.provider_id).single();
          if (prov?.user_id) {
            await createNotification(prov.user_id, {
              title: "💰 New Subscriber!",
              body: `You earned $${(payment.amount * PROVIDER_CUT).toFixed(2)} from a new subscriber.`,
              type: "earning",
            });
          }
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/payments/verify", async (req, res) => {
  try {
    const { userId, providerId, paymentType, amount, transactionId } = req.body;
    const { data, error } = await supabase.from("payments").insert({
      user_id: userId, provider_id: providerId,
      payment_type: paymentType, amount,
      transaction_id: transactionId || `FXH-${Date.now()}`,
      status: "active", expires_at: getExpiryDate(paymentType),
    }).select().single();
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
    const { data } = await supabase.from("payments").select("*")
      .eq("user_id", userId).eq("provider_id", providerId)
      .eq("status", "active").gt("expires_at", now);
    res.json({ success: true, hasAccess: data?.length > 0, payment: data?.[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// WITHDRAWALS
// ════════════════════════════════════════
app.post("/withdrawals/request", async (req, res) => {
  try {
    const { providerId, amount, method, accountNumber } = req.body;
    if (amount < 10) return res.status(400).json({ error: "Minimum withdrawal is $10" });

    const { data, error } = await supabase.from("withdrawals").insert({
      provider_id: providerId, amount,
      provider_amount: amount * PROVIDER_CUT,
      method: method || "mobile_money",
      account_number: accountNumber,
      status: "pending",
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });

    // Notify admin
    await createAdminNotification({
      title: "💸 Withdrawal Request",
      body: `Provider requested $${amount}. Provider gets $${(amount * PROVIDER_CUT).toFixed(2)}.`,
    });

    res.json({ success: true, withdrawal: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/withdrawals/:providerId", async (req, res) => {
  try {
    const { data } = await supabase.from("withdrawals").select("*")
      .eq("provider_id", req.params.providerId)
      .order("created_at", { ascending: false });
    res.json({ success: true, withdrawals: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/withdrawals/:id/approve", async (req, res) => {
  try {
    const { data, error } = await supabase.from("withdrawals")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });

    // Notify provider
    if (data.provider_id) {
      const { data: prov } = await supabase.from("providers")
        .select("user_id").eq("id", data.provider_id).single();
      if (prov?.user_id) {
        await createNotification(prov.user_id, {
          title: "✅ Withdrawal Approved!",
          body: `Your withdrawal of $${data.provider_amount} has been processed.`,
          type: "withdrawal",
        });
      }
    }

    res.json({ success: true, withdrawal: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── NOTIFICATIONS ──
app.get("/notifications/:userId", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", req.params.userId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, notifications: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/notifications/:id/read", authenticate, async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("id", req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// WALLET
// ════════════════════════════════════════
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

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════
app.get("/notifications/:userId", async (req, res) => {
  try {
    const { data } = await supabase.from("notifications").select("*")
      .eq("user_id", req.params.userId)
      .order("created_at", { ascending: false }).limit(50);
    res.json({ success: true, notifications: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/notifications/:id/read", async (req, res) => {
  try {
    await supabase.from("notifications").update({ read: true }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/notifications/read-all/:userId", async (req, res) => {
  try {
    await supabase.from("notifications").update({ read: true }).eq("user_id", req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// ANNOUNCEMENTS
// ════════════════════════════════════════
app.get("/announcements", async (req, res) => {
  try {
    const { data } = await supabase.from("announcements")
      .select("*").eq("active", true).order("created_at", { ascending: false });
    res.json({ success: true, announcements: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/announcements", async (req, res) => {
  try {
    const { title, body, icon, target, is_sponsored } = req.body;
    const { data, error } = await supabase.from("announcements").insert({
      title, body, icon: icon || "📢",
      target: target || "all",
      is_sponsored: is_sponsored || false,
      active: true,
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, announcement: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/announcements/:id", async (req, res) => {
  try {
    await supabase.from("announcements").update({ active: false }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// ADMIN
// ════════════════════════════════════════
app.get("/admin/stats", async (req, res) => {
  try {
    const [users, providers, payments, signals] = await Promise.all([
      supabase.from("profiles").select("id, role", { count: "exact" }),
      supabase.from("providers").select("id, status", { count: "exact" }),
      supabase.from("payments").select("amount, created_at, payment_type"),
      supabase.from("signals").select("id, status", { count: "exact" }),
    ]);

    const allPayments = payments.data || [];
    const totalRevenue = allPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const platformRevenue = totalRevenue * PLATFORM_CUT;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    res.json({
      success: true,
      stats: {
        totalUsers: users.count || 0,
        traders: users.data?.filter(u => u.role === "trader").length || 0,
        providers: providers.count || 0,
        activeProviders: providers.data?.filter(p => p.status === "active").length || 0,
        pendingProviders: providers.data?.filter(p => p.status === "pending").length || 0,
        totalSignals: signals.count || 0,
        paidSignals: allPayments.length,
        revenue: {
          total: totalRevenue.toFixed(2),
          platform: platformRevenue.toFixed(2),
          today: allPayments.filter(p => p.created_at >= todayStart).reduce((s, p) => s + p.amount * PLATFORM_CUT, 0).toFixed(2),
          weekly: allPayments.filter(p => p.created_at >= weekStart).reduce((s, p) => s + p.amount * PLATFORM_CUT, 0).toFixed(2),
          monthly: allPayments.filter(p => p.created_at >= monthStart).reduce((s, p) => s + p.amount * PLATFORM_CUT, 0).toFixed(2),
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/users", async (req, res) => {
  try {
    const { data } = await supabase.from("profiles").select("*")
      .order("created_at", { ascending: false }).limit(100);
    res.json({ success: true, users: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/withdrawals", async (req, res) => {
  try {
    const { data } = await supabase.from("withdrawals").select("*, providers(name)")
      .eq("status", "pending").order("created_at", { ascending: false });
    res.json({ success: true, withdrawals: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/withdraw-company", async (req, res) => {
  try {
    const { amount, method, accountNumber, adminId } = req.body;
    const { data, error } = await supabase.from("company_withdrawals").insert({
      amount, method, account_number: accountNumber,
      requested_by: adminId, status: "completed",
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, withdrawal: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/admin/providers/:id/status", async (req, res) => {
  try {
    const { data, error } = await supabase.from("providers")
      .update({ status: req.body.status }).eq("id", req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });

    // Notify provider of approval/rejection
    if (data.user_id) {
      const approved = req.body.status === "active";
      await createNotification(data.user_id, {
        title: approved ? "✅ Provider Approved!" : "❌ Provider Rejected",
        body: approved ? "Your provider account is now active!" : "Your provider account was not approved.",
        type: "system",
      });
    }

    res.json({ success: true, provider: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════
async function createNotification(userId, { title, body, type }) {
  try {
    await supabase.from("notifications").insert({
      user_id: userId, title, body, type: type || "general", read: false,
    });
  } catch (err) {
    console.error("Notification error:", err.message);
  }
}

async function createAdminNotification({ title, body }) {
  try {
    // Send to all admin users
    const { data: admins } = await supabase.from("profiles")
      .select("id").eq("is_admin", true);
    if (admins) {
      for (const admin of admins) {
        await createNotification(admin.id, { title, body, type: "admin" });
      }
    }
  } catch (err) {
    console.error("Admin notification error:", err.message);
  }
}

async function notifySubscribers(providerId, { title, body, type }) {
  try {
    const now = new Date().toISOString();
    const { data: subscribers } = await supabase.from("payments")
      .select("user_id").eq("provider_id", providerId)
      .eq("status", "active").gt("expires_at", now);

    if (subscribers) {
      for (const sub of subscribers) {
        await createNotification(sub.user_id, { title, body, type });
      }
    }
  } catch (err) {
    console.error("Subscriber notification error:", err.message);
  }
}

// ════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 FinXhubra Backend v2.0 on port ${PORT}`);
  console.log(`💳 ClickPesa: ${CP.baseUrl}`);
  console.log(`🗄️  Supabase connected`);
  console.log(`💰 Commission: ${PROVIDER_CUT*100}% provider / ${PLATFORM_CUT*100}% platform`);
  console.log(`📅 Forex pricing: 5 days/week, 21 days/month`);
});
