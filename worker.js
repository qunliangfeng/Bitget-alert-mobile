// ================================================================
// 价格播报器 Universal — 授权 + 推荐返佣后端
// 部署到 Cloudflare Workers + KV
// ================================================================
//
// KV 命名空间绑定名称：LICENSES
// 环境变量：
//   ADMIN_SECRET    — 管理员密钥
//   REFERRAL_RATE   — 返佣比例，如 0.3 = 30%（默认30%）
//   TG_BOT_TOKEN    — Telegram Bot Token（用于自动发码）
//   TG_ADMIN_ID     — 管理员 Telegram Chat ID（接收通知）
//
// KV key 结构：
//   license:{CODE}       授权信息
//   email:{EMAIL}        邮箱 → 授权码映射
//   ref:{REF_CODE}       推荐人信息（REF-XXXXXX格式）
//   ref_owner:{LICENSE}  授权码 → 推荐码映射
// ================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateRefCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'REF-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function expiresAt(plan) {
  const now = Date.now();
  if (plan === 'monthly')  return now + 30  * 24 * 3600 * 1000;
  if (plan === 'yearly')   return now + 365 * 24 * 3600 * 1000;
  if (plan === 'lifetime') return now + 100 * 365 * 24 * 3600 * 1000;
  if (plan.startsWith('trial_')) {
    const days = parseInt(plan.split('_')[1]) || 7;
    return now + days * 24 * 3600 * 1000;
  }
  return now + 30 * 24 * 3600 * 1000;
}

function planAmount(plan) {
  if (plan === 'monthly')  return 11.88;
  if (plan === 'yearly')   return 68.88;
  if (plan === 'lifetime') return 499;
  return 0;
}

