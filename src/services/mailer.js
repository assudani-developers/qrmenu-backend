'use strict';
/**
 * Email Service for QR Menu Pro (Assudani Developers)
 * Free Gmail SMTP setup via Google App Passwords
 * Default Sender: assudanigroup@gmail.com
 */

const nodemailer = require('nodemailer');

const SENDER_EMAIL = () => (process.env.SMTP_USER || 'assudanigroup@gmail.com').trim();
const SENDER_NAME = () => (process.env.SMTP_NAME || 'QR Menu Pro · Assudani Developers').trim();
const SENDER_PASS = () => (process.env.SMTP_PASS || '').replace(/\s+/g, '');

let transporter = null;

function getTransporter() {
  const pass = SENDER_PASS();
  if (!pass) {
    return null; // Simulation mode when password is not configured
  }
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false', // true for 465, false for 587
    auth: {
      user: SENDER_EMAIL(),
      pass,
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
    from: `"${SENDER_NAME()}" <${SENDER_EMAIL()}>`,
    replyTo: SENDER_EMAIL(),
    to,
    subject,
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
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

/* ---------------- HTML Email Base Template (Clean Light Theme) ---------------- */
function wrapEmail(content, title = 'QR Menu Pro', preheader = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #1e293b;">
  ${preheader ? `<div style="display: none; max-height: 0px; overflow: hidden; font-size: 1px; line-height: 1px; color: #f1f5f9; opacity: 0;">${preheader}</div>` : ''}
  
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f1f5f9; padding: 32px 12px;">
    <tr>
      <td align="center">
        <!-- Container Card -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 20px; border: 1px solid #e2e8f0; box-shadow: 0 10px 30px rgba(0,0,0,0.06); overflow: hidden;">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #1e1b2e 0%, #0f0c1b 100%); padding: 32px 24px; text-align: center; border-bottom: 2px solid #d97706;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <div style="display: inline-block; width: 48px; height: 48px; line-height: 48px; border-radius: 14px; background: linear-gradient(135deg, #fbbf24 0%, #d97706 100%); color: #1e1b2e; font-size: 24px; font-weight: 900; box-shadow: 0 4px 12px rgba(217,119,6,0.3); margin-bottom: 10px;">
                      ⚡
                    </div>
                    <div style="font-size: 24px; font-weight: 900; letter-spacing: 0.5px; color: #fef3c7; margin-bottom: 3px;">
                      QR MENU PRO
                    </div>
                    <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; color: #cbd5e1;">
                      Assudani Developers · Digital Restaurant Suite
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 34px 30px 24px 30px; background-color: #ffffff;">
              ${content}
            </td>
          </tr>

          <!-- Spam notice helper box -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 16px; font-size: 12px; color: #64748b; line-height: 1.5;">
                📬 <strong>Spam Folder Check:</strong> If this email arrived in your Spam/Junk folder, please click <em>"Report as not spam"</em> or move it to your Inbox to guarantee instant delivery of your order alerts and payment receipts.
              </div>
            </td>
          </tr>

          <!-- Signature & Footer -->
          <tr>
            <td style="padding: 22px 30px 28px 30px; text-align: center; background-color: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; line-height: 1.6;">
              <div style="display: inline-block; background: #fef3c7; border: 1px solid #fde68a; border-radius: 99px; padding: 3px 12px; font-size: 10.5px; font-weight: 800; color: #b45309; margin-bottom: 10px;">
                ⭐ OFFICIAL VERIFIED SYSTEM
              </div>
              <p style="margin: 0 0 4px 0; color: #1e293b; font-size: 13px; font-weight: 700;">
                Designed &amp; Developed by Piyush Assudani
              </p>
              <p style="margin: 0 0 6px 0; color: #475569;">
                Founder, Assudani Developers · <a href="mailto:assudanigroup@gmail.com" style="color: #d97706; text-decoration: none; font-weight: 700;">assudanigroup@gmail.com</a>
              </p>
              <p style="margin: 0; font-size: 11px; color: #94a3b8;">
                &copy; ${new Date().getFullYear()} QR Menu Pro. Ultra-reliable offline-first digital menu and kitchen platform.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ---------------- 1. Verification OTP Email ---------------- */
const OTP_TEXT = {
  signup: ['Verify your email', 'Use this code to confirm your email and finish creating your QR Menu Pro account:'],
  reset: ['Reset your password / Instant sign-in', 'Use this 6-digit verification code to reset your password or sign in to your QR Menu Pro account:'],
  login: ['Your sign-in code', 'Use this 6-digit code to finish signing in to QR Menu Pro:'],
  email: ['Confirm your new email', 'Use this code to confirm this as the new email for your QR Menu Pro account:'],
  twostep: ['Turn on two-step sign-in', 'Use this code to switch on two-step sign-in for your QR Menu Pro account:'],
};
async function sendOtpEmail({ to, code, name = 'Restaurant Partner', purpose = 'signup' }) {
  const [heading, lead] = OTP_TEXT[purpose] || OTP_TEXT.signup;
  const content = `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 20px; text-align: center;">
      <tr>
        <td align="center">
          <div style="display: inline-block; width: 52px; height: 52px; line-height: 52px; border-radius: 50%; background: #fef3c7; border: 1px solid #fde68a; font-size: 24px; text-align: center;">
            🔐
          </div>
          <h2 style="font-size: 22px; font-weight: 800; margin: 14px 0 4px 0; color: #0f172a;">${heading}</h2>
          <div style="font-size: 12.5px; color: #64748b;">Assudani Developers · Identity Security</div>
        </td>
      </tr>
    </table>

    <p style="color: #334155; font-size: 15px; line-height: 1.6; margin: 0 0 10px 0;">Hello <strong>${name}</strong>,</p>
    <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 18px 0;">
      ${lead}
    </p>
    
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background: #fefce8; border: 2px dashed #ca8a04; border-radius: 16px; margin: 20px 0;">
      <tr>
        <td align="center" style="padding: 22px 16px;">
          <div style="font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #854d0e; font-family: 'Courier New', Courier, monospace; padding-left: 10px; user-select: all;">${code}</div>
          <div style="font-size: 12px; color: #713f12; margin-top: 8px; font-weight: 700;">Valid for 10 minutes · Click / tap and hold to copy</div>
        </td>
      </tr>
    </table>

    <div style="text-align: center; margin: 16px 0 24px 0;">
      <span style="display: inline-block; background-color: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 14px; font-size: 12px; font-weight: 700; color: #334155;">
        Code: <code style="font-family: monospace; font-size: 14px; color: #0f172a;">${code}</code>
      </span>
    </div>

    <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 0;">Did not ask for this? Ignore this email, your account remains safe. Support desk: <a href="mailto:assudanigroup@gmail.com" style="color: #d97706; text-decoration: none; font-weight: 600;">assudanigroup@gmail.com</a>.</p>
  `;

  return sendMail({
    to,
    subject: `${code} is your QR Menu Pro code`,
    html: wrapEmail(content, heading, `${code} is your QR Menu Pro verification code. Valid for 10 minutes.`),
  });
}

/* ---------------- 2. Payment Submitted Email ---------------- */
async function sendPaymentSubmittedEmail({ to, restaurantName, amount, planName, utrRef }) {
  const content = `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px; text-align: center;">
      <tr>
        <td align="center">
          <div style="display: inline-block; width: 56px; height: 56px; line-height: 56px; border-radius: 50%; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.4); font-size: 26px; text-align: center;">
            ⏳
          </div>
          <h2 style="font-size: 22px; font-weight: 800; margin: 14px 0 6px 0; color: #ffffff;">Payment Submitted for Verification</h2>
          <p style="color: #a59fb8; font-size: 14px; margin: 0;">We have received your UPI payment submission!</p>
        </td>
      </tr>
    </table>

    <div style="background-color: #191428; border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); padding: 22px; margin: 20px 0;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 14px;">
        <tr><td style="color: #8c85a0; padding: 8px 0;">Restaurant</td><td style="text-align: right; font-weight: 700; color: #ffffff;">${restaurantName}</td></tr>
        <tr><td style="color: #8c85a0; padding: 8px 0;">Plan Selected</td><td style="text-align: right; font-weight: 700; color: #C8A96E;">${planName} Plan</td></tr>
        <tr><td style="color: #8c85a0; padding: 8px 0;">Amount Paid</td><td style="text-align: right; font-weight: 800; font-size: 16px; color: #34d399;">₹${amount}</td></tr>
        <tr><td style="color: #8c85a0; padding: 8px 0;">UTR / Ref Number</td><td style="text-align: right; font-family: monospace; font-weight: 600; color: #c7c2d6;">${utrRef}</td></tr>
      </table>
    </div>

    <p style="color: #c7c2d6; font-size: 14px; line-height: 1.6; margin: 0 0 12px 0;">
      Bank UTR match hote hi system automatically aapka subscription live kar dega aur aapko <strong>Official Tax Invoice &amp; Receipt</strong> receive hogi.
    </p>
    <p style="color: #8c85a0; font-size: 12px; margin: 0;">
      Typically takes <strong>15 to 30 minutes</strong>. Need immediate activation? Ping founder desk directly at <a href="mailto:assudanigroup@gmail.com" style="color: #C8A96E; text-decoration: none;">assudanigroup@gmail.com</a>.
    </p>
  `;

  return sendMail({
    to,
    subject: `⏳ Payment Submitted: ₹${amount} for ${restaurantName} (UTR: ${utrRef})`,
    html: wrapEmail(content, 'Payment Verification in Progress', `We have received your payment of ₹${amount} for ${restaurantName}.`),
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
    <!-- Parchi-Style Receipt Header (Crisp Light Theme) -->
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 18px; padding: 24px; text-align: center;">
      <div style="font-size: 32px; margin-bottom: 6px;">✨</div>
      <div style="font-size: 11px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: #b45309;">OFFICIAL PAYMENT RECEIPT</div>
      <h2 style="font-size: 22px; font-weight: 900; margin: 6px 0; color: #0f172a;">Payment Approved &amp; Live!</h2>
      <div style="font-size: 13px; color: #64748b;">Invoice #${invoiceId || `INV-${Date.now().toString(36).toUpperCase()}`} · Date: ${today}</div>
    </div>

    <!-- Receipt Details Table -->
    <div style="background-color: #ffffff; border-radius: 16px; border: 2px dashed #cbd5e1; padding: 22px; margin: 24px 0;">
      <div style="border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; margin-bottom: 14px;">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #64748b;">Billed To</div>
        <div style="font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 4px;">${restaurantName}</div>
      </div>

      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 14px;">
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 0; color: #334155;">
            <strong>${planName} Plan Subscription</strong><br>
            <span style="font-size: 12px; color: #64748b;">30 Days Full Access · Valid till ${formattedDate}</span>
          </td>
          <td style="text-align: right; padding: 10px 0; font-weight: 700; color: #0f172a;">₹${originalPrice || amount}</td>
        </tr>
        ${discount > 0 ? `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 0; color: #059669; font-weight: 600;">
            Coupon Discount (${couponCode || 'PROMO'})
          </td>
          <td style="text-align: right; padding: 10px 0; font-weight: 700; color: #059669;">- ₹${discount}</td>
        </tr>` : ''}
        <tr>
          <td style="padding: 14px 0; font-size: 16px; font-weight: 800; color: #b45309;">Total Paid via UPI</td>
          <td style="text-align: right; padding: 14px 0; font-size: 22px; font-weight: 900; color: #b45309;">₹${amount}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 12px; color: #64748b;">Bank Reference / UTR</td>
          <td style="text-align: right; padding: 6px 0; font-size: 12px; font-family: monospace; color: #334155;">${utrRef}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; font-size: 12px; color: #64748b;">Status</td>
          <td style="text-align: right; padding: 6px 0; font-size: 12px; font-weight: 800; color: #059669;">PAID &amp; VERIFIED</td>
        </tr>
      </table>
    </div>

    <!-- Upsell Marketing Section (Ultra Plan Promotion) -->
    <div style="background-color: #faf5ff; border: 1px solid #e9d5ff; border-radius: 16px; padding: 22px; margin: 24px 0; text-align: center;">
      <div style="display: inline-block; background: #f3e8ff; color: #7e22ce; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; padding: 4px 12px; border-radius: 99px; text-transform: uppercase; margin-bottom: 8px;">
        🚀 EXCLUSIVE UPGRADE OFFER
      </div>
      <h3 style="font-size: 17px; margin: 0 0 6px 0; color: #4c1d95;">Scale Up with ULTRA</h3>
      <p style="font-size: 13px; color: #6b21a8; line-height: 1.5; margin: 0 0 14px 0;">
        All 10 Premium Themes · Custom Domain · Multi-Branch POS Sync · Dedicated Account Manager · 0% Commission.
      </p>
      <a href="${websiteUrl}/pricing" style="display: inline-block; background: #7e22ce; color: #ffffff; font-weight: 800; font-size: 13px; padding: 10px 22px; border-radius: 12px; text-decoration: none;">
        Explore Ultra Tier &rarr;
      </a>
    </div>

    <p style="color: #64748b; font-size: 12px; text-align: center; margin: 0;">
      Need assistance or GST invoice adjustment? Contact founder desk: <a href="mailto:assudanigroup@gmail.com" style="color: #d97706; text-decoration: none; font-weight: 600;">assudanigroup@gmail.com</a>
    </p>
  `;

  return sendMail({
    to,
    subject: `✨ Official Payment Receipt: ₹${amount} for ${restaurantName} (Active till ${formattedDate})`,
    html: wrapEmail(content, `Payment Receipt #${invoiceId || ''}`, `Official Payment Receipt for ₹${amount} paid for ${restaurantName}.`),
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
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px; text-align: center;">
      <tr>
        <td align="center">
          <div style="display: inline-block; width: 56px; height: 56px; line-height: 56px; border-radius: 50%; background: ${urgencyTone}25; border: 1px solid ${urgencyTone}60; font-size: 26px; text-align: center;">
            ⏰
          </div>
          <h2 style="font-size: 22px; font-weight: 900; margin: 14px 0 6px 0; color: #ffffff;">Your ${isTrial ? 'Trial' : 'Subscription'} Ends ${timeText}</h2>
          <p style="color: #a59fb8; font-size: 14px; margin: 0;">Don't let your live QR menu get paused!</p>
        </td>
      </tr>
    </table>

    <div style="background-color: #191428; border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); padding: 22px; margin: 20px 0;">
      <p style="font-size: 15px; color: #e2dcf0; line-height: 1.6; margin: 0 0 14px 0;">
        Hello <strong>${restaurantName}</strong>,
      </p>
      <p style="font-size: 14px; color: #c7c2d6; line-height: 1.6; margin: 0 0 18px 0;">
        Your <strong>${planName}</strong> ${isTrial ? 'free trial' : 'subscription'} will expire <strong>${timeText}</strong>. Once expired, guests scanning your QR standees will not be able to browse dishes or place orders.
      </p>
      <div style="text-align: center; margin: 22px 0;">
        <a href="${renewUrl}" style="display: inline-block; background: linear-gradient(135deg, #E2C792 0%, #C8A96E 100%); color: #161224; font-weight: 800; font-size: 15px; padding: 14px 32px; border-radius: 12px; text-decoration: none; box-shadow: 0 8px 20px rgba(200, 169, 110, 0.35);">
          Renew &amp; Keep Menu Live Now &rarr;
        </a>
      </div>
      <p style="font-size: 12px; color: #8c85a0; margin: 0; line-height: 1.5; text-align: center;">
        Renew in under 60 seconds with instant UPI payment. All categories and settings remain 100% saved.
      </p>
    </div>
  `;

  return sendMail({
    to,
    subject: `⚠️ Important: ${restaurantName} QR Menu expires ${timeText}`,
    html: wrapEmail(content, 'Subscription Expiry Alert', `Your QR Menu Pro access for ${restaurantName} ends ${timeText}.`),
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
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px; text-align: center;">
      <tr>
        <td align="center">
          <div style="display: inline-block; width: 56px; height: 56px; line-height: 56px; border-radius: 50%; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); font-size: 26px; text-align: center;">
            🛡️
          </div>
          <h2 style="font-size: 22px; font-weight: 900; margin: 14px 0 6px 0; color: #ffffff;">Action Required: 3-Day Grace Period Active</h2>
          <p style="color: #f87171; font-size: 14px; margin: 0; font-weight: 700;">${graceDaysLeft} Day${graceDaysLeft > 1 ? 's' : ''} Remaining Before Menu Suspension</p>
        </td>
      </tr>
    </table>

    <div style="background-color: #191428; border-radius: 16px; border: 1px solid rgba(239, 68, 68, 0.35); padding: 22px; margin: 20px 0;">
      <p style="font-size: 15px; color: #e2dcf0; line-height: 1.6; margin: 0 0 12px 0;">
        Hello <strong>${restaurantName}</strong>,
      </p>
      <p style="font-size: 14px; color: #c7c2d6; line-height: 1.6; margin: 0 0 14px 0;">
        Your paid <strong>${planName}</strong> plan has ended. As a valued paid subscriber, we have activated a <strong>3-Day Courtesy Grace Period</strong> so your dining room operations are not disrupted.
      </p>
      <div style="background: rgba(239, 68, 68, 0.12); border-left: 4px solid #ef4444; padding: 12px 16px; border-radius: 8px; margin: 18px 0;">
        <div style="font-size: 13px; color: #fca5a5; font-weight: 700;">Menu Status: STILL LIVE (Temporary)</div>
        <div style="font-size: 12px; color: #e2dcf0; margin-top: 4px;">After ${graceDaysLeft} day${graceDaysLeft > 1 ? 's' : ''}, guest QR scanning will be automatically paused.</div>
      </div>
      <div style="text-align: center; margin: 22px 0;">
        <a href="${renewUrl}" style="display: inline-block; background: linear-gradient(135deg, #f87171 0%, #ef4444 100%); color: #ffffff; font-weight: 800; font-size: 14px; padding: 14px 30px; border-radius: 12px; text-decoration: none;">
          Renew Now to Avoid Interruption &rarr;
        </a>
      </div>
    </div>
  `;

  return sendMail({
    to,
    subject: `🚨 Urgent: 3-Day Grace Period Active for ${restaurantName} (${graceDaysLeft}d left)`,
    html: wrapEmail(content, 'Courtesy Grace Period Active', `3-day courtesy grace period is active for ${restaurantName}.`),
  });
}

/* ---------------- 6. System Verification Test Email ---------------- */
async function sendTestEmail({ to = 'piyushassudani96@gmail.com' } = {}) {
  const istTime = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'medium',
  });

  const content = `
    <!-- Top Hero Badge -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
      <tr>
        <td align="center">
          <div style="display: inline-block; width: 64px; height: 64px; line-height: 64px; border-radius: 50%; background: rgba(52, 211, 153, 0.15); border: 2px solid #34d399; font-size: 32px; text-align: center;">
            ✓
          </div>
          <h1 style="font-size: 26px; font-weight: 900; margin: 16px 0 6px 0; color: #ffffff; letter-spacing: -0.5px;">
            Email System Verified &amp; Active!
          </h1>
          <div style="font-size: 14px; color: #34d399; font-weight: 700;">
            Gmail SMTP Connected · 100% Free Tier Ready
          </div>
        </td>
      </tr>
    </table>

    <!-- Welcome Greeting -->
    <p style="font-size: 16px; color: #e2dcf0; line-height: 1.6; margin: 0 0 16px 0;">
      Hello <strong>Piyush Assudani</strong>,
    </p>
    <p style="font-size: 14px; color: #c7c2d6; line-height: 1.7; margin: 0 0 24px 0;">
      Yeh test email confirm karta hai ki aapka <strong>QR Menu Pro</strong> automated mailing infrastructure successfully connect ho chuka hai. Free Google App Password configuration ke sath ab aapke platform se har event par automatic luxury branded emails deliver honge.
    </p>

    <!-- Configuration Details Card -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #191428; border-radius: 16px; border: 1px dashed rgba(200, 169, 110, 0.4); margin: 0 0 26px 0;">
      <tr>
        <td style="padding: 22px;">
          <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #C8A96E; font-weight: 800; margin-bottom: 14px;">
            SYSTEM SMTP CREDENTIALS &amp; STATUS
          </div>
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="font-size: 13px; line-height: 1.6;">
            <tr>
              <td style="color: #8c85a0; padding: 6px 0;">Sender Address:</td>
              <td style="text-align: right; font-weight: 700; color: #ffffff;">${SENDER_EMAIL()}</td>
            </tr>
            <tr>
              <td style="color: #8c85a0; padding: 6px 0;">Display Name:</td>
              <td style="text-align: right; font-weight: 700; color: #C8A96E;">${SENDER_NAME()}</td>
            </tr>
            <tr>
              <td style="color: #8c85a0; padding: 6px 0;">SMTP Host &amp; Port:</td>
              <td style="text-align: right; color: #38bdf8; font-family: monospace;">smtp.gmail.com:465 (SSL)</td>
            </tr>
            <tr>
              <td style="color: #8c85a0; padding: 6px 0;">Delivered To:</td>
              <td style="text-align: right; font-weight: 700; color: #ffffff;">${to}</td>
            </tr>
            <tr>
              <td style="color: #8c85a0; padding: 6px 0;">Verification Time (IST):</td>
              <td style="text-align: right; color: #c7c2d6;">${istTime}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Active Email Pipeline Checklist -->
    <div style="background-color: #120e1d; border-radius: 14px; border: 1px solid rgba(255,255,255,0.06); padding: 20px; margin-bottom: 26px;">
      <div style="font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; color: #a59fb8; margin-bottom: 12px;">
        Active Automated Pipelines
      </div>
      <div style="font-size: 13px; color: #e2dcf0; line-height: 1.8;">
        <div style="margin-bottom: 6px;"><span style="color: #34d399; font-weight: 900; margin-right: 8px;">✓</span><strong>Email OTP Verification:</strong> 6-digit dynamic codes sent on restaurant registration.</div>
        <div style="margin-bottom: 6px;"><span style="color: #34d399; font-weight: 900; margin-right: 8px;">✓</span><strong>Instant Payment Receipts:</strong> Branded bills with UTR tracking &amp; Ultra Plan upsell.</div>
        <div style="margin-bottom: 6px;"><span style="color: #34d399; font-weight: 900; margin-right: 8px;">✓</span><strong>Expiry Warnings:</strong> Automated alerts sent 3 days &amp; 1 day prior to plan expiration.</div>
        <div><span style="color: #34d399; font-weight: 900; margin-right: 8px;">✓</span><strong>3-Day Grace Period:</strong> Paid restaurants enjoy 3 courtesy days to keep QR live.</div>
      </div>
    </div>

    <!-- CTA Button -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 28px 0 16px 0;">
      <tr>
        <td align="center">
          <a href="https://qrmenu-website-three.vercel.app" style="display: inline-block; background: linear-gradient(135deg, #E2C792 0%, #C8A96E 100%); color: #161224; font-weight: 800; font-size: 15px; padding: 14px 34px; border-radius: 14px; text-decoration: none; box-shadow: 0 10px 25px rgba(200, 169, 110, 0.4); text-transform: uppercase; letter-spacing: 0.5px;">
            Visit QR Menu Pro Live &rarr;
          </a>
        </td>
      </tr>
    </table>

    <p style="font-size: 12px; color: #7f7894; text-align: center; margin: 16px 0 0 0;">
      Zero third-party fees &middot; Fully automated &middot; High inbox delivery rate
    </p>
  `;

  return sendMail({
    to,
    subject: `🚀 [Verified] QR Menu Pro Email System Active · Assudani Developers`,
    html: wrapEmail(content, 'QR Menu Pro Email System Active', 'Official verification test email from QR Menu Pro · Assudani Developers'),
  });
}

module.exports = {
  sendMail,
  sendOtpEmail,
  sendPaymentSubmittedEmail,
  sendPaymentReceiptEmail,
  sendExpiryAlertEmail,
  sendGracePeriodEmail,
  sendTestEmail,
};
