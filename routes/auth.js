
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { sendResetPasswordEmail } = require('../lib/mailer.js');
const router = express.Router();
 
// ==========================================
// 1. КОНФІГУРАЦІЯ СЕРВЕРА
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET;
const IDENTITY_HASH_SECRET = process.env.IDENTITY_HASH_SECRET;
 
if (!JWT_SECRET || !IDENTITY_HASH_SECRET) {
  throw new Error('КРИТИЧНА ПОМИЛКА: JWT_SECRET або IDENTITY_HASH_SECRET не задані в .env!');
}
 
const IS_PROD = process.env.NODE_ENV === 'production';
 
// Якщо фронтенд і бекенд на РІЗНИХ доменах (наприклад, vercel.app і onrender.com),
// постав CROSS_SITE_COOKIES=true — тоді cookie йтимуть із SameSite=None; Secure.
// Надійніше — проксіювати API через домен фронтенду (rewrite) і лишити false.
const CROSS_SITE_COOKIES = process.env.CROSS_SITE_COOKIES === 'true';
 
// Налаштування Дії (id.gov.ua). Беруться з .env після підключення до ІСЕІ.
const DIIA_BASE_URL = (process.env.DIIA_BASE_URL || '').replace(/\/+$/, '');
const DIIA_CLIENT_ID = process.env.DIIA_CLIENT_ID || '';
const DIIA_CLIENT_SECRET = process.env.DIIA_CLIENT_SECRET || '';
const DIIA_REDIRECT_URI = process.env.DIIA_REDIRECT_URI || '';
// Які поля просимо в ІСЕІ. Можна змінити через .env, якщо ваш договір дозволяє більше (наприклад, email).
const DIIA_USER_FIELDS =
  process.env.DIIA_USER_FIELDS || 'id,drfocode,givenname,lastname,middlename,phone';
const DIIA_TIMEOUT_MS = 10_000;
 
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://petitions-frontend.vercel.app';
 
const ACCESS_TOKEN_EXPIRES = '1d';
const SALT_ROUNDS = 12;
const ISSUER = 'petitions-api';
const AUDIENCE = 'petitions-web';
 
function isDiiaConfigured() {
  return Boolean(DIIA_BASE_URL && DIIA_CLIENT_ID && DIIA_CLIENT_SECRET && DIIA_REDIRECT_URI);
}
 
// ==========================================
// 2. RATE LIMITING
// ==========================================
// УВАГА: за проксі (Render, Railway, Vercel тощо) у app.js обов'язково має бути:
//   app.set('trust proxy', 1);
// інакше всі користувачі матимуть один IP і лімітер заблокує всіх разом.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Забагато спроб. Зачекайте 15 хвилин.' },
  standardHeaders: true,
  legacyHeaders: false,
});
 
// ==========================================
// 3. СХЕМИ ВАЛІДАЦІЇ (ZOD)
// ==========================================
const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'Некоректний email' }),
  password: z.string().min(8, { message: 'Пароль має бути не менше 8 символів' }).max(128),
  lastName: z.string().trim().min(1, { message: 'Вкажіть прізвище' }).max(50),
  firstName: z.string().trim().min(1, { message: 'Вкажіть ім’я' }).max(50),
  middleName: z.string().trim().max(50).optional().nullable(),
  phone: z.string().trim().optional().nullable(),
});
 
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
 
const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
  adminSecret: z.string().min(1).max(256),
});
 
const mockDiiaSchema = z.object({
  rnokpp: z.string().regex(/^\d{10}$/, { message: 'РНОКПП має складатися рівно з 10 цифр' }),
  lastName: z.string().trim().min(1).max(50),
  firstName: z.string().trim().min(1).max(50),
  middleName: z.string().trim().max(50).optional().nullable(),
  email: z.string().trim().toLowerCase().email().optional().nullable(),
});
 
const idGovCallbackSchema = z.object({
  code: z.string().min(1, { message: 'Авторизаційний код відсутній' }),
  state: z.string().min(1, { message: 'Параметр state відсутній' }),
});
 
const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'Вкажіть коректну email адресу' }),
});
 
const resetPasswordSchema = z.object({
  token: z.string().min(1, { message: 'Токен обов’язковий' }),
  newPassword: z.string().min(8, { message: 'Новий пароль має бути не менше 8 символів' }).max(128),
});
 
// ==========================================
// 4. ДОПОМІЖНІ ФУНКЦІЇ
// ==========================================
function generateAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
    },
    JWT_SECRET,
    {
      expiresIn: ACCESS_TOKEN_EXPIRES,
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: crypto.randomUUID(),
    }
  );
}
 
