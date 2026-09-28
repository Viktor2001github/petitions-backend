const express = require('express');
const prisma = require('../lib/prisma.js');
const router = express.Router();
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');
const { sendEmailNotification } = require('../lib/mailer.js');

const formatFullName = (author) => {
  if (!author) return 'Анонім';
  const parts = [author.lastName, author.firstName, author.middleName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Невідомо';
};

const generateAccessToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET || 'secret_key',
    { expiresIn: '1d' }
  );
};

// POST /api/admin/admin-login
router.post('/admin-login', async (req, res, next) => {
  try {
    const { email, password, adminSecret } = req.body;

    if (!email || !password || !adminSecret) {
      return res.status(400).json({ error: 'Заповніть усі поля' });
    }

    if (adminSecret !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ error: 'Невірний секретний ключ адміністратора' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    let adminUser = user;
    if (user.role !== 'ADMIN') {
      adminUser = await prisma.user.update({
        where: { id: user.id },
        data: { role: 'ADMIN' },
      });
    }

    const token = generateAccessToken(adminUser);

    res.json({
      token,
      user: {
        id: adminUser.id,
        email: adminUser.email,
        role: adminUser.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Захист усіх ендпоінтів нижче
router.use(authMiddleware, adminMiddleware);

// 1. Отримати список петицій із пагінацією (30 шт/стор), пошуком та сортуванням
router.get('/petitions', async (req, res) => {
  try {
    const { status, search, page = 1, limit = 30, sortBy = 'createdAt_desc' } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const where = {};
    if (status) {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { id: isNaN(parseInt(search)) ? undefined : parseInt(search) }
      ].filter(Boolean);
    }

    let orderBy = { createdAt: 'desc' };
    if (sortBy === 'createdAt_asc') {
      orderBy = { createdAt: 'asc' };
    } else if (sortBy === 'votes_desc') {
      orderBy = { votes: { _count: 'desc' } };
    }

    const [totalCount, petitions] = await Promise.all([
      prisma.petition.count({ where }),
      prisma.petition.findMany({
        where,
        skip,
        take: limitNum,
        include: {
          author: {
            select: { id: true, firstName: true, lastName: true, middleName: true, email: true, phone: true }
          },
          _count: {
            select: { votes: true }
          }
        },
        orderBy,
      })
    ]);

    const formattedPetitions = petitions.map((p) => ({
      ...p,
      author: {
        ...p.author,
        fullName: formatFullName(p.author),
      },
    }));

    res.json({
      petitions: formattedPetitions,
      totalCount,
      totalPages: Math.ceil(totalCount / limitNum),
      currentPage: pageNum,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Помилка при отриманні петицій' });
  }
});

// 2. Модерація петиції (APPROVE / REJECT)
router.patch('/petitions/:id/moderate', async (req, res) => {
  try {
    const petitionId = parseInt(req.params.id);
    const { action } = req.body;

    let newStatus;
    if (action === 'APPROVE') {
      newStatus = 'ACTIVE';
    } else if (action === 'REJECT') {
      newStatus = 'REJECTED';
    } else {
      return res.status(400).json({ error: 'Некоректна дія' });
    }

    const updatedPetition = await prisma.petition.update({
      where: { id: petitionId },
      data: { status: newStatus }
    });

    res.json({ message: `Статус змінено на ${newStatus}`, petition: updatedPetition });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Помилка модерації' });
  }
});

// 3. Збереження офіційної відповіді та зміна статусу
router.post('/petitions/:id/response', async (req, res) => {
  try {
    const petitionId = parseInt(req.params.id);
    const { officialAnswer, status } = req.body;

    const dataToUpdate = {};
    if (officialAnswer) dataToUpdate.officialAnswer = officialAnswer;
    if (status) dataToUpdate.status = status;

    const updatedPetition = await prisma.petition.update({
      where: { id: petitionId },
      data: dataToUpdate
    });

    res.json({ message: 'Дані оновлено успішно', petition: updatedPetition });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Помилка збереження відповіді' });
  }
});

// 4. Видалення петиції
router.delete('/petitions/:id', async (req, res) => {
  try {
    const petitionId = parseInt(req.params.id);

    // Спочатку видаляємо пов'язані голоси або сповіщення
    await prisma.vote.deleteMany({ where: { petitionId } });
    await prisma.notificationQueue.deleteMany({ where: { petitionId } });

    await prisma.petition.delete({ where: { id: petitionId } });

    res.json({ message: 'Петицію видалено' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Помилка при видаленні петиції' });
  }
});

// 5. Експорт звіту Excel
router.get('/export/petitions', async (req, res) => {
  try {
    const petitions = await prisma.petition.findMany({
      include: {
        author: { select: { firstName: true, lastName: true, middleName: true, email: true } },
        _count: { select: { votes: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Петиції');

    worksheet.columns = [
      { header: 'ID', key: 'id', width: 10 },
      { header: 'Заголовок', key: 'title', width: 35 },
      { header: 'Категорія', key: 'category', width: 20 },
      { header: 'Автор', key: 'author', width: 25 },
      { header: 'Голоси', key: 'votes', width: 10 },
      { header: 'Статус', key: 'status', width: 15 },
      { header: 'Дата створення', key: 'createdAt', width: 20 },
    ];

    petitions.forEach((p) => {
      worksheet.addRow({
        id: p.id,
        title: p.title,
        category: p.category || 'Не вказано',
        author: formatFullName(p.author),
        votes: p._count.votes,
        status: p.status,
        createdAt: new Date(p.createdAt).toLocaleDateString('uk-UA'),
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=petitions_report.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Помилка генерації Excel:', error);
    res.status(500).json({ error: 'Помилка при експорті звіту' });
  }
});

// 6. Бан / Розбан користувача
router.patch('/users/:id/toggle-ban', async (req, res) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: 'Користувача не знайдено' });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { isActive: !user.isActive }
    });

    res.json({
      message: `Користувача ${updatedUser.isActive ? 'розблоковано' : 'заблоковано'}`,
      isActive: updatedUser.isActive
    });
  } catch (error) {
    console.error('Помилка при зміні бану:', error);
    res.status(500).json({ error: 'Помилка при зміні статусу користувача' });
  }
});

// 7. Створення розсилки для підписантів петиції
router.post('/petitions/:id/notify', async (req, res) => {
  try {
    const petitionId = parseInt(req.params.id);
    const { subject, body } = req.body;

    if (!subject || !body) {
      return res.status(400).json({ error: 'Тема та текст листа обов\'язкові' });
    }

    const votes = await prisma.vote.findMany({
      where: { petitionId },
      include: { user: { select: { email: true } } }
    });

    const queueItems = votes
      .filter(v => v.user && v.user.email)
      .map(v => ({
        petitionId,
        recipient: v.user.email,
        subject,
        body
      }));

    if (queueItems.length > 0) {
      await prisma.notificationQueue.createMany({ data: queueItems });
    }

    res.json({ message: `Додано в чергу ${queueItems.length} листів` });
  } catch (error) {
    console.error('Помилка створення розсилки:', error);
    res.status(500).json({ error: 'Помилка при формуванні сповіщень' });
  }
});

// 8. Обробка черги листів
router.post('/notifications/process', async (req, res) => {
  try {
    const pending = await prisma.notificationQueue.findMany({
      where: { status: 'PENDING' },
      take: 20
    });

    let successCount = 0;

    for (const item of pending) {
      try {
        await sendEmailNotification(item.recipient, item.subject, item.body);
        await prisma.notificationQueue.update({
          where: { id: item.id },
          data: { status: 'SENT' }
        });
        successCount++;
      } catch (err) {
        console.error(`Не вдалося надіслати лист на ${item.recipient}:`, err);
        await prisma.notificationQueue.update({
          where: { id: item.id },
          data: { status: 'FAILED' }
        });
      }
    }

    res.json({ message: 'Чергу опрацьовано', processed: successCount });
  } catch (error) {
    console.error('Помилка обробки черги:', error);
    res.status(500).json({ error: 'Помилка при відправці листів' });
  }
});

module.exports = router;