const crypto = require("crypto");
const axios = require("axios");
require("dotenv").config();

// متغير لتتبع عدد الرسائل المرسولة
let sentCount = 0;
const MAX_QUOTA = 10; // أقصى عدد مسموح به من الرسائل

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

    // ------ قراءة ومعالجة البيانات ------ //
    const rawBody = await getRawBody(req);

    // ------ التحقق من صحة التوقيع ------ //
    if (!verifyHmac(hmacHeader, rawBody)) {
      return res.status(401).json({ error: "Invalid HMAC signature" });
    }

    const webhookData = JSON.parse(rawBody.toString("utf8"));

    // ------ استخراج رقم الهاتف ------ //
    const phone = extractPhoneNumber(webhookData);
    if (!phone) {
      return res.status(400).json({ error: "Phone number not found" });
    }

    // ------ التحقق من الحصة المتبقية ------ //
    const remainingQuota = await checkCredit();
    if (remainingQuota <= 0) {
      return res.status(402).json({ error: "SMS quota exceeded" });
    }

    // ------ إنشاء الرسالة بناءً على الحدث ------ //
    const message = createNotificationMessage(eventType, webhookData);
    if (!message) {
      return res.status(400).json({ error: "Unsupported event type" });
    }

    // ------ إرسال الرسالة مع تحديث الحصة ------ //
    await sendSMS(phone, message);
    sentCount++;

    // ------ الرد الناجح مع بيانات الحصة ------ //
    return res.status(200).json({
      success: true,
      message: "SMS sent successfully",
      quota: {
        sent: sentCount,
        remaining: MAX_QUOTA - sentCount,
      },
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

async function checkCredit() {
  try {
    const response = await axios.post(process.env.CHECK_CREDIT_URL, {
      UserName: process.env.SMS_USERNAME,
      Password: process.env.SMS_PASSWORD,
    });

    // معالجة الأكواد الخاصة بـ Community Ads
    if (response.data === -5) {
      throw new Error("الحصة نفذت");
    }

    return response.data;
  } catch (error) {
    console.error("Credit Check Failed:", error);
    throw error;
  }
}

async function sendSMS(phoneNumber, message) {
  if (sentCount >= MAX_QUOTA) {
    throw new Error("لقد وصلت إلى الحد الأقصى للرسائل");
  }

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
    throw new Error(`فشل الإرسال: ${response.data}`);
  }
}