function hashRnokpp(rnokpp) {
  return crypto.createHmac('sha256', IDENTITY_HASH_SECRET).update(String(rnokpp)).digest('hex');
}
 
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
 
// Cookie з токеном авторизації
function setAuthTokenCookie(res, token) {
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: IS_PROD || CROSS_SITE_COOKIES,
    sameSite: CROSS_SITE_COOKIES ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });
}
 
// Cookie зі state для захисту від CSRF під час входу через Дію.
// Callback — це верхньорівнева навігація (GET), тому 'lax' тут працює завжди.
const OAUTH_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: 'lax',
};
 
function publicUser(user, extra = {}) {
  return {
    id: user.id,
    email: user.email,
    lastName: user.lastName,
    firstName: user.firstName,
    middleName: user.middleName,
    role: user.role,
    ...extra,
  };
}
 
/**
 * GET-запит до ІСЕІ (id.gov.ua). Обидва ендпоінти (get-access-token, get-user-info)
 * викликаються методом GET з параметрами в query-рядку.
 * УВАГА: URL містить client_secret — не логуйте його.
 */
async function diiaGet(path, params) {
  const url = new URL(`${DIIA_BASE_URL}${path}`);
  url.search = new URLSearchParams(params).toString();
  return fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(DIIA_TIMEOUT_MS),
  });
}
 
/**
 * Приводить відповідь get-user-info до єдиного формату.
 * ІСЕІ повертає: drfocode, givenname, lastname, middlename, phone (+ email, якщо дозволено).
 * Інші варіанти назв лишені як запасні.
 */
function normalizeDiiaProfile(rawUserInfo) {
  const raw = (rawUserInfo && rawUserInfo.data) || rawUserInfo || {};
  return {
    rnokpp: raw.drfocode || raw.rnokpp || raw.drfo || null,
    lastName: raw.lastname || raw.lastName || null,
    firstName: raw.givenname || raw.firstname || raw.firstName || null,
    middleName: raw.middlename || raw.middleName || null,
    email: raw.email || null,
    _keys: Object.keys(raw), // лише для діагностики (імена полів, без значень)
  };
}
 
/**
 * Знаходить користувача за ідентичністю Дії або створює нового.
 * Автоматичного зв'язування з наявними акаунтами за email НЕМАЄ навмисно:
 * email з ІСЕІ не підтверджений нашою системою, і зв'язування за ним дозволило б
 * захопити чужий акаунт.
 */
async function findOrCreateUserByIdentity({ rnokpp, lastName, firstName, middleName, email }) {
  const providerUserId = hashRnokpp(rnokpp);
  const identityWhere = {
    provider_providerUserId: { provider: 'DIIA', providerUserId },
  };
 
  const existingIdentity = await prisma.identity.findUnique({
    where: identityWhere,
    include: { user: true },
  });
  if (existingIdentity) {
    return existingIdentity.user;
  }
 
  let cleanEmail = email && email.trim() !== '' ? email.trim().toLowerCase() : null;
 
  // Якщо email уже зайнятий іншим акаунтом — не створюємо дублікат (унікальний індекс дав би 500),
  // а просто залишаємо новому користувачу порожній email.
  if (cleanEmail) {
    const emailTaken = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (emailTaken) cleanEmail = null;
  }
 
  try {
    const user = await prisma.user.create({
      data: {
        email: cleanEmail,
        lastName: lastName || null,
        firstName: firstName || null,
        middleName: middleName || null,
        isVerified: true,
        isActive: true,
      },
    });
 
    await prisma.identity.create({
      data: {
        provider: 'DIIA',
        providerUserId,
        userId: user.id,
      },
    });
 
    return user;
  } catch (error) {
    // Гонка: два одночасних входи створили ту саму ідентичність — беремо вже створену.
    if (error && error.code === 'P2002') {
      const again = await prisma.identity.findUnique({
        where: identityWhere,
        include: { user: true },
      });
      if (again) return again.user;
    }
    throw error;
  }
}
 
// ==========================================
// 5. ЕНДПОІНТИ АВТОРИЗАЦІЇ ТА ДІЇ
// ==========================================
 
/**
 * 5.1. Початок входу через Дію: редірект на id.gov.ua
 * GET /api/auth/diia/login
 */
router.get('/diia/login', (req, res) => {
  if (!isDiiaConfigured()) {
    return res.status(503).json({ error: 'Вхід через Дію тимчасово недоступний' });
  }
 
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, {
    ...OAUTH_STATE_COOKIE_OPTIONS,
    maxAge: 10 * 60 * 1000,
  });
 
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: DIIA_CLIENT_ID,
    redirect_uri: DIIA_REDIRECT_URI,
    auth_type: 'diia_id,diia_oauth,bank_id,dig_sign',
    state,
  });
 
  return res.redirect(`${DIIA_BASE_URL}/?${params.toString()}`);
});
 
