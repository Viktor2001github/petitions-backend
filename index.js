const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const petitionRoutes = require('./routes/petitions');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

// Створення папки uploads, якщо її ще немає
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 1. Захист HTTP-заголовків
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// 2. CORS
app.use(cors());

// 3. Rate Limiter (Захист від ботів та DDoS)
const isDev = process.env.NODE_ENV === 'development';

// Глобальний лімітер для звичайного API (читання петицій, пошук тощо)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 хвилин
  max: isDev ? 10000 : 500,  // Під час розробки — безліміт, на продакшені — 500 запитів
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато запитів з цього IP, спробуйте пізніше' }
});

// Суворий лімітер для авторизації (брутфорс паролів)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 хвилин
  max: isDev ? 1000 : 10,     // Під час розробки лояльно, на продакшені — 10 спроб
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб входу. Спробуйте через 15 хвилин.' }
});

// Застосовуємо authLimiter ТІЛЬКИ до маршрутів авторизації
app.use('/api/auth/', authLimiter);

// Застосовуємо загальний лімітер до інших API маршрутів
app.use('/api/', globalLimiter);

// 4. Парсер JSON
app.use(express.json({ limit: '10mb' }));

// 5. Роздача статичних файлів через абсолютний шлях (для фото петицій)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 6. Підключення роутів
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/petitions', petitionRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend працює успішно!' });
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущено на http://localhost:${PORT}`);
});

