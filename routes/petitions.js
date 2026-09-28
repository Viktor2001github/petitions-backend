const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

// Підключення моделей та мідлварів
const prisma = require('../lib/prisma');
const authMiddleware = require('../middleware/authMiddleware');
const { sendAdminNotification } = require('../lib/mailer');

const router = express.Router();

// Константа терміну збору підписів (90 днів за Положенням)
const PETITION_TIMELIMIT_DAYS = 90;
// -------------------------------------------------------------
// Отримання останніх 10 дій (підписів петицій)
// -------------------------------------------------------------
router.get('/recent-votes', async (req, res) => {
  try {
    const recentVotes = await prisma.vote.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { 
          select: { 
            lastName: true, 
            firstName: true, 
            middleName: true 
          } 
        },
        petition: { 
          select: { id: true, title: true } 
        },
      },
    });

    // Форматуємо відповідь під інтерфейс Activity на фронтенді
    const activities = recentVotes.map((vote) => {
      const userAnonim = vote.user;
      const formattedName = userAnonim
        ? `${userAnonim.lastName || ''} ${userAnonim.firstName || ''}`.trim() || 'Анонімний користувач'
        : 'Анонімний користувач';

      return {
        id: vote.id,
        userName: formattedName,
        petitionTitle: vote.petition?.title || 'Петицію видалено',
        petitionId: vote.petitionId,
        createdAt: vote.createdAt,
      };
    });

    return res.json(activities);
  } catch (error) {
    console.error('Помилка при отриманні останніх дій:', error);
    return res.status(500).json({ error: 'Не вдалося завантажити останні дії' });
  }
});
// ============================================================
// НАЛАШТУВАННЯ UPLOAD (Завантаження файлів)
// ============================================================

const uploadDir = path.join(__dirname, '../uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const allowedExtensions = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const randomName = crypto.randomBytes(24).toString('hex');
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomName}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // Максимально 5 MB
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (
      !allowedMimeTypes.has(file.mimetype) ||
      !allowedExtensions.has(ext)
    ) {
      return cb(new Error('Дозволені лише файли формату JPG, JPEG та WEBP'));
    }

    cb(null, true);
  },
});

// ============================================================
// RATE LIMIT (Захист від спаму)
// ============================================================

const voteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Забагато спроб голосування. Спробуйте пізніше.',
  },
});

const createPetitionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Забагато створених петицій. Спробуйте пізніше.',
  },
});

// ============================================================
// USER FIELDS & VALIDATION
// ============================================================

const userSelectFields = {
  id: true,
  lastName: true,
  firstName: true,
  middleName: true,
};

const petitionSchema = z.object({
  title: z
    .string()
    .trim()
    .min(5, 'Назва повинна містити щонайменше 5 символів')
    .max(200, 'Назва не може перевищувати 200 символів'),

  description: z
    .string()
    .trim()
    .min(20, 'Опис повинен містити щонайменше 20 символів')
    .max(10000, 'Опис не може перевищувати 10000 символів'),

  category: z.string().trim().max(100).optional().nullable(),
  postalCode: z.string().trim().regex(/^\d{5}$/, 'Некоректний поштовий індекс').optional().nullable(),
  settlement: z.string().trim().max(100).optional().nullable(),
  address: z.string().trim().max(255).optional().nullable(),
});

// ============================================================
// HELPERS (Допоміжні функції та Таймер)
// ============================================================