// ── 路由 ──────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // 公开接口
    if (path === '/verify'        && request.method === 'POST') return handleVerify(request, env);
    if (path === '/activate'      && request.method === 'POST') return handleActivate(request, env);
    if (path === '/ref/info'      && request.method === 'POST') return handleRefInfo(request, env);
    if (path === '/ref/check'     && request.method === 'POST') return handleRefCheck(request, env);
    if (path === '/ref/withdraw'  && request.method === 'POST') return handleRefWithdraw(request, env);

    // 云端设置存储
    if (path === '/settings/save' && request.method === 'POST') return handleSettingsSave(request, env);
    if (path === '/settings/load' && request.method === 'POST') return handleSettingsLoad(request, env);

    // 云端监控接口
    if (path === '/monitor/save' && request.method === 'POST') return handleMonitorSave(request, env);
    if (path === '/monitor/get'  && request.method === 'POST') return handleMonitorGet(request, env);
    if (path === '/monitor/stop' && request.method === 'POST') return handleMonitorStop(request, env);

    // Webhook
    if (path === '/trial/request'    && request.method === 'POST') return handleTrialRequest(request, env);
    if (path === '/tg-webhook'        && request.method === 'POST') return handleTgWebhook(request, env);
    if (path === '/nowpayments-webhook' && request.method === 'POST') return handleNowPaymentsWebhook(request, env);
    if (path === '/webhook/gumroad'  && request.method === 'POST') return handleGumroadWebhook(request, env);
    if (path === '/webhook/aifadian' && request.method === 'POST') return handleAifadianWebhook(request, env);

    // 管理接口
    if (path.startsWith('/admin')) {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ADMIN_SECRET}`) return json({ error: 'Unauthorized' }, 401);
      if (path === '/admin/create'          && request.method === 'POST') return handleAdminCreate(request, env);
      if (path === '/admin/list'            && request.method === 'GET')  return handleAdminList(request, env);
      if (path === '/admin/revoke'          && request.method === 'POST') return handleAdminRevoke(request, env);
      if (path === '/admin/reset-device'    && request.method === 'POST') return handleAdminResetDevice(request, env);
      if (path === '/admin/tg-chatid'       && request.method === 'POST') return handleAdminTgChatId(request, env);
      if (path === '/admin/send-code'        && request.method === 'POST') return handleAdminSendCode(request, env);
      if (path === '/admin/extend'          && request.method === 'POST') return handleAdminExtend(request, env);
      if (path === '/admin/ref/list'        && request.method === 'GET')  return handleAdminRefList(request, env);
      if (path === '/admin/ref/settle'      && request.method === 'POST') return handleAdminRefSettle(request, env);
      if (path === '/admin/ref/create'      && request.method === 'POST') return handleAdminRefCreate(request, env);
      if (path === '/admin/ref/balance'     && request.method === 'POST') return handleAdminRefBalance(request, env);
      if (path === '/admin/ref/deduct'      && request.method === 'POST') return handleAdminRefDeduct(request, env);
      if (path === '/admin/withdraw/list'   && request.method === 'GET')  return handleAdminWithdrawList(request, env);
      if (path === '/admin/withdraw/settle' && request.method === 'POST') return handleAdminWithdrawSettle(request, env);
    }

    return json({ error: 'Not found' }, 404);
  },

  // Cron 触发器 — 每分钟执行一次
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  }
};

// ── /verify ───────────────────────────────────────────────────────
async function handleVerify(request, env) {
  const { code, deviceId } = await request.json();
  if (!code) return json({ valid: false, error: 'missing_code' });
  const raw = await env.LICENSES.get(`license:${code.toUpperCase()}`);
  if (!raw) return json({ valid: false, error: 'invalid_code' });
  const lic = JSON.parse(raw);
  if (lic.status === 'revoked') return json({ valid: false, error: 'revoked' });
  const now = Date.now();
  if (now > lic.expiresAt) return json({ valid: false, error: 'expired', expiredAt: lic.expiresAt });
  if (lic.activated && lic.deviceId && deviceId && lic.deviceId !== deviceId) {
    // 试用码不限设备
    if (!lic.plan.startsWith('trial_')) {
      return json({ valid: false, error: 'device_mismatch' });
    }
  }
  const daysLeft = Math.ceil((lic.expiresAt - now) / 86400000);
  return json({
    valid: true, plan: lic.plan, email: lic.email,
    expiresAt: lic.expiresAt, daysLeft,
    warning: daysLeft <= 7 ? daysLeft : null,
    refCode: lic.refCode || null,
  });
}

// ── /activate ─────────────────────────────────────────────────────
async function handleActivate(request, env) {
  const { code, deviceId, email, referredBy, force } = await request.json();
  if (!code) return json({ success: false, error: 'missing_code' });
  const key = `license:${code.toUpperCase()}`;
  const raw = await env.LICENSES.get(key);
  if (!raw) return json({ success: false, error: 'invalid_code' });
  const lic = JSON.parse(raw);
  if (lic.status === 'revoked') return json({ success: false, error: 'revoked' });
  const now = Date.now();
  if (now > lic.expiresAt) return json({ success: false, error: 'expired' });
  // 试用码不绑定设备；月付/年付允许切换设备（直接覆盖，旧设备自动失效）
  lic.activated   = true;
  lic.activatedAt = lic.activatedAt || now;
  if (lic.plan.startsWith('trial_')) {
    // 试用码：不绑定设备ID，多设备可同时使用
  } else {
    // 付费码：已有其他设备绑定时，需用户确认才切换
    if (lic.deviceId && deviceId && lic.deviceId !== deviceId && !force) {
      return json({ success: false, error: 'device_switch', message: '此激活码已在另一台设备使用，继续将退出那台设备' });
    }
    lic.deviceId = deviceId || lic.deviceId;
  }
  if (email) lic.email = lic.email || email;

  // 处理推荐关系（首次激活 + 非试用）
  if (referredBy && !lic.referredBy && !lic.plan.startsWith('trial_')) {
    const refRaw = await env.LICENSES.get(`ref:${referredBy.toUpperCase()}`);
    if (refRaw) {
      const ref = JSON.parse(refRaw);
      lic.referredBy = referredBy.toUpperCase();
      ref.referrals  = ref.referrals || [];
      if (!ref.referrals.find(r => r.code === code.toUpperCase())) {
        const rate   = parseFloat(env.REFERRAL_RATE || '0.3');
        const amount = planAmount(lic.plan) * rate;
        ref.referrals.push({
          code: code.toUpperCase(), email: lic.email || '',
          plan: lic.plan, amount, settled: false, createdAt: now,
        });
        ref.pendingAmount = (ref.pendingAmount || 0) + amount;
        await env.LICENSES.put(`ref:${referredBy.toUpperCase()}`, JSON.stringify(ref));
      }
    }
  }

  // 自动生成推荐码（激活时获得推荐资格）
  if (!lic.refCode && !lic.plan.startsWith('trial_')) {
    const refCode = generateRefCode();
    lic.refCode   = refCode;
    const refData = {
      refCode, ownerCode: code.toUpperCase(),
      email: lic.email || '', createdAt: now,
      referrals: [], pendingAmount: 0, settledAmount: 0,
    };
    await env.LICENSES.put(`ref:${refCode}`, JSON.stringify(refData));
    await env.LICENSES.put(`ref_owner:${code.toUpperCase()}`, refCode);
  }

  await env.LICENSES.put(key, JSON.stringify(lic));
  const daysLeft = Math.ceil((lic.expiresAt - now) / 86400000);
  return json({
    success: true, plan: lic.plan, email: lic.email,
    expiresAt: lic.expiresAt, daysLeft, refCode: lic.refCode || null,
  });
}

// ── /ref/info ─────────────────────────────────────────────────────
async function handleRefInfo(request, env) {
  const { code } = await request.json();
  if (!code) return json({ error: 'missing_code' });
  const licRaw = await env.LICENSES.get(`license:${code.toUpperCase()}`);
  if (!licRaw) return json({ error: 'invalid_code' });
  const lic = JSON.parse(licRaw);
  if (!lic.refCode) return json({ refCode: null, referrals: [], pendingAmount: 0, settledAmount: 0 });
  const refRaw = await env.LICENSES.get(`ref:${lic.refCode}`);
  if (!refRaw) return json({ refCode: lic.refCode, referrals: [], pendingAmount: 0, settledAmount: 0 });
  const ref = JSON.parse(refRaw);
  return json({
    refCode: lic.refCode,
    referrals: ref.referrals || [],
    pendingAmount: ref.pendingAmount || 0,
    settledAmount: ref.settledAmount || 0,
    totalReferrals: (ref.referrals || []).length,
    settlements: ref.settlements || [],
  });
}

// ── /ref/check ────────────────────────────────────────────────────
async function handleRefCheck(request, env) {
  const { refCode } = await request.json();
  if (!refCode) return json({ valid: false });
  const raw = await env.LICENSES.get(`ref:${refCode.toUpperCase()}`);
  if (!raw) return json({ valid: false });
  return json({ valid: true });
}

// ── Gumroad Webhook ───────────────────────────────────────────────
async function handleGumroadWebhook(request, env) {
  const params   = new URLSearchParams(await request.text());
  const email    = params.get('email') || '';
  const price    = parseInt(params.get('price') || '0');
  const refunded = params.get('refunded') === 'true';
  const licKey   = params.get('license_key') || '';

  if (refunded && licKey) {
    const raw = await env.LICENSES.get(`license:${licKey.toUpperCase()}`);
    if (raw) {
      const lic = JSON.parse(raw); lic.status = 'revoked';
      await env.LICENSES.put(`license:${licKey.toUpperCase()}`, JSON.stringify(lic));
    }
    return json({ ok: true, action: 'revoked' });
  }

  const plan = price >= 5000 ? 'yearly' : 'monthly';
  const code = licKey ? licKey.toUpperCase() : generateCode();
  const lic  = {
    code, email, plan, createdAt: Date.now(), expiresAt: expiresAt(plan),
    activated: false, activatedAt: null, deviceId: null,
    status: 'active', source: 'gumroad', refCode: null, referredBy: null,
  };
  await env.LICENSES.put(`license:${code}`, JSON.stringify(lic));
  if (email) await env.LICENSES.put(`email:${email}`, code);
  return json({ ok: true, code, plan });
}

// ── 爱发电 Webhook ────────────────────────────────────────────────
async function handleAifadianWebhook(request, env) {
  const body   = await request.json();
  const action = body.action;
  const email  = body.data?.sponsor_email || body.data?.email || '';
  const months = parseInt(body.data?.months || '1');

  if (action === 'cancel' || action === 'refund') {
    const code = await env.LICENSES.get(`email:${email}`);
    if (code) {
      const raw = await env.LICENSES.get(`license:${code}`);
      if (raw) {
        const lic = JSON.parse(raw); lic.status = 'revoked';
        await env.LICENSES.put(`license:${code}`, JSON.stringify(lic));
      }
    }
    return json({ ok: true, action: 'revoked' });
  }

  const plan = months >= 12 ? 'yearly' : 'monthly';
  const existingCode = await env.LICENSES.get(`email:${email}`);
  if (existingCode) {
    const raw = await env.LICENSES.get(`license:${existingCode}`);
    if (raw) {
      const lic = JSON.parse(raw);
      lic.expiresAt = Math.max(lic.expiresAt, Date.now()) + months * 30 * 86400000;
      lic.status = 'active';
      await env.LICENSES.put(`license:${existingCode}`, JSON.stringify(lic));
      return json({ ok: true, action: 'renewed', code: existingCode });
    }
  }

  const code = generateCode();
  const lic  = {
    code, email, plan, createdAt: Date.now(), expiresAt: expiresAt(plan),
    activated: false, activatedAt: null, deviceId: null,
    status: 'active', source: 'aifadian', refCode: null, referredBy: null,
  };
  await env.LICENSES.put(`license:${code}`, JSON.stringify(lic));
  await env.LICENSES.put(`email:${email}`, code);
  return json({ ok: true, code, plan });
}

// ── 管理接口 ──────────────────────────────────────────────────────
// ── Telegram Webhook（记录 username → chat_id）────────────────────
async function handleTgWebhook(request, env) {
  const data = await request.json();
  const msg = data.message || data.edited_message;
  if (!msg) return json({ ok: true });

  const chatId   = msg.chat?.id;
  const username = msg.from?.username;
  const text     = msg.text || '';

  // 存储 username → chat_id 映射
  if (chatId && username) {
    await env.LICENSES.put(`tg_user:${username.toLowerCase()}`, String(chatId), { expirationTtl: 86400 * 365 });
  }

  // 响应 /start 命令
  if (text.startsWith('/start') && chatId && env.TG_BOT_TOKEN) {
    const welcome = `👋 你好！我是西本聪播报机器人助手。