/**
 * 5.2. Повернення з id.gov.ua
 * GET /api/auth/diia/callback?code=...&state=...
 */
router.get('/diia/callback', authLimiter, async (req, res, next) => {
  try {
    if (!isDiiaConfigured()) {
      return res.status(503).json({ error: 'Вхід через Дію тимчасово недоступний' });
    }
 
    const { code, state } = idGovCallbackSchema.parse(req.query);
    const savedState = req.cookies && req.cookies.oauth_state;
 
    res.clearCookie('oauth_state', OAUTH_STATE_COOKIE_OPTIONS);
 
    if (!savedState || !safeEqual(savedState, state)) {
      return res.status(400).json({ error: 'Помилка безпеки: недійсний або застарілий CSRF state' });
    }
 
    // Крок 1: обмін code на access_token
    const tokenResponse = await diiaGet('/get-access-token', {
      grant_type: 'authorization_code',
      client_id: DIIA_CLIENT_ID,
      client_secret: DIIA_CLIENT_SECRET,
      code,
    });
 
    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text().catch(() => '');
      console.error('[Diia] get-access-token:', tokenResponse.status, errText.slice(0, 300));
      return res.status(400).json({ error: 'Помилка отримання токена від ІСЕІ' });
    }
 
    const tokenData = await tokenResponse.json();
 
    if (!tokenData.access_token || tokenData.user_id === undefined || tokenData.user_id === null) {
      console.error('[Diia] get-access-token: неповна відповідь, поля:', Object.keys(tokenData || {}));
      return res.status(400).json({ error: 'Некоректна відповідь id.gov.ua при отриманні токена' });
    }
 
    // Крок 2: отримання даних користувача
    const userInfoResponse = await diiaGet('/get-user-info', {
      access_token: tokenData.access_token,
      user_id: String(tokenData.user_id),
      fields: DIIA_USER_FIELDS,
    });
 
    if (!userInfoResponse.ok) {
      const errText = await userInfoResponse.text().catch(() => '');
      console.error('[Diia] get-user-info:', userInfoResponse.status, errText.slice(0, 300));
      return res.status(400).json({ error: 'Помилка отримання профілю від ІСЕІ' });
    }
 
    const profile = normalizeDiiaProfile(await userInfoResponse.json());
 
    // РНОКПП (drfocode) може бути не 10 цифр (наприклад, у людей без РНОКПП там паспортні дані),
    // тому перевіряємо лише, що значення є і воно розумної довжини.
    const rnokpp = profile.rnokpp ? String(profile.rnokpp).trim() : '';
    if (!rnokpp || rnokpp.length > 32) {
      console.error('[Diia] get-user-info: немає drfocode. Отримані поля:', profile._keys);
      return res.status(400).json({ error: 'Не вдалося отримати ідентифікатор користувача від ІСЕІ' });
    }
 
    const user = await findOrCreateUserByIdentity({
      rnokpp,
      lastName: profile.lastName,
      firstName: profile.firstName,
      middleName: profile.middleName,
      email: profile.email,
    });
 
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Обліковий запис заблоковано' });
    }
 
    const token = generateAccessToken(user);
    setAuthTokenCookie(res, token);
 
    return res.redirect(`${FRONTEND_URL}/auth/success`);
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      console.error('[Diia] Таймаут запиту до ІСЕІ');
      return res.status(504).json({ error: 'ІСЕІ не відповідає. Спробуйте пізніше.' });
    }
    next(error);
  }
});
 
/**
 * 5.3. ТЕСТОВИЙ вхід (імітація Дії). Лише для локальної розробки.
 * Вимкнений за замовчуванням: потрібно явно виставити ENABLE_DIIA_MOCK=true
 * І NODE_ENV не повинен бути production.
 */
router.post('/diia-login-dev-mock', authLimiter, async (req, res, next) => {
  if (IS_PROD || process.env.ENABLE_DIIA_MOCK !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
 
  try {
    const validatedData = mockDiiaSchema.parse(req.body);
 
    const user = await findOrCreateUserByIdentity({
      rnokpp: validatedData.rnokpp,
      lastName: validatedData.lastName,
      firstName: validatedData.firstName,
      middleName: validatedData.middleName,
      email: validatedData.email,
    });
 
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Обліковий запис заблоковано' });
    }
 
    const token = generateAccessToken(user);
    setAuthTokenCookie(res, token);
 
    return res.json({
      message: 'Успішний вхід через тестову Дію',
      token,
      user: publicUser(user, { isVerified: user.isVerified }),
    });
  } catch (error) {
    next(error);
  }
});
 
