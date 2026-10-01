const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Підключення моделей та мідлварів
const prisma = require('../lib/prisma');
const authMiddleware = require('../middleware/authMiddleware');
const { sendAdminNotification } = require('../lib/mailer');

const router = express.Router();

// ============================================================
// CLOUDINARY
// ============================================================

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ============================================================
// НАЛАШТУВАННЯ UPLOAD
// ============================================================

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'petitions',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],

    // Cloudinary автоматично оптимізує зображення
    transformation: [
      {
        width: 1600,
        height: 1200,
        crop: 'limit',
        quality: 'auto',
        fetch_format: 'auto',
      },
    ],
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024, // Максимально 5 MB
    files: 1,
  },

  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);

    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(
        new Error('Дозволені лише файли формату JPG, JPEG та WEBP')
      );
    }

    cb(null, true);
  },
});

// ============================================================
// КОНСТАНТИ
// ============================================================

// Термін збору підписів - 90 днів
const PETITION_TIMELIMIT_DAYS = 90;

// ============================================================
// RATE LIMIT
// ============================================================

// Захист від спаму голосування
const voteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Забагато спроб голосування. Спробуйте пізніше.',
  },
});

// Захист від масового створення петицій
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
// USER FIELDS
// ============================================================

const userSelectFields = {
  id: true,
  lastName: true,
  firstName: true,
  middleName: true,
};

// ============================================================
// VALIDATION
// ============================================================

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

  category: z
    .string()
    .trim()
    .max(100)
    .optional()
    .nullable(),

  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/, 'Некоректний поштовий індекс')
    .optional()
    .nullable(),

  settlement: z
    .string()
    .trim()
    .max(100)
    .optional()
    .nullable(),

  address: z
    .string()
    .trim()
    .max(255)
    .optional()
    .nullable(),
});

// ============================================================
// HELPERS
// ============================================================

function getUserId(req) {
  return req.user?.userId || req.user?.id || req.user?.sub || null;
}

function parseId(value) {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  return id;
}

function getPagination(req, defaultLimit = 10) {
  let page = parseInt(req.query.page, 10) || 1;
  let limit = parseInt(req.query.limit, 10) || defaultLimit;

  page = Math.max(1, page);
  limit = Math.min(50, Math.max(1, limit));

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

/**
 * Розраховує кількість днів,
 * що залишилися до кінця збору голосів.
 */
function calculateDaysLeft(
  createdAt,
  daysLimit = PETITION_TIMELIMIT_DAYS
) {
  const created = new Date(createdAt);

  const expiresAt = new Date(
    created.getTime() + daysLimit * 24 * 60 * 60 * 1000
  );

  const now = new Date();

  const diffTime = expiresAt - now;

  const diffDays = Math.ceil(
    diffTime / (1000 * 60 * 60 * 24)
  );

  return diffDays > 0 ? diffDays : 0;
}

/**
 * Форматує об'єкт петиції для відповіді frontend.
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

/**
 * Видаляє фотографію з Cloudinary.
 *
 * publicId передається без extension.
 *
 * Наприклад:
 * petitions/abc123xyz
 */
async function deleteCloudinaryImage(publicId) {
  if (!publicId) {
    return;
  }

  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image',
    });

    console.log(
      `Cloudinary image deleted: ${publicId}`
    );
  } catch (error) {
    console.error(
      'Помилка видалення файлу з Cloudinary:',
      error
    );
  }
}

// ============================================================
// 1. GET /recent-votes
// ============================================================