你已成功启动，现在可以：
• 去落地页领取 7 天免费试用激活码
• 购买后激活码将自动发送到这里

📢 播报器地址：
https://qunliangfeng.github.io/Bitget-alert-mobile/crypto-universal-alert-mobile.html`;

    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: welcome })
    });
  }

  return json({ ok: true });
}

// ── 试用申请自动发码 ──────────────────────────────────────────────
async function handleTrialRequest(request, env) {
  const { tg, email } = await request.json();
  if (!tg && !email) return json({ success: false, error: 'missing_contact' }, 400);

  // 防重复：同一 TG、邮箱、IP 每7天最多申请一次
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const ipKey    = `trial_ip:${ip.replace(/[^0-9a-fA-F:.]/g,'_')}`;
  const dedupKey = `trial_req:${(tg||email).replace(/[^a-zA-Z0-9@.]/g,'_')}`;

  const [existingContact, existingIp] = await Promise.all([
    env.LICENSES.get(dedupKey),
    env.LICENSES.get(ipKey),
  ]);
  if (existingContact) return json({ success: false, error: 'already_requested', message: '你已申请过试用，请检查你的 Telegram 或邮箱' });
  if (existingIp)      return json({ success: false, error: 'already_requested', message: '该设备已申请过试用，如需帮助请联系客服' });

  // 创建 7 天激活码
  const code = generateCode();
  const lic = {
    code, email: email||'', plan: 'trial_7',
    createdAt: Date.now(), expiresAt: expiresAt('trial_7'),
    activated: false, activatedAt: null, deviceId: null,
    status: 'active', source: 'trial', note: `TG:${tg||''} Email:${email||''}`,
    refCode: null, referredBy: null,
  };
  await env.LICENSES.put(`license:${code}`, JSON.stringify(lic));
  if (email) await env.LICENSES.put(`email:${email}`, code);

  // 标记已申请（7天防重复）
  const sevenDays = 7 * 86400;
  await Promise.all([
    env.LICENSES.put(dedupKey, '1', { expirationTtl: sevenDays }),
    env.LICENSES.put(ipKey,    '1', { expirationTtl: sevenDays }),
  ]);

  // 发送激活码到用户 TG
  const botToken = env.TG_BOT_TOKEN;
  const adminId  = env.TG_ADMIN_ID;
  const expireDate = new Date(lic.expiresAt).toLocaleDateString('zh-CN');

  if (botToken && tg) {
    const username = tg.replace('@','').toLowerCase();
    // 查找存储的 chat_id
    const chatId = await env.LICENSES.get(`tg_user:${username}`);
    const tgMsg = `🎉 西本聪播报机器人 — 7天试用激活码

激活码：${code}
有效期至：${expireDate}

使用方法：
1. 打开播报器
2. 点击激活码输入框
3. 输入以上激活码

如有问题请联系 @qunliangfeng`;
    if (chatId) {
      // 有 chat_id，直接发送
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: tgMsg })
      });
    }
    // 无论是否发送成功，管理员都会收到通知含激活码
  }

  // 通知管理员
  if (botToken && adminId) {
    const adminMsg = `🎁 新试用申请已自动处理\nTG: ${tg||'—'}\n邮箱: ${email||'—'}\n激活码: ${code}\n有效期: ${expireDate}`;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text: adminMsg })
    });
  }

  return json({ success: true, code, message: '激活码已发送，请检查 Telegram' });
}

