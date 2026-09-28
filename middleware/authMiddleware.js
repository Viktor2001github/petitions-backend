const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma'); // Імпортуємо синглтон Prisma

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not configured');
}

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Ви не зареєструвалися. Зареєструйтесь щоб створити петицію!' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'petitions-api',
      audience: 'petitions-web',
    });

    // Отримуємо користувача з БД за ID (decoded.sub)
    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        email: true,
        lastName: true,
        firstName: true,
        middleName: true,
        role: true,
        isActive: true,
        isVerified: true,
      },
    });

    if (!user || user.isActive === false) {
      return res.status(401).json({ error: 'Користувача не знайдено або акаунт заблоковано' });
    }

    req.user = user; // Записуємо очищений об'єкт користувача
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недійсний або прострочений токен' });
  }
};