/**
 * 5.4. Реєстрація
 * POST /api/auth/register
 */
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const validated = registerSchema.parse(req.body);
 
    const existingUser = await prisma.user.findUnique({ where: { email: validated.email } });
    if (existingUser) {
      return res.status(409).json({ error: 'Користувач з таким Email вже існує' });
    }
 
    const hashedPassword = await bcrypt.hash(validated.password, SALT_ROUNDS);
 
    const newUser = await prisma.user.create({
      data: {
        email: validated.email,
        passwordHash: hashedPassword,
        lastName: validated.lastName,
        firstName: validated.firstName,
        middleName: validated.middleName || null,
        phone: validated.phone || null,
        isVerified: false,
        isActive: true,
      },
    });
 
    const token = generateAccessToken(newUser);
    setAuthTokenCookie(res, token);
 
    return res.status(201).json({
      message: 'Користувач успішно зареєстрований',
      token,
      user: publicUser(newUser),
    });
  } catch (error) {
    next(error);
  }
});
 
/**
 * 5.5. Вхід за email і паролем
 * POST /api/auth/login
 */
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const validated = loginSchema.parse(req.body);
 
    const user = await prisma.user.findUnique({ where: { email: validated.email } });
 
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }
 
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Обліковий запис заблоковано' });
    }
 
    const isPasswordValid = await bcrypt.compare(validated.password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }
 
    const token = generateAccessToken(user);
    setAuthTokenCookie(res, token);
 
    return res.json({
      message: 'Успішний вхід',
      token,
      user: publicUser(user),
    });
  } catch (error) {
    next(error);
  }
});
 
/**
 * 5.6. Вхід адміністратора
 * POST /api/auth/admin-login
 */
router.post('/admin-login', authLimiter, async (req, res, next) => {
  try {
    const { email, password, adminSecret } = adminLoginSchema.parse(req.body);
 
    if (!process.env.ADMIN_SECRET_KEY || !safeEqual(adminSecret, process.env.ADMIN_SECRET_KEY)) {
      return res.status(403).json({ error: 'Невірний секретний ключ адміністратора' });
    }
 
    const user = await prisma.user.findUnique({ where: { email } });
 
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }
 
    if (user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Доступ заборонено: Обліковий запис не має прав адміністратора' });
    }
 
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Обліковий запис заблоковано' });
    }
 
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }
 
    const token = generateAccessToken(user);
    setAuthTokenCookie(res, token);
 
    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
});
 
// =============================================================
// 6. ВІДНОВЛЕННЯ ПАРОЛЯ
// =============================================================
 
/**
 * 6.1. ЗАПИТ НА СКИДАННЯ ПАРОЛЯ
 * POST /api/auth/forgot-password
 */
router.post('/forgot-password', authLimiter, async (req, res, next) => {
  const genericResponse = {
    message: 'Якщо цей email зареєстровано, ми надіслали інструкції для відновлення.',
  };
 
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
 
    const user = await prisma.user.findUnique({ where: { email } });
 
    // Однакова відповідь незалежно від того, чи існує користувач (щоб не розкривати email-и)
    if (!user) {
      return res.json(genericResponse);
    }
 
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const tokenExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 хвилин
 
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: tokenExpires,
      },
    });
 
    const resetUrl = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
 
    try {
      await sendResetPasswordEmail(user.email, resetUrl);
    } catch (mailError) {
      // Не логуємо resetUrl/токен — лише факт помилки
      console.error('[Forgot Password] Помилка надсилання листа:', mailError && mailError.message);
    }
 
    return res.json(genericResponse);
  } catch (error) {
    next(error);
  }
});
 
/**
 * 6.2. ЗМІНА ПАРОЛЯ ЗА ТОКЕНОМ
 * POST /api/auth/reset-password
 */
router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const validated = resetPasswordSchema.parse(req.body);
 
    const hashedToken = crypto.createHash('sha256').update(validated.token).digest('hex');
 
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: {
          gt: new Date(),
        },
      },
    });
 
    if (!user) {
      return res.status(400).json({ error: 'Посилання для скидання пароля недійсне або його термін дії вичерпано' });
    }
 
    const passwordHash = await bcrypt.hash(validated.newPassword, SALT_ROUNDS);
 
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });
 
    return res.json({ message: 'Пароль успішно змінено! Тепер ви можете увійти з новим паролем.' });
  } catch (error) {
    next(error);
  }
});
 
module.exports = router;