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
// 1. ПЕРЕВІРКА КОНФІГУРАЦІЇ СЕРВЕРА
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET;
const IDENTITY_HASH_SECRET = process.env.IDENTITY_HASH_SECRET;
const DIIA_BASE_URL = process.env.DIIA_BASE_URL;

if (!JWT_SECRET || !IDENTITY_HASH_SECRET) {
  throw new Error('КРИТИЧНА ПОМИЛКА: JWT_SECRET або IDENTITY_HASH_SECRET не задані в .env!');
}

const ACCESS_TOKEN_EXPIRES = '1d';
const SALT_ROUNDS = 12;
const ISSUER = 'petitions-api';
const AUDIENCE = 'petitions-web';

// ==========================================
// 2. RATE LIMITING
// ==========================================
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
  return crypto.createHmac('sha256', IDENTITY_HASH_SECRET).update(rnokpp).digest('hex');
}

async function findOrCreateUserByIdentity({ rnokpp, lastName, firstName, middleName, email }) {
  const diiaHash = hashRnokpp(rnokpp);
  const cleanEmail = email && email.trim() !== '' ? email.trim().toLowerCase() : null;

  let identity = await prisma.identity.findUnique({
    where: {
      provider_providerUserId: {
        provider: 'DIIA',
        providerUserId: diiaHash,
      },
    },
    include: { user: true },
  });

  if (identity) {
    return identity.user;
  }

  let user = null;

  if (cleanEmail) {
    const existingUser = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existingUser && existingUser.isVerified) {
      user = existingUser;
    }
  }

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: cleanEmail,
        lastName: lastName || null,
        firstName: firstName || null,
        middleName: middleName || null,
        isVerified: true,
        isActive: true,
      },
    });
  }

  await prisma.identity.create({
    data: {
      provider: 'DIIA',
      providerUserId: diiaHash,
      userId: user.id,
    },
  });

  return user;
}

function setAuthTokenCookie(res, token) {
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });
}

// ==========================================
// 5. ЕНДПОІНТИ АВТОРИЗАЦІЇ ТА ДІЇ
// ==========================================

router.get('/diia/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  
  res.cookie('oauth_state', state, { 
    httpOnly: true, 
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.DIIA_CLIENT_ID || '',
    redirect_uri: process.env.DIIA_REDIRECT_URI || '',
    auth_type: 'diia_id,diia_oauth,bank_id,dig_sign',
    state: state,
  });

  return res.redirect(`${DIIA_BASE_URL}/?${params.toString()}`);
});

router.get('/diia/callback', authLimiter, async (req, res, next) => {
  try {
    const { code, state } = idGovCallbackSchema.parse(req.query);
    const savedState = req.cookies.oauth_state;

    res.clearCookie('oauth_state');

    if (!savedState || savedState !== state) {
      return res.status(400).json({ error: 'Помилка безпеки: недійсний або застарілий CSRF state' });
    }

    const tokenResponse = await fetch(`${DIIA_BASE_URL}/get-access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.DIIA_CLIENT_ID || '',
        client_secret: process.env.DIIA_CLIENT_SECRET || '',
        code: code,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      return res.status(400).json({ error: 'Помилка отримання токена від ІСЕІ', details: errText });
    }

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      return res.status(400).json({ error: 'Відсутній access_token у відповіді id.gov.ua' });
    }

    const userInfoResponse = await fetch(`${DIIA_BASE_URL}/get-user-info`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${tokenData.access_token}`
      },
      body: new URLSearchParams({
        access_token: tokenData.access_token,
        user_id: tokenData.user_id || '',
      }),
    });

    if (!userInfoResponse.ok) {
      return res.status(400).json({ error: 'Помилка отримання профілю від ІСЕІ' });
    }

    const rawUserInfo = await userInfoResponse.json();

    const decryptedUser = {
      rnokpp: rawUserInfo.rnokpp || rawUserInfo.drfocode || rawUserInfo.drfo,
      lastName: rawUserInfo.lastName || rawUserInfo.lastname,
      firstName: rawUserInfo.firstName || rawUserInfo.firstname,
      middleName: rawUserInfo.middleName || rawUserInfo.middlename,
      email: rawUserInfo.email,
    };

    if (!decryptedUser.rnokpp) {
      return res.status(400).json({ error: 'Не вдалося отримати РНОКПП від ІСЕІ' });
    }

    const user = await findOrCreateUserByIdentity(decryptedUser);

    if (user.isActive === false) {
      return res.status(403).json({ error: 'Обліковий запис заблоковано' });
    }

    const token = generateAccessToken(user);
    setAuthTokenCookie(res, token);

    const frontendUrl = process.env.FRONTEND_URL || 'https://petitions-frontend.vercel.app';
    return res.redirect(`${frontendUrl}/auth/success`);

  } catch (error) {
    next(error);
  }
});

router.post('/diia-login-dev-mock', authLimiter, async (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Пряма симуляція Дії заборонена в продакшн-режимі' });
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
      user: {
        id: user.id,
        email: user.email,
        lastName: user.lastName,
        firstName: user.firstName,
        middleName: user.middleName,
        isVerified: user.isVerified,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

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
      user: {
        id: newUser.id,
        email: newUser.email,
        lastName: newUser.lastName,
        firstName: newUser.firstName,
        middleName: newUser.middleName,
        role: newUser.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

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
      user: {
        id: user.id,
        email: user.email,
        lastName: user.lastName,
        firstName: user.firstName,
        middleName: user.middleName,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/admin-login', authLimiter, async (req, res, next) => {
  try {
    const { email, password, adminSecret } = req.body;

    if (!process.env.ADMIN_SECRET_KEY || adminSecret !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ error: 'Невірний секретний ключ адміністратора' });
    }

    const user = await prisma.user.findUnique({ 
      where: { email: email ? email.trim().toLowerCase() : '' } 
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    if (user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Доступ заборонено: Обліковий запис не має прав адміністратора' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    const token = generateAccessToken(user);
    setAuthTokenCookie(res, token);

    res.json({
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
  try {
    const validated = forgotPasswordSchema.parse(req.body);
    const normalizedEmail = validated.email.trim().toLowerCase();

    console.log("--> [Forgot Password] Спроба скидання для:", normalizedEmail);

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      console.log("--> [Forgot Password] Користувача не знайдено в БД");
      return res.json({ message: 'Якщо цей email зареєстровано, ми надіслали інструкції для відновлення.' });
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

    const clientUrl = process.env.CLIENT_URL || process.env.FRONTEND_URL || 'https://petitions-frontend.vercel.app';
    const resetUrl = `${clientUrl}/reset-password?token=${resetToken}`;

    console.log("--> [Forgot Password] Відправка листа на:", user.email, "з url:", resetUrl);

    try {
      await sendResetPasswordEmail(user.email, resetUrl);
      console.log("--> [Forgot Password] Лист успішно передано в SMTP!");
    } catch (mailError) {
      console.error("--> [Forgot Password Error] Помилка надсилання SMTP:", mailError);
    }

    return res.json({ message: 'Якщо цей email зареєстровано, ми надіслали інструкції для відновлення.' });
  } catch (error) {
    console.error("--> [Forgot Password Critical Error]:", error);
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
        passwordHash: passwordHash,
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