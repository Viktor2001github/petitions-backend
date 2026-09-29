const nodemailer = require('nodemailer');

// Використовуємо стандартний сервіс Gmail замість жорстко прописаного IP
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // Пароль додатку Google (App Password)
  },
});

// Продакшн URL вашого фронтенду на Vercel
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://petitions-frontend.vercel.app';

// 1. Сповіщення адміна про петицію на розгляді
async function sendAdminNotification(petition) {
  const mailOptions = {
    from: `"Е-Петиції" <${process.env.EMAIL_USER}>`,
    to: 'vvs2001.viktor@gmail.com',
    subject: `Петиція №${petition.id} набрала необхідну кількість голосів!`,
    html: `
      <h2>Петиція потребує розгляду</h2>
      <p><strong>Назва:</strong> ${petition.title}</p>
      <p><strong>Категорія:</strong> ${petition.category || 'Не вказано'}</p>
      <p>Петиція зібрала необхідну кількість підписів і перейшла в статус <strong>REVIEW</strong>.</p>
      <hr />
      <p><a href="${FRONTEND_URL}" style="background: #19436e; color: #fff; padding: 10px 15px; text-decoration: none; border-radius: 5px; display: inline-block;">Перейти до петицій</a></p>
    `,
  };

  return await transporter.sendMail(mailOptions);
}

// 2. Сповіщення громадян з черги (для довільної розсилки будь-кому)
async function sendEmailNotification(to, subject, text) {
  const mailOptions = {
    from: `"Е-Петиції" <${process.env.EMAIL_USER}>`,
    to, // Тут приймається будь-який email зареєстрованого користувача
    subject,
    text,
  };

  return await transporter.sendMail(mailOptions);
}

// 3. Функція для зміни пароля
async function sendResetPasswordEmail(to, resetUrl) {
  const mailOptions = {
    from: `"Е-Петиції" <${process.env.EMAIL_USER}>`,
    to: to, // Працює для будь-якого користувача
    subject: 'Відновлення пароля | Е-Петиції',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #19436e;">Відновлення пароля</h2>
        <p>Ви отримали цей лист, тому що ми отримали запит на скидання пароля для вашого акаунту.</p>
        <p>Для того, щоб задати новий пароль, натисніть на кнопку нижче:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #19436e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
            Змінити пароль
          </a>
        </div>
        <p style="color: #666; font-size: 14px;">Посилання дійсна протягом <strong>30 хвилин</strong>.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="color: #999; font-size: 12px;">Якщо ви не надсилали цей запит, просто проігноруйте цей лист.</p>
      </div>
    `,
  };

  return await transporter.sendMail(mailOptions);
}

module.exports = { 
  sendAdminNotification, 
  sendEmailNotification,
  sendResetPasswordEmail
};