// ── NOWPayments Webhook 自动发码 ──────────────────────────────────
async function handleNowPaymentsWebhook(request, env) {
  // ── 1. HMAC-SHA512 签名验证 ──────────────────────────────────────
  // NowPayments 在 x-nowpayments-sig 头发送签名
  // 签名 = HMAC-SHA512(按 key 排序后的 JSON, IPN_SECRET_KEY)
  const ipnSecret = env.NOWPAYMENTS_IPN_KEY;
  if (ipnSecret) {
    const sigHeader = request.headers.get('x-nowpayments-sig');
    if (!sigHeader) return json({ error: 'missing_signature' }, 401);

    const rawBody = await request.text();
    // 按 key 排序重新序列化（NowPayments 要求）
    let sortedBody;
    try {
      const parsed = JSON.parse(rawBody);
      sortedBody = JSON.stringify(parsed, Object.keys(parsed).sort());
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    // 计算 HMAC-SHA512
    const encoder = new TextEncoder();
    const keyData = encoder.encode(ipnSecret);
    const msgData = encoder.encode(sortedBody);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
    );
    const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
    const sigHex = Array.from(new Uint8Array(sigBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    if (sigHex.toLowerCase() !== sigHeader.toLowerCase()) {
      return json({ error: 'invalid_signature' }, 401);
    }

    var data = JSON.parse(sortedBody);
  } else {
    // 没有配置 IPN_KEY 时降级（开发/测试用），生产必须配置
    var data = await request.json().catch(() => null);
    if (!data) return json({ error: 'invalid_json' }, 400);
  }

  // ── 2. 只处理已完成支付 ──────────────────────────────────────────
  if (data.payment_status !== 'finished' && data.payment_status !== 'confirmed') {
    return json({ received: true });
  }

  // ── 3. payment_id 去重，防止重复回调生成多个激活码 ────────────────
  const paymentId = String(data.payment_id || '');
  if (!paymentId) return json({ error: 'missing_payment_id' }, 400);

  const dedupKey = `payment:${paymentId}`;
  const alreadyProcessed = await env.LICENSES.get(dedupKey);
  if (alreadyProcessed) {
    // 已处理过，直接返回成功（幂等）
    return json({ received: true, duplicate: true });
  }
  // 标记为已处理（保留365天）
  await env.LICENSES.put(dedupKey, String(Date.now()), { expirationTtl: 365 * 86400 });

  const desc = data.order_description || '';
  // 从 order_description 提取 TG 和 Email
  const tgMatch = desc.match(/TG:(@?\S+)/);
  const emailMatch = desc.match(/Email:(\S+@\S+)/);
  const refMatch = desc.match(/Ref:(REF-[A-Z0-9]+)/);
  const tg = tgMatch ? tgMatch[1] : '';
  const email = emailMatch ? emailMatch[1] : '';
  const referredBy = refMatch ? refMatch[1] : '';

  // 根据金额判断套餐
  const amount = parseFloat(data.price_amount || 0);
  // 月付 11.88，年付 68.88，以 40 USDT 为分界线避免误判
  const plan = amount >= 40 ? 'yearly' : 'monthly';

  // 创建激活码
  const code = generateCode();
  const lic = {
    code, email: email||'', plan,
    createdAt: Date.now(), expiresAt: expiresAt(plan),
    activated: false, activatedAt: null, deviceId: null,
    status: 'active', source: 'nowpayments',
    note: `TG:${tg} Email:${email} PayID:${data.payment_id}`,
    refCode: null, referredBy: referredBy || null,
  };
  await env.LICENSES.put(`license:${code}`, JSON.stringify(lic));
  if (email) await env.LICENSES.put(`email:${email}`, code);

  const botToken = env.TG_BOT_TOKEN;
  const adminId  = env.TG_ADMIN_ID;
  const expireDate = new Date(lic.expiresAt).toLocaleDateString('zh-CN');
  const planName = plan === 'yearly' ? '年付套餐' : '月付套餐';

  // 发送激活码给用户
  if (botToken && tg) {
    const username = tg.replace('@','').toLowerCase();
    const chatId = await env.LICENSES.get(`tg_user:${username}`);
    const msg = `✅ 付款成功！西本聪播报机器人${planName}

激活码：${code}
有效期至：${expireDate}

使用方法：打开播报器输入激活码即可
如有问题请联系 @qunliangfeng`;
    if (chatId) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg })
      });
    }
  }

  // 通知管理员
  if (botToken && adminId) {
    const adminMsg = `💰 收到付款！\n套餐: ${planName}\nTG: ${tg||'—'}\n邮箱: ${email||'—'}\n金额: ${data.price_amount} USDT\n激活码: ${code}`;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminId, text: adminMsg })
    });
  }

  return json({ success: true });
}

