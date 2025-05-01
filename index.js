const crypto = require("crypto");
const axios = require("axios");

module.exports = async (req, res) => {
  try {
    // ------ 1. التحقق الأساسي من نوع الطلب ------ //
    if (req.method !== "POST") {
      console.warn("⚠️ Request method not allowed:", req.method);
      return res.status(405).json({ error: "الطريقة غير مسموحة" });
    }

    // ------ 2. التحقق من الهيدرات الأساسية ------ //
    const requiredHeaders = [
      "x-shopify-topic",
      "x-shopify-shop-domain",
      "x-shopify-hmac-sha256",
    ];

    const missingHeaders = requiredHeaders.filter((h) => !req.headers[h]);
    if (missingHeaders.length > 0) {
      console.error("❌ Missing headers:", missingHeaders);
      return res.status(401).json({ error: "هيدرات مطلوبة مفقودة" });
    }

    // ------ 3. قراءة البيانات الخام ------ //
    const rawBody = await getRawBody(req);
    console.log("✅ Received raw body:", rawBody.toString("utf8"));

    // ------ 4. التحقق من توقيع HMAC ------ //
    const isValidHmac = verifyHmac(
      req.headers["x-shopify-hmac-sha256"],
      rawBody
    );

    if (!isValidHmac) {
      console.error("❌ HMAC verification failed");
      return res.status(401).json({ error: "توقيع غير صالح" });
    }

    // ------ 5. معالجة البيانات ------ //
    const webhookData = JSON.parse(rawBody.toString("utf8"));
    console.log("📦 Webhook Data:", JSON.stringify(webhookData, null, 2));

    const phone = extractPhoneNumber(webhookData);
    if (!phone) {
      console.error("📞 Phone number not found in data");
      return res.status(400).json({ error: "رقم الهاتف غير موجود" });
    }

    // ------ 6. التحقق من رصيد الرسائل ------ //
    const remainingQuota = await checkCredit();
    console.log("💳 Remaining SMS quota:", remainingQuota);

    if (remainingQuota <= 0) {
      return res.status(402).json({ error: "نفاد الحصة المسموحة" });
    }

    // ------ 7. إنشاء محتوى الرسالة ------ //
    const message = createNotificationMessage(
      req.headers["x-shopify-topic"],
      webhookData
    );

    if (!message) {
      console.error(
        "📭 Unsupported event type:",
        req.headers["x-shopify-topic"]
      );
      return res.status(400).json({ error: "نوع الحدث غير مدعوم" });
    }

    // ------ 8. إرسال الرسالة النصية ------ //
    console.log("🚀 Attempting to send SMS:", { phone, message });
    const smsResponse = await sendSMS(phone, message);
    console.log("📩 SMS sent successfully:", smsResponse);

    // ------ 9. الرد النهائي ------ //
    res.status(200).json({
      success: true,
      message: "تم إرسال الرسالة بنجاح",
      remaining_quota: remainingQuota - 1,
      sms_id: smsResponse.SMSID,
    });
  } catch (error) {
    console.error("🔥 Critical Error:", error.stack);
    res.status(500).json({
      error: "خطأ داخلي",
      details: error.message,
      ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
    });
  }
};

// ========== الدوال المساعدة ========== //

function verifyHmac(hmacHeader, body) {
  try {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    if (!secret) throw new Error("SHOPIFY_WEBHOOK_SECRET غير موجود");

    const generatedHash = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("base64");

    return crypto.timingSafeEqual(
      Buffer.from(generatedHash, "base64"),
      Buffer.from(hmacHeader, "base64")
    );
  } catch (error) {
    console.error("🔐 HMAC Verification Error:", error);
    return false;
  }
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = [];
    req
      .on("data", (chunk) => data.push(chunk))
      .on("end", () => resolve(Buffer.concat(data)))
      .on("error", reject);
  });
}

function extractPhoneNumber(data) {
  // تحسين البحث في الهيكل لاستخراج رقم الهاتف
  const phonePaths = [
    "customer.phone",
    "order.customer.phone",
    "checkout.billing_address.phone",
    "billing_address.phone",
    "shipping_address.phone",
  ];

  for (const path of phonePaths) {
    const value = path.split(".").reduce((obj, key) => obj?.[key], data);
    if (value && isValidPhone(value)) return value;
  }

  return null;
}

function isValidPhone(phone) {
  const phoneRegex = /^\+?[0-9]{8,15}$/;
  return phoneRegex.test(phone);
}

function createNotificationMessage(eventType, data) {
  const templates = {
    "orders/create": `📦 تم تأكيد طلبك #${data.order?.order_number}! شكراً لثقتك`,
    "orders/cancelled": `⚠️ إلغاء الطلب #${
      data.order?.order_number
    }، للاستفسار: ${process.env.STORE_PHONE || ""}`,
    "orders/updated": `🔄 تحديث حالة الطلب #${data.order?.order_number}: ${data.order?.financial_status}`,
    "orders/paid": `💳 تم دفع طلبك #${data.order?.order_number}`,
    "orders/fulfilled": `🚚 تم شحن طلبك #${data.order?.order_number}`,
  };

  return templates[eventType] || null;
}

async function checkCredit() {
  try {
    const response = await axios.post(process.env.CHECK_CREDIT_URL, {
      UserName: process.env.SMS_USERNAME,
      Password: process.env.SMS_PASSWORD,
    });

    if (typeof response.data !== "number") {
      throw new Error("استجابة غير صالحة من خدمة الرسائل");
    }

    return response.data;
  } catch (error) {
    console.error(
      "💸 Credit Check Failed:",
      error.response?.data || error.message
    );
    throw new Error("فشل التحقق من الرصيد");
  }
}

async function sendSMS(phoneNumber, message) {
  try {
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
      throw new Error(JSON.stringify(response.data));
    }

    return response.data;
  } catch (error) {
    console.error("📴 SMS Send Error:", error.response?.data || error.message);
    throw new Error("فشل إرسال الرسالة");
  }
}