router.get('/recent-votes', async (req, res) => {
  try {
    const recentVotes = await prisma.vote.findMany({
      take: 10,

      orderBy: {
        createdAt: 'desc',
      },

      include: {
        user: {
          select: {
            lastName: true,
            firstName: true,
            middleName: true,
          },
        },

        petition: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    const activities = recentVotes.map((vote) => {
      const userAnonim = vote.user;

      const formattedName = userAnonim
        ? `${userAnonim.lastName || ''} ${userAnonim.firstName || ''}`
            .trim() || 'Анонімний користувач'
        : 'Анонімний користувач';

      return {
        id: vote.id,
        userName: formattedName,
        petitionTitle:
          vote.petition?.title || 'Петицію видалено',
        petitionId: vote.petitionId,
        createdAt: vote.createdAt,
      };
    });

    return res.json(activities);
  } catch (error) {
    console.error(
      'Помилка при отриманні останніх дій:',
      error
    );

    return res.status(500).json({
      error: 'Не вдалося завантажити останні дії',
    });
  }
});

// ============================================================
// 2. GET /
// Отримання списку всіх петицій
// ============================================================

router.get('/', async (req, res) => {
  try {
    const {
      tab,
      category,
      search,
    } = req.query;

    const {
      page,
      limit,
      skip,
    } = getPagination(req);

    const where = {};

    // Фільтрація за категорією
    if (
      typeof category === 'string' &&
      category &&
      category !== 'Усі категорії'
    ) {
      where.category = category;
    }

    // Пошук
    if (
      typeof search === 'string' &&
      search.trim()
    ) {
      const searchText = search
        .trim()
        .slice(0, 100);

      where.OR = [
        {
          title: {
            contains: searchText,
            mode: 'insensitive',
          },
        },
        {
          description: {
            contains: searchText,
            mode: 'insensitive',
          },
        },
      ];
    }

    let orderBy = {
      createdAt: 'desc',
    };

    // Нові петиції
    if (tab === 'NEW') {
      const sixtyDaysAgo = new Date();

      sixtyDaysAgo.setDate(
        sixtyDaysAgo.getDate() - 60
      );

      where.createdAt = {
        gte: sixtyDaysAgo,
      };

      orderBy = {
        createdAt: 'desc',
      };
    }

    // Популярні
    if (tab === 'POPULAR') {
      orderBy = {
        votes: {
          _count: 'desc',
        },
      };
    }

    // Підтримані
    if (tab === 'SUPPORTED') {
      where.status = 'APPROVED';

      orderBy = {
        createdAt: 'desc',
      };
    }

    const [
      petitions,
      total,
    ] = await Promise.all([
      prisma.petition.findMany({
        where,

        include: {
          author: {
            select: userSelectFields,
          },

          _count: {
            select: {
              votes: true,
            },
          },
        },

        orderBy,
        skip,
        take: limit,
      }),

      prisma.petition.count({
        where,
      }),
    ]);

    const formattedPetitions =
      petitions.map(formatPetitionWithTimer);

    return res.json({
      data: formattedPetitions,

      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(
          total / limit
        ),
      },
    });
  } catch (error) {
    console.error(
      'Помилка отримання петицій:',
      error
    );

    return res.status(500).json({
      error: 'Помилка при отриманні петицій',
    });
  }
});

// ============================================================
// 3. GET /:id
// Отримання конкретної петиції
// ============================================================

router.get('/:id', async (req, res) => {
  try {
    const petitionId = parseId(
      req.params.id
    );

    if (!petitionId) {
      return res.status(400).json({
        error: 'Некоректний ID петиції',
      });
    }

    const petition =
      await prisma.petition.findUnique({
        where: {
          id: petitionId,
        },

        include: {
          author: {
            select: userSelectFields,
          },

          _count: {
            select: {
              votes: true,
            },
          },
        },
      });

    if (!petition) {
      return res.status(404).json({
        error: 'Петицію не знайдено',
      });
    }

    return res.json(
      formatPetitionWithTimer(petition)
    );
  } catch (error) {
    console.error(
      'Помилка отримання петиції:',
      error
    );

    return res.status(500).json({
      error: 'Помилка при отриманні петиції',
    });
  }
});

// ============================================================
// 4. GET /:id/votes
// Отримання списку підписів
// ============================================================

router.get('/:id/votes', async (req, res) => {
  try {
    const petitionId = parseId(
      req.params.id
    );

    if (!petitionId) {
      return res.status(400).json({
        error: 'Некоректний ID петиції',
      });
    }

    const {
      page,
      limit,
      skip,
    } = getPagination(req, 20);

    const petition =
      await prisma.petition.findUnique({
        where: {
          id: petitionId,
        },

        select: {
          id: true,
        },
      });

    if (!petition) {
      return res.status(404).json({
        error: 'Петицію не знайдено',
      });
    }

    const [
      votes,
      total,
    ] = await Promise.all([
      prisma.vote.findMany({
        where: {
          petitionId,
        },

        include: {
          user: {
            select: userSelectFields,
          },
        },

        orderBy: {
          createdAt: 'desc',
        },

        skip,
        take: limit,
      }),

      prisma.vote.count({
        where: {
          petitionId,
        },
      }),
    ]);

    return res.json({
      data: votes,

      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(
          total / limit
        ),
      },
    });
  } catch (error) {
    console.error(
      'Помилка отримання голосів:',
      error
    );

    return res.status(500).json({
      error: 'Помилка при отриманні голосів',
    });
  }
});

// ============================================================
// 5. POST /
// Створення нової петиції
// ============================================================

router.post(
  '/',
  authMiddleware,
  createPetitionLimiter,

  // ----------------------------------------------------------
  // UPLOAD IMAGE TO CLOUDINARY
  // ----------------------------------------------------------

  (req, res, next) => {
    upload.single('image')(
      req,
      res,
      (error) => {
        if (error instanceof multer.MulterError) {
          if (
            error.code === 'LIMIT_FILE_SIZE'
          ) {
            return res.status(413).json({
              error:
                'Файл занадто великий. Максимальний розмір 5 МБ.',
            });
          }

          return res.status(400).json({
            error:
              'Помилка завантаження файлу',
          });
        }

        if (error) {
          console.error(
            'Cloudinary/Multer upload error:',
            error
          );

          return res.status(400).json({
            error: error.message,
          });
        }

        next();
      }
    );
  },

  // ----------------------------------------------------------
  // CREATE PETITION
  // ----------------------------------------------------------

  async (req, res) => {
    let uploadedPublicId = null;

    try {
      // ------------------------------------------------------
      // USER
      // ------------------------------------------------------

      const authorId = getUserId(req);

      if (!authorId) {
        return res.status(401).json({
          error:
            'Необхідна авторизація для створення петиції',
        });
      }
      console.log('=== [DEBUG CREATE PETITION] ===');
    console.log('req.file:', req.file); 
    console.log('req.body:', req.body);

      // ------------------------------------------------------
      // VALIDATION
      // ------------------------------------------------------

      const validation =
        petitionSchema.safeParse(
          req.body
        );

      if (!validation.success) {
        console.warn('⚠️ Помилка валідації Zod:', validation.error.flatten());
        // Якщо Cloudinary вже завантажив файл,
        // видаляємо його, бо петиція не пройшла validation.
        if (req.file?.filename) {
          await deleteCloudinaryImage(
            req.file.filename
          );
        }

        return res.status(400).json({
          error:
            'Некоректні дані петиції',

          details:
            validation.error.flatten(),
        });
      }

      const data = validation.data;

      // ------------------------------------------------------
      // IMAGE
      // ------------------------------------------------------

      let imageUrl = null;

      if (req.file) {
        /*
         * multer-storage-cloudinary повертає:
         *
         * req.file.path
         *   -> URL зображення Cloudinary
         *
         * req.file.filename
         *   -> public_id Cloudinary
         */

        imageUrl = req.file.path;
        uploadedPublicId =
          req.file.filename;
      }
      // 🔴 2. ДОДАНО ЛОГУВАННЯ ЗБЕРЕЖЕННЯ URL
    console.log('📸 Підготовлений imageUrl для БД:', imageUrl);
    console.log('🆔 Cloudinary Public ID:', uploadedPublicId);

      // ------------------------------------------------------
      // CREATE PETITION IN DATABASE
      // ------------------------------------------------------

      const petition =
        await prisma.petition.create({
          data: {
            title: data.title,

            description:
              data.description,

            category:
              data.category || null,

            postalCode:
              data.postalCode || null,

            settlement:
              data.settlement || null,

            address:
              data.address || null,

            imageUrl,

            status: 'ACTIVE',

            authorId,
          },

          include: {
            author: {
              select: userSelectFields,
            },

            _count: {
              select: {
                votes: true,
              },
            },
          },
        });
        console.log('✅ Петицію успішно створено з ID:', petition.id);
      // Файл успішно прив'язаний до петиції.
      uploadedPublicId = null;

      return res.status(201).json(
        formatPetitionWithTimer(
          petition
        )
      );
    } catch (error) {
      // ------------------------------------------------------
      // CLEANUP CLOUDINARY
      // ------------------------------------------------------

      if (uploadedPublicId) {
        await deleteCloudinaryImage(
          uploadedPublicId
        );
      }

      console.error(
        'Помилка створення петиції:',
        error
      );

      return res.status(500).json({
        error:
          'Помилка при створенні петиції',
      });
    }
  }
);

// ============================================================
// 6. POST /:id/vote
// Голосування
// ============================================================

router.post(
  '/:id/vote',
  authMiddleware,
  voteLimiter,

  async (req, res) => {
    try {
      const petitionId = parseId(
        req.params.id
      );

      if (!petitionId) {
        return res.status(400).json({
          error:
            'Некоректний ID петиції',
        });
      }

      const userId = getUserId(req);

      if (!userId) {
        return res.status(401).json({
          error:
            'Необхідно авторизуватися',
        });
      }

      // ------------------------------------------------------
      // FIND PETITION
      // ------------------------------------------------------

      const petition =
        await prisma.petition.findUnique({
          where: {
            id: petitionId,
          },

          select: {
            id: true,
            status: true,
            createdAt: true,
          },
        });

      if (!petition) {
        return res.status(404).json({
          error:
            'Петицію не знайдено',
        });
      }

      // ------------------------------------------------------
      // CHECK STATUS
      // ------------------------------------------------------

      if (
        petition.status === 'APPROVED' ||
        petition.status === 'REJECTED'
      ) {
        return res.status(400).json({
          error:
            'Голосування за цю петицію завершено',
        });
      }

      // ------------------------------------------------------
      // CHECK 90 DAYS
      // ------------------------------------------------------

      const daysLeft =
        calculateDaysLeft(
          petition.createdAt
        );

      if (daysLeft <= 0) {
        return res.status(400).json({
          error:
            'Термін збору підписів (90 днів) вичерпано',
        });
      }

      // ------------------------------------------------------
      // CREATE VOTE
      // ------------------------------------------------------

      try {
        await prisma.vote.create({
          data: {
            userId,
            petitionId,
          },
        });
      } catch (error) {
        if (error.code === 'P2002') {
          return res.status(409).json({
            message:
              'Ви вже підписали цю петицію',
          });
        }

        throw error;
      }

      // ------------------------------------------------------
      // COUNT VOTES
      // ------------------------------------------------------

      const totalVotes =
        await prisma.vote.count({
          where: {
            petitionId,
          },
        });

      // ------------------------------------------------------
      // UPDATE STATUS
      // ------------------------------------------------------

      let currentStatus =
        petition.status;

      if (
        totalVotes >= 500 &&
        petition.status !== 'REVIEW'
      ) {
        const result =
          await prisma.petition.updateMany({
            where: {
              id: petitionId,

              status: {
                not: 'REVIEW',
              },
            },

            data: {
              status: 'REVIEW',
            },
          });

        currentStatus = 'REVIEW';

        // ----------------------------------------------------
        // SEND ADMIN NOTIFICATION
        // ----------------------------------------------------

        if (result.count === 1) {
          const updatedPetition =
            await prisma.petition.findUnique(
              {
                where: {
                  id: petitionId,
                },
              }
            );

          if (updatedPetition) {
            sendAdminNotification(
              updatedPetition
            ).catch((err) => {
              console.error(
                'Помилка надсилання email адміну:',
                err
              );
            });
          }
        }
      }

      return res.json({
        message:
          'Ваш голос успішно враховано!',

        totalVotes,

        status: currentStatus,

        daysLeft,
      });
    } catch (error) {
      console.error(
        'Помилка при голосуванні:',
        error
      );

      return res.status(500).json({
        error:
          'Помилка сервера під час голосування',
      });
    }
  }
);

// ============================================================
// EXPORT
// ============================================================

module.exports = router;