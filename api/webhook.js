const crypto = require("crypto");
const axios = require("axios");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const hmacHeader = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];
    const domain = req.headers["x-shopify-shop-domain"];

    if (!hmacHeader || !topic || !domain) {
      return res.status(401).json({ error: "Missing required headers" });
    }

    const rawBody = await getRawBody(req);

    const isValid = verifyHmac(hmacHeader, rawBody);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid HMAC signature" });
    }

    const data = JSON.parse(rawBody.toString("utf8"));
    const phone = extractPhoneNumber(data);
    if (!phone) {
      return res.status(400).json({ error: "Phone number not found" });
    }

    const remaining = await checkCredit();
    if (remaining <= 0) {
      return res.status(402).json({ error: "SMS quota exceeded" });
    }

    const message = createMessage(topic, data);
    if (!message) {
      return res.status(400).json({ error: "Unsupported event type" });
    }

    const smsResult = await sendSMS(phone, message);

    return res.status(200).json({
      success: true,
      sms_id: smsResult.SMSID,
      remaining_quota: remaining - 1,
    });
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: err.message });
  }
};

// ----------------------- Helpers -----------------------

function verifyHmac(hmac, body) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const hash = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(hash, "base64"),
    Buffer.from(hmac, "base64")
  );
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractPhoneNumber(data) {
  return (
    data?.customer?.phone ||
    data?.order?.customer?.phone ||
    data?.checkout?.billing_address?.phone ||
    data?.billing_address?.phone ||
    data?.shipping_address?.phone ||
    null
  );
}

function createMessage(topic, data) {
  const orderNumber = data.order?.order_number || "بدون رقم";

  const templates = {
    "orders/create": `📦 تم تأكيد طلبك #${orderNumber}! شكراً لك.`,
    "orders/cancelled": `⚠️ تم إلغاء طلبك #${orderNumber}. للتواصل: ${
      process.env.STORE_PHONE || ""
    }`,
    "orders/updated": `🔄 تم تحديث حالة الطلب #${orderNumber}.`,
    "orders/fulfilled": `🚚 تم شحن طلبك #${orderNumber}.`,
    "orders/paid": `💳 تم دفع طلبك #${orderNumber}.`,
  };

  return templates[topic] || null;
}

async function checkCredit() {
  const res = await axios.post(process.env.CHECK_CREDIT_URL, {
    UserName: process.env.SMS_USERNAME,
    Password: process.env.SMS_PASSWORD,
  });
  if (typeof res.data !== "number") throw new Error("Invalid credit response");
  return res.data;
}

async function sendSMS(phone, message) {
  const payload = {
    UserName: process.env.SMS_USERNAME,
    Password: process.env.SMS_PASSWORD,
    SMSText: message,
    SMSLang: "ar",
    SMSSender: process.env.SMS_SENDER,
    SMSReceiver: phone,
    SMSID: crypto.randomUUID(),
  };

  const res = await axios.post(process.env.SMS_API_URL, payload);
  if (res.data?.Status !== "Success") throw new Error("SMS sending failed");

  return res.data;
}