async function handleAdminCreate(request, env) {
  const { email, plan, note } = await request.json();
  const code = generateCode();
  const lic  = {
    code, email: email||'', plan: plan||'monthly',
    createdAt: Date.now(), expiresAt: expiresAt(plan||'monthly'),
    activated: false, activatedAt: null, deviceId: null,
    status: 'active', source: 'manual', note: note||'',
    refCode: null, referredBy: null,
  };
  await env.LICENSES.put(`license:${code}`, JSON.stringify(lic));
  if (email) await env.LICENSES.put(`email:${email}`, code);
  return json({ success: true, code, expiresAt: lic.expiresAt });
}

async function handleAdminList(request, env) {
  const url    = new URL(request.url);
  const cursor = url.searchParams.get('cursor') || undefined;
  const result = await env.LICENSES.list({ prefix: 'license:', cursor, limit: 100 });
  const licenses = [];
  for (const key of result.keys) {
    const raw = await env.LICENSES.get(key.name);
    if (raw) licenses.push(JSON.parse(raw));
  }
  return json({ licenses, cursor: result.cursor, complete: result.list_complete });
}

async function handleAdminRevoke(request, env) {
  const { code } = await request.json();
  const key = `license:${code.toUpperCase()}`;
  const raw = await env.LICENSES.get(key);
  if (!raw) return json({ success: false, error: 'not_found' });
  const lic = JSON.parse(raw); lic.status = 'revoked';
  await env.LICENSES.put(key, JSON.stringify(lic));
  return json({ success: true });
}

async function handleAdminExtend(request, env) {
  const { code, days } = await request.json();
  const key = `license:${code.toUpperCase()}`;
  const raw = await env.LICENSES.get(key);
  if (!raw) return json({ success: false, error: 'not_found' });
  const lic = JSON.parse(raw);
  lic.expiresAt = Math.max(lic.expiresAt, Date.now()) + (days||30) * 86400000;
  lic.status = 'active';
  await env.LICENSES.put(key, JSON.stringify(lic));
  return json({ success: true, expiresAt: lic.expiresAt });
}

async function handleAdminRefList(request, env) {
  const result = await env.LICENSES.list({ prefix: 'ref:REF-', limit: 100 });
  const refs = [];
  for (const key of result.keys) {
    const raw = await env.LICENSES.get(key.name);
    if (raw) refs.push(JSON.parse(raw));
  }
  refs.sort((a, b) => (b.pendingAmount||0) - (a.pendingAmount||0));
  return json({ refs });
}

async function handleAdminRefSettle(request, env) {
  const { refCode, amount, note } = await request.json();
  const key = `ref:${refCode.toUpperCase()}`;
  const raw = await env.LICENSES.get(key);
  if (!raw) return json({ success: false, error: 'not_found' });
  const ref = JSON.parse(raw);
  const amt = amount || ref.pendingAmount || 0;
  ref.settledAmount = (ref.settledAmount||0) + amt;
  ref.pendingAmount = Math.max(0, (ref.pendingAmount||0) - amt);
  ref.settlements   = ref.settlements || [];
  ref.settlements.push({ amount: amt, note: note||'', settledAt: Date.now() });
  ref.referrals = (ref.referrals||[]).map(r => ({ ...r, settled: true }));
  await env.LICENSES.put(key, JSON.stringify(ref));
  return json({ success: true, settledAmount: ref.settledAmount, pendingAmount: ref.pendingAmount });
}

async function handleAdminRefCreate(request, env) {
  const { licenseCode, email } = await request.json();
  const refCode = generateRefCode();
  const refData = {
    refCode, ownerCode: licenseCode||'manual',
    email: email||'', createdAt: Date.now(),
    referrals: [], pendingAmount: 0, settledAmount: 0,
  };
  await env.LICENSES.put(`ref:${refCode}`, JSON.stringify(refData));
  if (licenseCode) {
    const key = `license:${licenseCode.toUpperCase()}`;
    const raw = await env.LICENSES.get(key);
    if (raw) {
      const lic = JSON.parse(raw); lic.refCode = refCode;
      await env.LICENSES.put(key, JSON.stringify(lic));
    }
  }
  return json({ success: true, refCode });
}

// ── 查询推荐人余额（用邮箱或推荐码查询）────────────────────────────
async function handleAdminRefBalance(request, env) {
  const { refCode, email } = await request.json();
  let ref = null;

  if (refCode) {
    const raw = await env.LICENSES.get(`ref:${refCode.toUpperCase()}`);
    if (raw) ref = JSON.parse(raw);
  } else if (email) {
    // 通过邮箱找到激活码，再找推荐码
    const code = await env.LICENSES.get(`email:${email}`);
    if (code) {
      const licRaw = await env.LICENSES.get(`license:${code}`);
      if (licRaw) {
        const lic = JSON.parse(licRaw);
        if (lic.refCode) {
          const refRaw = await env.LICENSES.get(`ref:${lic.refCode}`);
          if (refRaw) ref = JSON.parse(refRaw);
        }
      }
    }
  }

  if (!ref) return json({ success: false, error: 'not_found' });
  return json({
    success: true,
    refCode: ref.refCode,
    email: ref.email,
    pendingAmount: ref.pendingAmount || 0,
    settledAmount: ref.settledAmount || 0,
    totalReferrals: (ref.referrals||[]).length,
  });
}

