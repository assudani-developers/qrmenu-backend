'use strict';
/**
 * Email Service for QR Menu Pro (Assudani Developers)
 * Free Gmail SMTP setup via Google App Passwords
 * Default Sender: assudanigroup@gmail.com
 */

const nodemailer = require('nodemailer');

const SENDER_EMAIL = process.env.SMTP_USER || 'assudanigroup@gmail.com';
const SENDER_NAME = process.env.SMTP_NAME || 'QR Menu Pro · Assudani Developers';
const SENDER_PASS = process.env.SMTP_PASS || ''; // 16-character Google App Password

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!SENDER_PASS) {
    return null; // Simulation mode when password is not configured
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false', // true for 465, false for 587
    auth: {
      user: SENDER_EMAIL,
      pass: SENDER_PASS,
    },
  });

  return transporter;
}

/**
 * Core send mail wrapper with automatic fallback simulation mode
 */
async function sendMail({ to, subject, html, text }) {
  if (!to || !to.includes('@')) {
    return { success: false, reason: 'Invalid recipient email' };
  }

  const tx = getTransporter();
  const mailOptions = {
    from: `"${SENDER_NAME}" <${SENDER_EMAIL}>`,
    to,
    subject,
    text: text || html.replace(/<[^>]+>/g, ' '),
    html,
  };

  if (!tx) {
    console.log(`[Mailer:Simulated] 📧 To: ${to} | Subject: "${subject}"`);
    return { success: true, simulated: true, to, subject };
  }

  try {
    const info = await tx.sendMail(mailOptions);
    console.log(`[Mailer:Sent] MessageId: ${info.messageId} to ${to}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Mailer:Error] Failed to send email to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/* ---------------- HTML Email Base Template ---------------- */
function wrapEmail(content, title = 'QR Menu Pro') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #0c0a14; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f4ede4; }
    .container { max-width: 580px; margin: 30px auto; background-color: #161224; border-radius: 20px; border: 1px solid rgba(200, 169, 110, 0.25); overflow: hidden; box-shadow: 0 15px 35px rgba(0,0,0,0.5); }
    .header { background: linear-gradient(135deg, #1f1833 0%, #0c0a14 100%); padding: 32px 28px; text-align: center; border-bottom: 1px solid rgba(200, 169, 110, 0.2); }
    .brand { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; color: #C8A96E; }
    .brand-sub { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; color: #a59fb8; margin-top: 4px; }
    .body { padding: 32px 28px; }
    .footer { padding: 24px 28px; text-align: center; background-color: #0f0c1a; border-top: 1px solid rgba(255,255,255,0.06); font-size: 12px; color: #7f7894; line-height: 1.6; }
    .btn { display: inline-block; background: linear-gradient(135deg, #E2C792 0%, #C8A96E 100%); color: #161224 !important; font-weight: 800; font-size: 15px; padding: 14px 28px; border-radius: 12px; text-decoration: none; margin: 20px 0; }
    .card { background-color: #1e1930; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 20px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="brand">QR MENU PRO</div>
      <div class="brand-sub">Assudani Developers · SaaS Suite</div>
    </div>
    <div class="body">
      ${content}
    </div>
    <div class="footer">
      <p style="margin: 0 0 8px 0; color: #a59fb8; font-weight: 600;">Designed & Developed by Piyush Assudani</p>
      <p style="margin: 0 0 6px 0;">Founder, Assudani Developers · Contact: <a href="mailto:assudanigroup@gmail.com" style="color: #C8A96E; text-decoration: none;">assudanigroup@gmail.com</a></p>
      <p style="margin: 0; font-size: 11px;">You received this email because you are a registered restaurant partner on QR Menu Pro.</p>
    </div>
  </div>
</body>
</html>`;
}

/* ---------------- 1. Verification OTP Email ---------------- */
async function sendOtpEmail({ to, code, name = 'Restaurant Partner' }) {
  const content = `
    <h2 style="font-size: 22px; margin-top: 0; color: #ffffff;">Email Verification Code</h2>
    <p style="color: #c7c2d6; font-size: 15px; line-height: 1.6;">Hello <strong>${name}</strong>,</p>
    <p style="color: #c7c2d6; font-size: 15px; line-height: 1.6;">Use the 6-digit verification code below to verify your email address on QR Menu Pro:</p>
    
    <div style="background: rgba(200, 169, 110, 0.1); border: 2px dashed #C8A96E; border-radius: 16px; padding: 24px; text-align: center; margin: 26px 0;">
      <div style="font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #E2C792; font-family: monospace;">${code}</div>
      <div style="font-size: 12px; color: #a59fb8; margin-top: 8px;">Valid for 10 minutes · Do not share with anyone</div>
    </div>

    <p style="color: #8c85a0; font-size: 13px; line-height: 1.5;">If you did not request this verification code, please ignore this email or contact support at <a href="mailto:assudanigroup@gmail.com" style="color: #C8A96E;">assudanigroup@gmail.com</a>.</p>
  `;

  return sendMail({
    to,
    subject: `Your QR Menu Pro Verification Code: ${code}`,
    html: wrapEmail(content, 'Email Verification'),
  });
}

/* ---------------- 2. Payment Submitted Email ---------------- */
async function sendPaymentSubmittedEmail({ to, restaurantName, amount, planName, utrRef }) {
  const content = `
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="display: inline-block; width: 50px; height: 50px; line-height: 50px; border-radius: 50%; background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-size: 26px;">⏳</div>
      <h2 style="font-size: 22px; margin: 14px 0 6px 0; color: #ffffff;">Payment Submitted for Verification</h2>
      <p style="color: #a59fb8; font-size: 14px; margin: 0;">We have received your payment submission!</p>
    </div>

    <div class="card">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="color: #8c85a0; padding: 8px 0;">Restaurant</td><td style="text-align: right; font-weight: 700; color: #ffffff;">${restaurantName}</td></tr>
        <tr><td style="color: #8c85a0; padding: 8px 0;">Plan Selected</td><td style="text-align: right; font-weight: 700; color: #C8A96E;">${planName} Plan</td></tr>
        <tr><td style="color: #8c85a0; padding: 8px 0;">Amount Paid</td><td style="text-align: right; font-weight: 800; font-size: 16px; color: #34d399;">₹${amount}</td></tr>
        <tr><td style="color: #8c85a0; padding: 8px 0;">UTR / Ref Number</td><td style="text-align: right; font-mono; font-weight: 600; color: #c7c2d6;">${utrRef}</td></tr>
      </table>
    </div>

    <p style="color: #c7c2d6; font-size: 14px; line-height: 1.6;">
      Our verification team matches the bank UTR reference with our UPI logs. This process typically completes within <strong>15 to 30 minutes</strong>.
    </p>
    <p style="color: #c7c2d6; font-size: 14px; line-height: 1.6;">
      As soon as payment is confirmed, you will receive your <strong>Official Tax Invoice & Receipt</strong> via email, and your plan will be instantly upgraded.
    </p>
  `;

  return sendMail({
    to,
    subject: `Payment Submitted: ₹${amount} for ${restaurantName} (UTR: ${utrRef})`,
    html: wrapEmail(content, 'Payment Verification in Progress'),
  });
}

/* ---------------- 3. Payment Verified Receipt + Upsell Email ---------------- */
async function sendPaymentReceiptEmail({
  to,
  restaurantName,
  amount,
  originalPrice,
  discount = 0,
  couponCode = null,
  planName,
  utrRef,
  validUntil,
  invoiceId,
  websiteUrl = 'https://qrmenu-website-three.vercel.app',
}) {
  const formattedDate = validUntil ? new Date(validUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '30 Days';
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  const content = `
    <!-- Parchi-Style Receipt Header -->
    <div style="background: linear-gradient(135deg, rgba(200, 169, 110, 0.15) 0%, rgba(200, 169, 110, 0.05) 100%); border: 1px solid rgba(200, 169, 110, 0.35); border-radius: 18px; padding: 26px; text-align: center; position: relative;">
      <div style="font-size: 32px; margin-bottom: 6px;">✨</div>
      <div style="font-size: 12px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: #C8A96E;">OFFICIAL PAYMENT RECEIPT</div>
      <h2 style="font-size: 24px; margin: 8px 0; color: #ffffff;">Payment Approved & Live!</h2>
      <div style="font-size: 13px; color: #a59fb8;">Invoice #${invoiceId || `INV-${Date.now().toString(36).toUpperCase()}`} · Date: ${today}</div>
    </div>

    <!-- Receipt Details Table -->
    <div style="background: #110e1c; border-radius: 16px; border: 1px dashed rgba(200, 169, 110, 0.4); padding: 22px; margin: 24px 0;">
      <div style="border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 12px; margin-bottom: 14px;">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #8c85a0;">Billed To</div>
        <div style="font-size: 18px; font-weight: 800; color: #ffffff; margin-top: 4px;">${restaurantName}</div>
      </div>

      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
          <td style="padding: 10px 0; color: #c7c2d6;">
            <strong>${planName} Plan Subscription</strong><br>
            <span style="font-size: 12px; color: #8c85a0;">30 Days Full Access · Valid till ${formattedDate}</span>
          </td>
          <td style="text-align: right; padding: 10px 0; font-weight: 700; color: #ffffff;">₹${originalPrice || amount}</td>
        </tr>
        ${discount > 0 ? `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
          <td style="padding: 10px 0; color: #34d399;">
            Coupon Discount (${couponCode || 'PROMO'})
          </td>
          <td style="text-align: right; padding: 10px 0; font-weight: 700; color: #34d399;">- ₹${discount}</td>
        </tr>` : ''}
        <tr>
          <td style="padding: 14px 0; font-size: 16px; font-weight: 800; color: #C8A96E;">Total Paid via UPI</td>
          <td style="text-align: right; padding: 14px 0; font-size: 20px; font-weight: 900; color: #E2C792;">₹${amount}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; font-size: 12px; color: #8c85a0;">Bank Reference / UTR</td>
          <td style="text-align: right; padding: 4px 0; font-size: 12px; font-family: monospace; color: #c7c2d6;">${utrRef}</td>
        </tr>
      </table>
    </div>

    <!-- Upsell Marketing Section (Ultra Plan Promotion) -->
    <div style="background: linear-gradient(135deg, #2b1f47 0%, #171126 100%); border: 1px solid rgba(168, 85, 247, 0.4); border-radius: 16px; padding: 24px; margin: 28px 0; text-align: center;">
      <div style="display: inline-block; background: rgba(168, 85, 247, 0.2); color: #c084fc; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; padding: 4px 12px; border-radius: 99px; text-transform: uppercase; margin-bottom: 10px;">
        🚀 EXCLUSIVE UPGRADE OFFER
      </div>
      <h3 style="font-size: 18px; margin: 0 0 8px 0; color: #ffffff;">Take Your Brand to the Next Level with ULTRA</h3>
      <p style="font-size: 13px; color: #c7c2d6; line-height: 1.5; margin: 0 0 16px 0;">
        Custom Domain (e.g. <em>menu.yourhotel.com</em>) · Multi-Branch POS Sync · Priority VIP Concierge · Dedicated Account Manager · 0% Commission Always.
      </p>
      <a href="${websiteUrl}/pricing" class="btn" style="margin: 0; padding: 10px 24px; font-size: 13px;">Explore Ultra Tier →</a>
    </div>

    <p style="color: #8c85a0; font-size: 12px; text-align: center;">
      Need assistance or GST invoice adjustment? WhatsApp/Email our dedicated founder desk: <a href="mailto:assudanigroup@gmail.com" style="color: #C8A96E;">assudanigroup@gmail.com</a>
    </p>
  `;

  return sendMail({
    to,
    subject: `Payment Receipt: ₹${amount} for ${restaurantName} (Active till ${formattedDate})`,
    html: wrapEmail(content, `Payment Receipt #${invoiceId || ''}`),
  });
}

/* ---------------- 4. Expiry Alert Email (3-Day & 1-Day) ---------------- */
async function sendExpiryAlertEmail({
  to,
  restaurantName,
  planName,
  daysLeft,
  isTrial = false,
  renewUrl = 'https://qrmenu-website-three.vercel.app/pricing',
}) {
  const urgencyTone = daysLeft <= 1 ? '#ef4444' : '#f59e0b';
  const timeText = daysLeft <= 1 ? 'TOMORROW' : `in ${daysLeft} days`;

  const content = `
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="display: inline-block; width: 50px; height: 50px; line-height: 50px; border-radius: 50%; background: ${urgencyTone}25; color: ${urgencyTone}; font-size: 26px;">⏰</div>
      <h2 style="font-size: 22px; margin: 14px 0 6px 0; color: #ffffff;">Your ${isTrial ? 'Trial' : 'Subscription'} Ends ${timeText}</h2>
      <p style="color: #a59fb8; font-size: 14px; margin: 0;">Don't let your live QR menu get paused!</p>
    </div>

    <div class="card">
      <p style="font-size: 15px; color: #e2dcf0; line-height: 1.6; margin: 0 0 14px 0;">
        Hello <strong>${restaurantName}</strong>,
      </p>
      <p style="font-size: 14px; color: #c7c2d6; line-height: 1.6; margin: 0 0 14px 0;">
        Your <strong>${planName}</strong> ${isTrial ? 'free trial' : 'subscription'} will expire <strong>${timeText}</strong>. Once expired, guests scanning your QR standees will not be able to browse dishes or place orders.
      </p>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${renewUrl}" class="btn">Renew & Keep Menu Live Now</a>
      </div>
      <p style="font-size: 13px; color: #8c85a0; margin: 0; line-height: 1.5;">
        Renew in under 60 seconds with instant UPI payment. Your menu settings, photos, categories, and QR designs will remain completely intact.
      </p>
    </div>
  `;

  return sendMail({
    to,
    subject: `⚠️ Important: ${restaurantName} QR Menu expires ${timeText}`,
    html: wrapEmail(content, 'Subscription Expiry Alert'),
  });
}

/* ---------------- 5. 3-Day Grace Period Alert Email (Paid Plans Only) ---------------- */
async function sendGracePeriodEmail({
  to,
  restaurantName,
  planName,
  graceDaysLeft,
  renewUrl = 'https://qrmenu-website-three.vercel.app/pricing',
}) {
  const content = `
    <div style="text-align: center; margin-bottom: 24px;">
      <div style="display: inline-block; width: 50px; height: 50px; line-height: 50px; border-radius: 50%; background: rgba(239, 68, 68, 0.15); color: #ef4444; font-size: 26px;">🛡️</div>
      <h2 style="font-size: 22px; margin: 14px 0 6px 0; color: #ffffff;">Action Required: 3-Day Grace Period Active</h2>
      <p style="color: #f87171; font-size: 14px; margin: 0; font-weight: 700;">${graceDaysLeft} Day${graceDaysLeft > 1 ? 's' : ''} Remaining Before Menu Suspension</p>
    </div>

    <div class="card" style="border-color: rgba(239, 68, 68, 0.35);">
      <p style="font-size: 15px; color: #e2dcf0; line-height: 1.6; margin: 0 0 12px 0;">
        Hello <strong>${restaurantName}</strong>,
      </p>
      <p style="font-size: 14px; color: #c7c2d6; line-height: 1.6; margin: 0 0 14px 0;">
        Your paid <strong>${planName}</strong> plan has ended. As a valued paid subscriber, we have activated a <strong>3-Day Courtesy Grace Period</strong> so your dining room operations are not disrupted.
      </p>
      <div style="background: rgba(239, 68, 68, 0.1); border-left: 4px solid #ef4444; padding: 12px 16px; border-radius: 8px; margin: 18px 0;">
        <div style="font-size: 13px; color: #fca5a5; font-weight: 700;">Menu Status: STILL LIVE (Temporary)</div>
        <div style="font-size: 12px; color: #e2dcf0; margin-top: 4px;">After ${graceDaysLeft} day${graceDaysLeft > 1 ? 's' : ''}, guest QR scanning will be automatically paused.</div>
      </div>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${renewUrl}" class="btn" style="background: linear-gradient(135deg, #f87171 0%, #ef4444 100%); color: #ffffff !important;">Renew Now to Avoid Interruption</a>
      </div>
    </div>
  `;

  return sendMail({
    to,
    subject: `🚨 Urgent: 3-Day Grace Period Active for ${restaurantName} (${graceDaysLeft}d left)`,
    html: wrapEmail(content, 'Courtesy Grace Period Active'),
  });
}

module.exports = {
  sendMail,
  sendOtpEmail,
  sendPaymentSubmittedEmail,
  sendPaymentReceiptEmail,
  sendExpiryAlertEmail,
  sendGracePeriodEmail,
};
