const crypto = require("crypto");
const axios = require("axios");
require("dotenv").config();

module.exports = async (req, res) => {
  try {
    // ------ التحقق من طريقة الطلب ------ //
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // ------ التحقق من الهيدرات الأساسية ------ //
    const eventType = req.headers["x-shopify-topic"];
    const shopDomain = req.headers["x-shopify-shop-domain"];
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    if (!eventType || !shopDomain || !hmacHeader) {
      return res.status(401).json({ error: "Missing required headers" });
    }

    // ------ قراءة البيانات الخام ------ //
    const rawBody = await getRawBody(req);

    // ------ التحقق من توقيع HMAC ------ //
    if (!verifyHmac(hmacHeader, rawBody)) {
      return res.status(401).json({ error: "Invalid HMAC signature" });
    }

    // ------ معالجة البيانات ------ //
    const webhookData = JSON.parse(rawBody.toString("utf8"));
    const phone = extractPhoneNumber(webhookData);

    if (!phone) {
      return res.status(400).json({ error: "Phone number not found" });
    }

    // ------ التحقق من الرصيد المتبقي ------ //
    const remainingQuota = await checkCredit();
    if (remainingQuota <= 0) {
      return res.status(402).json({ error: "SMS quota exceeded" });
    }

    // ------ إنشاء الرسالة ------ //
    const message = createNotificationMessage(eventType, webhookData);
    if (!message) {
      return res.status(400).json({ error: "Unsupported event type" });
    }

    // ------ إرسال الرسالة ------ //
    await sendSMS(phone, message);

    return res.status(200).json({
      success: true,
      message: "SMS sent successfully",
      remaining_quota: remainingQuota - 1,
    });
  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      details: error.message,
    });
  }
};

// ========== الدوال المساعدة ========== //

function verifyHmac(hmacHeader, body) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const generatedHash = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(generatedHash, "base64"),
    Buffer.from(hmacHeader, "base64")
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
    data?.checkout?.billing_address?.phone
  );
}

function createNotificationMessage(eventType, data) {
  const orderNumber = data.order?.order_number || "N/A";

  const messages = {
    "orders/create": `📦 تم تأكيد طلبك #${orderNumber}! شكراً لاختيارك متجرنا`,
    "orders/cancelled": `⚠️ نأسف لإلغاء طلبك #${orderNumber}. للاستفسار: ${process.env.STORE_CONTACT}`,
    "orders/updated": `🔄 تم تحديث حالة طلبك #${orderNumber} إلى: ${data.order?.financial_status}`,
  };

  return messages[eventType];
}

async function checkCredit() {
  try {
    const response = await axios.post(process.env.CHECK_CREDIT_URL, {
      UserName: process.env.SMS_USERNAME,
      Password: process.env.SMS_PASSWORD,
    });

    if (response.data === -5) throw new Error("الحصة نفذت");
    return response.data;
  } catch (error) {
    throw new Error(`فشل التحقق من الرصيد: ${error.message}`);
  }
}

async function sendSMS(phoneNumber, message) {
  const payload = {
    UserName: process.env.SMS_USERNAME,
    Password: process.env.SMS_PASSWORD,
    SMSText: message,
    SMSLang: "ar",
    SMSSender: process.env.SMS_SENDER,
    SMSReceiver: phoneNumber,
    SMSID: crypto.randomUUID(),
  };

  const response = await axios.post(process.env.SMS_API_URL, payload);

  if (response.data?.Status !== "Success") {
    throw new Error(`فشل إرسال الرسالة: ${JSON.stringify(response.data)}`);
  }
}