// ── 余额抵扣生成激活码 ────────────────────────────────────────────
async function handleAdminRefDeduct(request, env) {
  const { refCode, plan, note } = await request.json();
  if (!refCode || !plan) return json({ success: false, error: 'missing_params' });

  const refKey = `ref:${refCode.toUpperCase()}`;
  const refRaw = await env.LICENSES.get(refKey);
  if (!refRaw) return json({ success: false, error: 'ref_not_found' });

  const ref = JSON.parse(refRaw);
  const cost = planAmount(plan); // 套餐原价
  const pending = ref.pendingAmount || 0;

  if (pending < cost) {
    return json({
      success: false,
      error: 'insufficient_balance',
      message: `余额不足：当前 $${pending.toFixed(2)}，需要 $${cost}`,
      pendingAmount: pending,
      required: cost,
    });
  }

  // 扣减余额
  ref.pendingAmount = Math.max(0, pending - cost);
  ref.settledAmount = (ref.settledAmount || 0) + cost;
  ref.settlements = ref.settlements || [];
  ref.settlements.push({
    amount: cost, note: note || `余额抵扣 ${plan} 激活码`,
    settledAt: Date.now(), type: 'deduct',
  });
  await env.LICENSES.put(refKey, JSON.stringify(ref));

  // 生成新激活码
  const code = generateCode();
  const lic = {
    code, email: ref.email || '', plan,
    createdAt: Date.now(), expiresAt: expiresAt(plan),
    activated: false, activatedAt: null, deviceId: null,
    status: 'active', source: 'balance_deduct',
    note: note || `余额抵扣 by ${refCode}`,
    refCode: null, referredBy: null,
  };
  await env.LICENSES.put(`license:${code}`, JSON.stringify(lic));
  if (ref.email) await env.LICENSES.put(`email:${ref.email}`, code);

  return json({
    success: true, code,
    plan, expiresAt: lic.expiresAt,
    deducted: cost,
    remainingBalance: ref.pendingAmount,
    message: `已扣减 $${cost}，剩余余额 $${ref.pendingAmount.toFixed(2)}`,
  });
}

// ================================================================
// 云端监控 — 用户上传监控设置，Cron 每分钟检查价格并推送
// ================================================================