function getUserId(req) {
  return req.user?.userId || req.user?.id || req.user?.sub || null;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function getPagination(req, defaultLimit = 10) {
  let page = parseInt(req.query.page, 10) || 1;
  let limit = parseInt(req.query.limit, 10) || defaultLimit;

  page = Math.max(1, page);
  limit = Math.min(50, Math.max(1, limit));

  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Розраховує кількість днів, що залишилися до кінця збору голосів (90 днів від створення)
 */
function calculateDaysLeft(createdAt, daysLimit = PETITION_TIMELIMIT_DAYS) {
  const created = new Date(createdAt);
  const expiresAt = new Date(created.getTime() + daysLimit * 24 * 60 * 60 * 1000);
  const now = new Date();

  const diffTime = expiresAt - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return diffDays > 0 ? diffDays : 0;
}

/**
 * Форматує об'єкт петиції для відповіді фронтенду, додаючи поля таймера
 */
function formatPetitionWithTimer(petition) {
  const daysLeft = calculateDaysLeft(petition.createdAt);
  const isExpired = daysLeft === 0;

  return {
    ...petition,
    daysLeft,
    isExpired,
  };
}

// ============================================================
// 1. GET /
// Отримання списку всіх петицій з розрахованим таймером
// ============================================================

router.get('/', async (req, res) => {
  try {
    const { tab, category, search } = req.query;
    const { page, limit, skip } = getPagination(req);

    const where = {};

    // Фільтрація за категорією
    if (typeof category === 'string' && category && category !== 'Усі категорії') {
      where.category = category;
    }

    // Пошук за ключовими словами
    if (typeof search === 'string' && search.trim()) {
      const searchText = search.trim().slice(0, 100);
      where.OR = [
        { title: { contains: searchText, mode: 'insensitive' } },
        { description: { contains: searchText, mode: 'insensitive' } },
      ];
    }

    let orderBy = { createdAt: 'desc' };

    // Нові петиції (опубліковані не пізніше 60 днів тому)
    if (tab === 'NEW') {
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      where.createdAt = { gte: sixtyDaysAgo };
      orderBy = { createdAt: 'desc' };
    }

    // Популярні (за кількістю підписів)
    if (tab === 'POPULAR') {
      orderBy = { votes: { _count: 'desc' } };
    }

    // Підтримані петиції
    if (tab === 'SUPPORTED') {
      where.status = 'APPROVED';
      orderBy = { createdAt: 'desc' };
    }

    const [petitions, total] = await Promise.all([
      prisma.petition.findMany({
        where,
        include: {
          author: { select: userSelectFields },
          _count: { select: { votes: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.petition.count({ where }),
    ]);

    // Збагачення списку петицій даними таймера 90 днів
    const formattedPetitions = petitions.map(formatPetitionWithTimer);

    return res.json({
      data: formattedPetitions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Помилка отримання петицій:', error);
    return res.status(500).json({ error: 'Помилка при отриманні петицій' });
  }
});

// ============================================================
// 2. GET /:id
// Отримання конкретної петиції за ID з таймером
// ============================================================

router.get('/:id', async (req, res) => {
  try {
    const petitionId = parseId(req.params.id);

    if (!petitionId) {
      return res.status(400).json({ error: 'Некоректний ID петиції' });
    }

    const petition = await prisma.petition.findUnique({
      where: { id: petitionId },
      include: {
        author: { select: userSelectFields },
        _count: { select: { votes: true } },
      },
    });

    if (!petition) {
      return res.status(404).json({ error: 'Петицію не знайдено' });
    }

    return res.json(formatPetitionWithTimer(petition));
  } catch (error) {
    console.error('Помилка отримання петиції:', error);
    return res.status(500).json({ error: 'Помилка при отриманні петиції' });
  }
});

// ============================================================
// 3. GET /:id/votes
// Отримання списку підписів під петицією
// ============================================================

router.get('/:id/votes', async (req, res) => {
  try {
    const petitionId = parseId(req.params.id);

    if (!petitionId) {
      return res.status(400).json({ error: 'Некоректний ID петиції' });
    }

    const { page, limit, skip } = getPagination(req, 20);

    const petition = await prisma.petition.findUnique({
      where: { id: petitionId },
      select: { id: true },
    });

    if (!petition) {
      return res.status(404).json({ error: 'Петицію не знайдено' });
    }

    const [votes, total] = await Promise.all([
      prisma.vote.findMany({
        where: { petitionId },
        include: {
          user: { select: userSelectFields },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.vote.count({ where: { petitionId } }),
    ]);

    return res.json({
      data: votes,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Помилка отримання голосів:', error);
    return res.status(500).json({ error: 'Помилка при отриманні голосів' });
  }
});

// ============================================================
// 4. POST /
// Створення нової петиції (з дефолтним статусом ACTIVE)
// ============================================================

router.post(
  '/',
  authMiddleware,
  createPetitionLimiter,
  (req, res, next) => {
    upload.single('image')(req, res, (error) => {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Файл занадто великий. Максимальний розмір 5 МБ.' });
        }
        return res.status(400).json({ error: 'Помилка завантаження файлу' });
      }

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      next();
    });
  },
  async (req, res) => {
    let uploadedFile = null;

    try {
      const authorId = getUserId(req);

      if (!authorId) {
        return res.status(401).json({ error: 'Необхідна авторизація для створення петиції' });
      }

      const validation = petitionSchema.safeParse(req.body);

      if (!validation.success) {
        if (req.file) {
          fs.unlink(req.file.path, () => {});
        }

        return res.status(400).json({
          error: 'Некоректні дані петиції',
          details: validation.error.flatten(),
        });
      }

      const data = validation.data;

      if (req.file) {
        uploadedFile = req.file.path;
      }

      const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

      const petition = await prisma.petition.create({
        data: {
          title: data.title,
          description: data.description,
          category: data.category || null,
          postalCode: data.postalCode || null,
          settlement: data.settlement || null,
          address: data.address || null,
          imageUrl,
          status: 'ACTIVE', // Статус активного збору після створення
          authorId,
        },
        include: {
          author: { select: userSelectFields },
          _count: { select: { votes: true } },
        },
      });

      return res.status(201).json(formatPetitionWithTimer(petition));
    } catch (error) {
      if (uploadedFile) {
        fs.unlink(uploadedFile, () => {});
      }

      console.error('Помилка створення петиції:', error);
      return res.status(500).json({ error: 'Помилка при створенні петиції' });
    }
  }
);

// ============================================================
// 5. POST /:id/vote
// Голосування (перевірка терміну 90 днів та порогу 500 голосів)
// ============================================================

router.post(
  '/:id/vote',
  authMiddleware,
  voteLimiter,
  async (req, res) => {
    try {
      const petitionId = parseId(req.params.id);

      if (!petitionId) {
        return res.status(400).json({ error: 'Некоректний ID петиції' });
      }

      const userId = getUserId(req);

      if (!userId) {
        return res.status(401).json({ error: 'Необхідно авторизуватися' });
      }

      const petition = await prisma.petition.findUnique({
        where: { id: petitionId },
        select: {
          id: true,
          status: true,
          createdAt: true,
        },
      });

      if (!petition) {
        return res.status(404).json({ error: 'Петицію не знайдено' });
      }

      // Перевірка 1: Чи не закрита петиція за статусом
      if (petition.status === 'APPROVED' || petition.status === 'REJECTED') {
        return res.status(400).json({ error: 'Голосування за цю петицію завершено' });
      }

      // Перевірка 2: Перевірка терміну 90 днів
      const daysLeft = calculateDaysLeft(petition.createdAt);

      if (daysLeft <= 0) {
        return res.status(400).json({ error: 'Термін збору підписів (90 днів) вичерпано' });
      }

      // Додавання голосу
      try {
        await prisma.vote.create({
          data: {
            userId,
            petitionId,
          },
        });
      } catch (error) {
        if (error.code === 'P2002') {
          return res.status(409).json({ message: 'Ви вже підписали цю петицію' });
        }
        throw error;
      }

      // Підрахунок голосів після підписання
      const totalVotes = await prisma.vote.count({
        where: { petitionId },
      });

      let currentStatus = petition.status;

      // При досягненні 500 голосів — зміна статусу на REVIEW та сповіщення адміна
      if (totalVotes >= 500 && petition.status !== 'REVIEW') {
        const result = await prisma.petition.updateMany({
          where: {
            id: petitionId,
            status: { not: 'REVIEW' },
          },
          data: { status: 'REVIEW' },
        });

        currentStatus = 'REVIEW';

        if (result.count === 1) {
          const updatedPetition = await prisma.petition.findUnique({
            where: { id: petitionId },
          });

          if (updatedPetition) {
            sendAdminNotification(updatedPetition).catch((err) => {
              console.error('Помилка надсилання email адміну:', err);
            });
          }
        }
      }

      return res.json({
        message: 'Ваш голос успішно враховано!',
        totalVotes,
        status: currentStatus,
        daysLeft,
      });
    } catch (error) {
      console.error('Помилка при голосуванні:', error);
      return res.status(500).json({ error: 'Помилка сервера під час голосування' });
    }
  }
);

module.exports = router;