// 保存监控设置
async function handleMonitorSave(request, env) {
  const { licenseCode, settings } = await request.json();
  if (!licenseCode || !settings) return json({ error: 'missing_params' }, 400);

  // 验证激活码有效
  const raw = await env.LICENSES.get(`license:${licenseCode.toUpperCase()}`);
  if (!raw) return json({ error: 'invalid_license' }, 401);
  const lic = JSON.parse(raw);
  if (lic.status === 'revoked' || Date.now() > lic.expiresAt)
    return json({ error: 'license_expired' }, 401);

  const monitorData = {
    licenseCode: licenseCode.toUpperCase(),
    updatedAt: Date.now(),
    enabled: true,
    tgToken: settings.tgToken || '',
    tgChatId: settings.tgChatId || '',
    tgOn: settings.tgOn !== false,
    coins: (settings.coins || []).map(c => ({
      id: c.id, sym: c.sym,
      exchange: c.exchange || 'bitget',
      mktType: c.mktType || 'spot',
      fixedOn: c.fixedOn,    fixedStep: c.fixedStep,
      lastLevel: c.lastLevel || 0,
      targetOn: c.targetOn,  target: c.target,
      farStep: c.farStep,    nearStep: c.nearStep, nearDist: c.nearDist,
      pointOn: c.pointOn,    points: c.points || [],
    })),
  };

  await env.LICENSES.put(
    `monitor:${licenseCode.toUpperCase()}`,
    JSON.stringify(monitorData),
    { expirationTtl: 30 * 24 * 3600 } // 30天后自动删除
  );

  // 维护监控索引（避免 Cron 使用 list() 消耗配额）
  const idxRaw = await env.LICENSES.get('monitor_index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  const code = licenseCode.toUpperCase();
  if (!idx.includes(code)) {
    idx.push(code);
    await env.LICENSES.put('monitor_index', JSON.stringify(idx), { expirationTtl: 60 * 24 * 3600 });
  }

  return json({ success: true });
}

// 获取监控状态
async function handleMonitorGet(request, env) {
  const { licenseCode } = await request.json();
  if (!licenseCode) return json({ error: 'missing_params' });
  const raw = await env.LICENSES.get(`monitor:${licenseCode.toUpperCase()}`);
  if (!raw) return json({ enabled: false });
  return json({ enabled: true, ...JSON.parse(raw) });
}

// 停止监控
async function handleMonitorStop(request, env) {
  const { licenseCode } = await request.json();
  if (!licenseCode) return json({ error: 'missing_params' });
  const code = licenseCode.toUpperCase();
  await env.LICENSES.delete(`monitor:${code}`);
  // Remove from index
  const idxRaw = await env.LICENSES.get('monitor_index');
  if (idxRaw) {
    const idx = JSON.parse(idxRaw).filter(c => c !== code);
    await env.LICENSES.put('monitor_index', JSON.stringify(idx), { expirationTtl: 60 * 24 * 3600 });
  }
  return json({ success: true });
}

// 获取价格（支持现货和永续合约）
async function fetchPrice(sym, exchange, mktType) {
  try {
    let url, parser;
    const isSpot = !mktType || mktType === 'spot';
    switch (exchange) {
      case 'binance':
        if (isSpot) {
          url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`;
        } else {
          url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`;
        }
        parser = d => parseFloat(d.price);
        break;
      case 'okx':
        if (isSpot) {
          url = `https://www.okx.com/api/v5/market/ticker?instId=${sym.replace('USDT','-USDT')}`;
        } else {
          url = `https://www.okx.com/api/v5/market/ticker?instId=${sym.replace('USDT','-USDT')}-SWAP`;
        }
        parser = d => parseFloat(d.data?.[0]?.last);
        break;
      case 'bybit':
        if (isSpot) {
          url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`;
        } else {
          url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`;
        }
        parser = d => parseFloat(d.result?.list?.[0]?.lastPrice);
        break;
      default: // bitget
        if (isSpot) {
          url = `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}`;
          parser = d => parseFloat(d.data?.[0]?.lastPr || d.data?.[0]?.close);
        } else {
          url = `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${sym}&productType=USDT-FUTURES`;
          parser = d => parseFloat(d.data?.lastPr);
        }
    }
    const res = await fetch(url, { headers: { 'User-Agent': 'XiBenCong/1.0' } });
    const data = await res.json();
    return parser(data) || 0;
  } catch(_) { return 0; }
}

// 发送 Telegram 消息
async function sendTelegram(token, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch(_) {}
}

// Cron 主函数 — 每分钟执行
async function runMonitor(env) {
  // 用索引读取所有监控key，避免使用 list() 消耗KV配额
  const idxRaw = await env.LICENSES.get('monitor_index');
  if (!idxRaw) return;
  const codes = JSON.parse(idxRaw);
  if (!codes.length) return;

  const now = Date.now();
  const timeStr = new Date(now).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  for (const code of codes) {
    try {
      const raw = await env.LICENSES.get(`monitor:${code}`);
      if (!raw) continue;
      const monitor = JSON.parse(raw);
      if (!monitor.enabled) continue;
      if (!monitor.tgToken || !monitor.tgChatId) continue;
      if (!monitor.coins || !monitor.coins.length) continue;

      let changed = false;

      for (const coin of monitor.coins) {
        const price = await fetchPrice(coin.sym, coin.exchange, coin.mktType);
        if (!price) continue;

        const prev = coin.lastLevel || price;

        // ── 固定梯度播报 ──
        if (coin.fixedOn && coin.fixedStep > 0) {
          const curLevel  = Math.floor(price / coin.fixedStep) * coin.fixedStep;
          const prevLevel = Math.floor(prev  / coin.fixedStep) * coin.fixedStep;
          if (curLevel !== prevLevel) {
            const isUp = price > prev;
            const msg = `${isUp?'📈':'📉'} *${coin.id}/USDT* ${isUp?'上穿':'下穿'} \`$${curLevel.toLocaleString()}\`\n当前：\`$${price.toLocaleString()}\`\n🕐 ${timeStr} _(云端播报)_`;
            await sendTelegram(monitor.tgToken, monitor.tgChatId, msg);
            changed = true;
          }
        }

        // ── 目标价临近播报 ──
        if (coin.targetOn && coin.target > 0) {
          const dist = Math.abs(price - coin.target);
          const isNear = dist <= coin.nearDist;
          const step = isNear ? coin.nearStep : coin.farStep;
          if (step > 0) {
            const curLevel  = Math.floor(price / step) * step;
            const prevLevel = Math.floor(prev  / step) * step;
            if (curLevel !== prevLevel) {
              const isUp = price > prev;
              const msg = `${isNear?'⚠️':'🎯'} *${coin.id}/USDT* ${isUp?'上穿':'下穿'} \`$${curLevel.toLocaleString()}\`\n目标价：\`$${coin.target}\` · 距离：\`$${dist.toFixed(2)}\`\n🕐 ${timeStr} _(云端播报)_`;
              await sendTelegram(monitor.tgToken, monitor.tgChatId, msg);
              changed = true;
            }
          }
        }

        // ── 定点价格播报 ──
        if (coin.pointOn && coin.points) {
          for (const pt of coin.points) {
            if (!pt.price || pt.price <= 0) continue;
            const crossed = (prev < pt.price && price >= pt.price) || (prev > pt.price && price <= pt.price);
            if (crossed) {
              const isUp = price >= pt.price;
              const msg = `📌 *${coin.id}/USDT* 到达定点价格 \`$${pt.price}\`\n当前：\`$${price.toLocaleString()}\`\n🕐 ${timeStr} _(云端播报)_`;
              // 重复发送
              for (let i = 0; i < (pt.repeat || 3); i++) {
                await sendTelegram(monitor.tgToken, monitor.tgChatId, msg);
                if (i < (pt.repeat||3)-1) await new Promise(r => setTimeout(r, 3000));
              }
              changed = true;
            }
          }
        }

        // 更新最后价格
        coin.lastLevel = price;
        changed = true;
      }

      // 保存更新后的状态
      if (changed) {
        await env.LICENSES.put(key.name, JSON.stringify(monitor), { expirationTtl: 30 * 24 * 3600 });
      }
    } catch(e) {
      console.error('Monitor error:', key.name, e.message);
    }
  }
}

// ── 云端设置存储 ──────────────────────────────────────────────────
async function handleSettingsSave(request, env) {
  try {
    const { licenseCode, settings } = await request.json();
    if (!licenseCode || !settings) return json({ error: 'missing_params' }, 400);

    // 验证激活码
    const raw = await env.LICENSES.get(`license:${licenseCode.toUpperCase()}`);
    if (!raw) return json({ error: 'invalid_license' }, 401);
    const lic = JSON.parse(raw);
    if (lic.status === 'revoked') return json({ error: 'revoked' }, 401);

    // 保存设置，TTL 365天
    await env.LICENSES.put(
      `settings:${licenseCode.toUpperCase()}`,
      JSON.stringify({ ...settings, savedAt: Date.now() }),
      { expirationTtl: 365 * 24 * 3600 }
    );
    return json({ success: true });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

async function handleSettingsLoad(request, env) {
  try {
    const { licenseCode } = await request.json();
    if (!licenseCode) return json({ error: 'missing_params' }, 400);

    // 验证激活码
    const raw = await env.LICENSES.get(`license:${licenseCode.toUpperCase()}`);
    if (!raw) return json({ error: 'invalid_license' }, 401);

    // 读取设置
    const settingsRaw = await env.LICENSES.get(`settings:${licenseCode.toUpperCase()}`);
    if (!settingsRaw) return json({ success: true, settings: null });
    return json({ success: true, settings: JSON.parse(settingsRaw) });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// ── 提现申请 ──────────────────────────────────────────────────────
async function handleRefWithdraw(request, env) {
  try {
    const { code, wallet, amount } = await request.json();
    if (!code || !wallet || !amount) return json({ error: 'missing_params' }, 400);

    const licRaw = await env.LICENSES.get(`license:${code.toUpperCase()}`);
    if (!licRaw) return json({ error: 'invalid_license' }, 401);
    const lic = JSON.parse(licRaw);
    if (!lic.refCode) return json({ error: 'no_ref_code' }, 400);

    const refRaw = await env.LICENSES.get(`ref:${lic.refCode}`);
    if (!refRaw) return json({ error: 'no_ref_data' }, 400);
    const ref = JSON.parse(refRaw);

    const pending = ref.pendingAmount || 0;
    if (amount > pending) return json({ error: 'insufficient_balance', pending }, 400);
    if (amount < 5) return json({ error: 'min_amount', min: 5 }, 400);

    // 扣除待结算余额，记录提现申请
    ref.pendingAmount = parseFloat((pending - amount).toFixed(2));
    ref.withdrawals = ref.withdrawals || [];
    const wid = `W${Date.now()}`;
    ref.withdrawals.push({
      id: wid, wallet, amount, status: 'pending',
      createdAt: Date.now(), note: ''
    });
    await env.LICENSES.put(`ref:${lic.refCode}`, JSON.stringify(ref));

    // 通知管理员 TG
    const isDeduct = wallet.startsWith('DEDUCT:');
    const planLabel = wallet === 'DEDUCT:monthly' ? '月付(11.88)' : wallet === 'DEDUCT:yearly' ? '年付(68.88)' : '';
    const adminMsg = isDeduct
      ? `🎟️ 余额抵扣申请\n推荐码: ${lic.refCode}\n套餐: ${planLabel}\n扣除: ${amount} USDT\n申请ID: ${wid}\n\n请在后台生成激活码发给用户`
      : `💸 提现申请\n推荐码: ${lic.refCode}\n钱包: ${wallet}\n金额: ${amount} USDT\n申请ID: ${wid}`;
    if (env.TG_BOT_TOKEN && env.TG_ADMIN_CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TG_ADMIN_CHAT_ID, text: adminMsg })
      });
    }

    return json({ success: true, withdrawalId: wid, remainingPending: ref.pendingAmount });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// 管理员：查看所有提现申请
async function handleAdminWithdrawList(request, env) {
  try {
    const list = await env.LICENSES.list({ prefix: 'ref:' });
    const results = [];
    for (const key of list.keys) {
      const raw = await env.LICENSES.get(key.name);
      if (!raw) continue;
      const ref = JSON.parse(raw);
      if (!ref.withdrawals || ref.withdrawals.length === 0) continue;
      for (const w of ref.withdrawals) {
        results.push({ refCode: ref.refCode || key.name.replace('ref:',''), ...w });
      }
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    return json({ withdrawals: results });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// 管理员：标记提现已打款
async function handleAdminWithdrawSettle(request, env) {
  try {
    const { refCode, withdrawalId } = await request.json();
    if (!refCode || !withdrawalId) return json({ error: 'missing_params' }, 400);

    const refRaw = await env.LICENSES.get(`ref:${refCode}`);
    if (!refRaw) return json({ error: 'not_found' }, 404);
    const ref = JSON.parse(refRaw);

    const w = (ref.withdrawals || []).find(x => x.id === withdrawalId);
    if (!w) return json({ error: 'withdrawal_not_found' }, 404);

    w.status = 'settled';
    w.settledAt = Date.now();
    ref.settledAmount = parseFloat(((ref.settledAmount || 0) + w.amount).toFixed(2));
    await env.LICENSES.put(`ref:${refCode}`, JSON.stringify(ref));

    return json({ success: true });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// ── 管理员：重置设备绑定 ──────────────────────────────────────────
async function handleAdminResetDevice(request, env) {
  try {
    const { code } = await request.json();
    if (!code) return json({ error: 'missing_params' }, 400);
    const key = `license:${code.toUpperCase()}`;
    const raw = await env.LICENSES.get(key);
    if (!raw) return json({ error: 'not_found' }, 404);
    const lic = JSON.parse(raw);
    delete lic.deviceId;
    await env.LICENSES.put(key, JSON.stringify(lic));
    return json({ ok: true });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// ── 管理员：查询 TG chat_id ───────────────────────────────────────
async function handleAdminTgChatId(request, env) {
  try {
    const { username } = await request.json();
    if (!username) return json({ error: 'missing_params' }, 400);
    const chatId = await env.LICENSES.get(`tg_user:${username.toLowerCase()}`);
    if (!chatId) return json({ chatId: null, error: 'not_found' });
    return json({ chatId });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}

// ── 管理员：手动发送激活码给用户 TG ──────────────────────────────
async function handleAdminSendCode(request, env) {
  try {
    const { tg, code, plan } = await request.json();
    if (!tg || !code) return json({ error: 'missing_params' }, 400);

    const botToken = env.TG_BOT_TOKEN;
    if (!botToken) return json({ sent: false, error: 'no_bot_token' });

    const username = tg.replace('@','').toLowerCase();
    const chatId = await env.LICENSES.get(`tg_user:${username}`);
    if (!chatId) return json({ sent: false, error: 'user_not_found' });

    const licRaw = await env.LICENSES.get(`license:${code.toUpperCase()}`);
    const lic = licRaw ? JSON.parse(licRaw) : null;
    const expireDate = lic ? new Date(lic.expiresAt).toLocaleDateString('zh-CN') : '';
    const planName = plan === 'yearly' ? '年付套餐' : '月付套餐';

    const msg = `✅ 付款已确认！西本聪播报机器人${planName}\n\n激活码：${code}\n有效期至：${expireDate}\n\n👇 点击直接激活：\nhttps://qunliangfeng.github.io/Bitget-alert-mobile/xibencong-success.html?code=${code}\n\n如有问题请联系 @qunliangfeng`;

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg })
    });
    const result = await res.json();
    return json({ sent: result.ok, chatId });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}
